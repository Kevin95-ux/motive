"use strict";

const crypto = require("node:crypto");
const { getConfig } = require("./_lib/config");
const { STATES } = require("./_lib/states");
const { logTransition } = require("./_lib/logger");
const {
  PipelineError,
  cleanIpv4,
  loadZipAllowlist,
  normalizeLead,
  validateLead
} = require("./_lib/validate");
const { verifyTrustedForm } = require("./_lib/trustedform");
const { deliverSio } = require("./_lib/sio");
const { deliverGhl } = require("./_lib/ghl");
const { createStore } = require("./_lib/store");
const { IdempotencyService } = require("./_lib/idempotency");

const MAX_BODY_BYTES = 64 * 1024;

function getHeader(req, name) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  return cleanIpv4([
    getHeader(req, "x-vercel-forwarded-for"),
    getHeader(req, "x-real-ip"),
    getHeader(req, "cf-connecting-ip"),
    getHeader(req, "x-forwarded-for"),
    req.socket?.remoteAddress
  ]);
}

function originAllowed(req, allowedOrigins) {
  const origin = String(getHeader(req, "origin") || "").replace(/\/$/, "");
  if (!origin) return true;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    const requestHost = getHeader(req, "x-forwarded-host") || getHeader(req, "host");
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  const declaredLength = Number(getHeader(req, "content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new PipelineError(413, "payload_too_large", "The lead payload is too large.", STATES.INVALID);
  }
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) {
      throw new PipelineError(413, "payload_too_large", "The lead payload is too large.", STATES.INVALID);
    }
    try { return JSON.parse(req.body); } catch {
      throw new PipelineError(400, "invalid_json", "The request body must be valid JSON.", STATES.INVALID);
    }
  }
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new PipelineError(413, "payload_too_large", "The lead payload is too large.", STATES.INVALID);
    }
  }
  try { return JSON.parse(body); } catch {
    throw new PipelineError(400, "invalid_json", "The request body must be valid JSON.", STATES.INVALID);
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(payload));
}

function evidenceFor(lead, transitions, delivery = {}) {
  return {
    lead_id: lead.lead_id,
    trustedform_cert: lead.cert,
    timestamp: lead.captured_at,
    ip: lead.ip,
    user_agent: lead.user_agent,
    page_url: lead.page_url,
    referring_url: lead.referring_url,
    form_version: lead.form_version,
    checkbox_state: lead.consent_checkbox_checked,
    honeypot_value: lead.company_website,
    selected_recipient: lead.selected_recipient,
    routing: {
      page: lead.page,
      destination: "Standard Information",
      source_id: lead.subID1 || "Motiv"
    },
    delivery,
    transitions
  };
}

