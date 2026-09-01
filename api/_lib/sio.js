"use strict";

const { clean } = require("./validate");

const OWNER_PROPERTY_VALUES = new Set([
  "Homeowner",
  "Authorized decision maker"
]);

const REPLACEMENT_PROJECT_INTENTS = new Set([
  "Replace multiple existing windows",
  "Replace existing windows",
  "Install windows in a new opening or addition",
  "Whole-home replacement"
]);

class SioMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SioMappingError";
    this.code = code;
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SioMappingError(
      `missing_${field}`,
      `SIO requires ${field}.`
    );
  }
  return value;
}

function ownPropertyForLead(lead) {
  if (!OWNER_PROPERTY_VALUES.has(lead.homeowner_status)) {
    throw new SioMappingError(
      "invalid_property_ownership",
      "The lead does not contain an accepted owner-type property relationship."
    );
  }
  return true;
}

function projectTypeForLead(lead, config) {
  if (!REPLACEMENT_PROJECT_INTENTS.has(lead.project_intent)) {
    throw new SioMappingError(
      "unexpected_project_intent",
      "A non-replacement project reached SIO delivery."
    );
  }
  return config.windowsProjectType;
}

function mapSioLead(lead, config) {
  if (!Number.isFinite(lead.window_count_numeric) || lead.window_count_numeric < 3) {
    throw new SioMappingError(
      "invalid_window_count",
      "A valid numeric window count is required for SIO delivery."
    );
  }

  const meta = {
    landing_page_url: requiredString(lead.page_url, "landing_page_url"),
    originally_created: requiredString(lead.captured_at, "originally_created"),
    source_id: requiredString(lead.subID1 || config.sourceIdFallback, "source_id"),
    trusted_form_cert_url: requiredString(lead.cert, "trusted_form_cert_url"),
    user_agent: requiredString(lead.user_agent, "user_agent")
  };
  if (lead.selected_offer_id) meta.offer_id = lead.selected_offer_id;
  const consentText = config.tcpaConsentTextByPage[lead.page];
  if (consentText) meta.tcpa_consent_text = consentText;

  return {
    data: {
      own_property: ownPropertyForLead(lead),
      windows_num_windows: lead.window_count_numeric,
      windows_project_type: projectTypeForLead(lead, config)
    },
    meta,
    contact: {
      address: requiredString(lead.address1, "contact_address"),
      city: requiredString(lead.city, "contact_city"),
      email: requiredString(lead.email, "contact_email"),
      first_name: requiredString(lead.first_name, "contact_first_name"),
      ip_address: requiredString(lead.ip, "contact_ip_address"),
      last_name: requiredString(lead.last_name, "contact_last_name"),
      phone: requiredString(lead.phone_primary, "contact_phone"),
      state: requiredString(lead.state, "contact_state"),
      zip_code: requiredString(lead.postal_code, "contact_zip_code")
    }
  };
}

function deniedReason(errors) {
  if (typeof errors === "string") return clean(errors, 2000) || "sio_denied";
  if (errors === undefined || errors === null) return "sio_denied";
  try { return JSON.stringify(errors).slice(0, 2000); } catch { return "sio_denied"; }
}

function parseSioResponse(httpStatus, body) {
  if (httpStatus >= 500) {
    return { state: "QUARANTINE", accepted: false, reason: `sio_http_${httpStatus}` };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      state: "BUYER_REJECTED",
      accepted: false,
      reason: httpStatus >= 200 && httpStatus < 300
        ? "invalid_sio_response"
        : `sio_http_${httpStatus}`
    };
  }
  if (httpStatus >= 200 && httpStatus < 300 && body.status === "success") {
    return {
      state: "BUYER_ACCEPTED",
      accepted: true,
      price: body.price,
      confirmation_id: body.confirmation_id,
      reason: "accepted"
    };
  }
  if (body.status === "denied") {
    return {
      state: "BUYER_REJECTED",
      accepted: false,
      reason: deniedReason(body.errors)
    };
  }
  return {
    state: "BUYER_REJECTED",
    accepted: false,
    reason: httpStatus >= 200 && httpStatus < 300
      ? "unexpected_sio_status"
      : `sio_http_${httpStatus}`
  };
}

async function deliverSio(lead, config, fetchImpl = fetch) {
  if (!config.postUrl || !config.apiKey) {
    return { state: "QUARANTINE", accepted: false, reason: "sio_unconfigured" };
  }
  let url;
  try { url = new URL(config.postUrl); } catch { /* handled below */ }
  if (!url || url.protocol !== "https:") {
    return { state: "QUARANTINE", accepted: false, reason: "invalid_sio_url" };
  }

  let payload;
  try {
    payload = mapSioLead(lead, config);
  } catch (error) {
    return {
      state: "QUARANTINE",
      accepted: false,
      reason: error instanceof SioMappingError ? error.code : "sio_mapping_failed"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.postUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "WindowMotiv-SIO-Router/1.0"
      },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal
    });
    let body;
    try { body = await response.json(); } catch { body = null; }
    return parseSioResponse(response.status, body);
  } catch (error) {
    return {
      state: "QUARANTINE",
      accepted: false,
      reason: error?.name === "AbortError" ? "sio_timeout" : "sio_unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  OWNER_PROPERTY_VALUES,
  REPLACEMENT_PROJECT_INTENTS,
  SioMappingError,
  deliverSio,
  mapSioLead,
  ownPropertyForLead,
  parseSioResponse,
  projectTypeForLead,
  requiredString
};