function createHandler(dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const logger = dependencies.logger || console;

  return async function handler(req, res) {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return sendJson(res, 405, {
        success: false,
        code: "method_not_allowed",
        message: "Use POST for lead submissions."
      });
    }

    const config = dependencies.config || getConfig(env);
    if (!originAllowed(req, config.allowedOrigins)) {
      return sendJson(res, 403, {
        success: false,
        code: "origin_not_allowed",
        message: "This origin is not allowed."
      });
    }
    if (!String(getHeader(req, "content-type") || "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, {
        success: false,
        code: "unsupported_media_type",
        message: "Use application/json."
      });
    }

    const now = dependencies.now ? dependencies.now() : new Date();
    const transitions = [];
    let leadId = crypto.randomUUID();
    let lead;
    let idempotency;
    let claimed = false;
    let redisFailOpen = false;

    const transition = (state, hop, detail, level) => {
      const item = logTransition({ leadId, state, hop, detail, level, logger });
      transitions.push({ timestamp: item.timestamp, state, hop, detail: item.detail });
    };

    try {
      const body = await readJsonBody(req);
      const raw = body?.normalized_lead && typeof body.normalized_lead === "object"
        ? body.normalized_lead
        : body;
      const suppliedLeadId = String(raw?.lead_id || "").trim();
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(suppliedLeadId)) leadId = suppliedLeadId;

      const store = dependencies.store || createStore(config.redis, fetchImpl);
      idempotency = dependencies.idempotency || new IdempotencyService(store, config.dedupLookbackDays);
      if (!idempotency.enabled) {
        redisFailOpen = true;
      } else if (suppliedLeadId) {
        const cached = await idempotency.resultForLeadId(suppliedLeadId);
        if (cached) return sendJson(res, cached.http_status || 200, { ...cached.body, idempotent_replay: true });
      }

      lead = normalizeLead(body, {
        leadId,
        now,
        ip: getClientIp(req),
        userAgent: getHeader(req, "user-agent") || ""
      });
      const zipAllowlist = dependencies.zipAllowlist || loadZipAllowlist(config.zipAllowlistPath);
      validateLead(lead, zipAllowlist);
      transition(STATES.CAPTURED, "gatekeeper", { page: lead.page, form_version: lead.form_version });
      if (redisFailOpen) {
        transition(STATES.CAPTURED, "idempotency", { warning: "redis_not_configured_fail_open" }, "warn");
      }

      let claim;
      try {
        claim = await idempotency.claim({
          requestKey: lead.client_idempotency_key || lead.client_submission_id,
          phone: lead.phone_primary,
          email: lead.email,
          leadId
        });
      } catch {
        transition(STATES.QUARANTINE, "idempotency", { reason: "configured_store_unavailable" }, "error");
        throw new PipelineError(
          503,
          "idempotency_unavailable",
          "Lead verification is temporarily unavailable.",
          STATES.QUARANTINE
        );
      }

      if (claim.status === "CACHED") {
        return sendJson(res, claim.cached.http_status || 200, {
          ...claim.cached.body,
          idempotent_replay: true
        });
      }
      if (claim.status === "DUPLICATE") {
        leadId = claim.leadId || leadId;
        transition(STATES.DUPLICATE, "dedup", { lookback_days: config.dedupLookbackDays });
        return sendJson(res, 200, {
          success: true,
          lead_id: leadId,
          state: STATES.DUPLICATE,
          duplicate: true
        });
      }
      claimed = claim.status === "CLAIMED";

      await verifyTrustedForm(lead, config.trustedForm, fetchImpl);
      transition(STATES.TF_RETAINED, "trustedform", { retained: true, matched: true });

      if (!config.sio.tcpaConsentTextByPage[lead.page]) {
        transition(
          STATES.TF_RETAINED,
          "sio",
          { error: "tcpa_consent_text_missing", page: lead.page },
          "error"
        );
      }

      const preDeliveryEvidence = evidenceFor(lead, transitions, {
        sio: "pending",
        ghl: "pending"
      });
      if (idempotency.enabled) {
        try {
          await idempotency.saveEvidence(leadId, preDeliveryEvidence);
        } catch {
          transition(STATES.QUARANTINE, "evidence_store", { reason: "evidence_write_failed" }, "error");
          throw new PipelineError(
            503,
            "evidence_store_unavailable",
            "Consent evidence could not be stored.",
            STATES.QUARANTINE
          );
        }
      }

      transition(STATES.READY_FOR_ROUTING, "router", {
        buyer: "Standard Information",
        crm: "GoHighLevel"
      });

      const [sio, ghl] = await Promise.all([
        deliverSio(lead, config.sio, fetchImpl),
        deliverGhl(lead, config.ghl, fetchImpl)
      ]);

      transition(
        sio.state,
        "sio",
        {
          accepted: sio.accepted,
          reason: sio.reason,
          price: sio.price,
          confirmation_id: sio.confirmation_id
        },
        sio.state === STATES.BUYER_ACCEPTED ? "info" : sio.state === STATES.QUARANTINE ? "error" : "warn"
      );
      if (ghl.delivered) {
        transition(STATES.GHL_DELIVERED, "ghl", { delivered: true, status: ghl.status });
      } else {
        transition(STATES.QUARANTINE, "ghl", { delivered: false, reason: ghl.reason }, "error");
      }

      const delivery = {
        sio: {
          state: sio.state,
          accepted: sio.accepted,
          reason: sio.reason,
          price: sio.price,
          confirmation_id: sio.confirmation_id
        },
        ghl: {
          state: ghl.delivered ? STATES.GHL_DELIVERED : STATES.QUARANTINE,
          delivered: ghl.delivered,
          reason: ghl.reason
        }
      };
      if (idempotency.enabled) {
        try {
          await idempotency.saveEvidence(leadId, evidenceFor(lead, transitions, delivery));
        } catch {
          transition(STATES.QUARANTINE, "evidence_store", { reason: "final_evidence_write_failed" }, "error");
        }
      }

      const responseBody = {
        success: true,
        lead_id: leadId,
        state: sio.state,
        trustedform: { retained: true, matched: true },
        delivery: {
          sio: sio.state,
          ghl: ghl.delivered ? STATES.GHL_DELIVERED : STATES.QUARANTINE
        },
        sio: {
          price: sio.price,
          confirmation_id: sio.confirmation_id
        }
      };
      if (idempotency.enabled) {
        try { await idempotency.cacheResult(leadId, { http_status: 200, body: responseBody }); } catch {
          transition(STATES.QUARANTINE, "idempotency", { reason: "result_cache_failed" }, "warn");
        }
      }
      return sendJson(res, 200, responseBody);
    } catch (error) {
      const known = error instanceof PipelineError;
      const state = known ? error.state : STATES.QUARANTINE;
      transition(state, "pipeline", { code: known ? error.code : "internal_error" }, known && error.status < 500 ? "warn" : "error");
      const status = known ? error.status : 500;
      const body = {
        success: false,
        lead_id: leadId,
        state,
        code: known ? error.code : "internal_error",
        message: known ? error.message : "The lead could not be processed.",
        ...(known && error.fields.length ? { fields: error.fields } : {})
      };
      if (claimed && idempotency?.enabled) {
        try { await idempotency.cacheResult(leadId, { http_status: status, body }); } catch { /* logging already occurred */ }
      }
      return sendJson(res, status, body);
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports.createHandler = createHandler;
module.exports.evidenceFor = evidenceFor;
module.exports.getClientIp = getClientIp;
module.exports.originAllowed = originAllowed;
