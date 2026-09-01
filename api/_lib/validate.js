"use strict";

const fs = require("node:fs");
const net = require("node:net");

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI",
  "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT",
  "VT", "VA", "WA", "WV", "WI", "WY", "DC"
]);

const ELIGIBLE_INTENTS = new Set([
  "replace multiple existing windows",
  "replace existing windows",
  "install windows in a new opening or addition",
  "whole-home replacement"
]);

const ELIGIBLE_HOMEOWNERS = new Set([
  "homeowner",
  "authorized decision maker"
]);

class PipelineError extends Error {
  constructor(status, code, message, state, fields = []) {
    super(message);
    this.name = "PipelineError";
    this.status = status;
    this.code = code;
    this.state = state;
    this.fields = fields;
  }
}

function clean(value, maximum = 500) {
  return String(value ?? "")
    .replace(/[<>\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizePhone(value) {
  const valueDigits = digits(value);
  return valueDigits.length === 11 && valueDigits.startsWith("1")
    ? valueDigits.slice(1)
    : valueDigits;
}

function parseWindowCount(value) {
  const normalized = clean(value, 40).toLowerCase();
  if (normalized === "whole home" || normalized === "whole-home project") return 20;
  if (normalized === "unsure") return 0;
  const match = normalized.match(/\d+/);
  return match ? Number.parseInt(match[0], 10) : 0;
}

function taskNameForWindowCount(windowCount, numericCount) {
  if (clean(windowCount, 40).toLowerCase() === "unsure" || numericCount < 3) return "";
  return numericCount <= 5
    ? "Window Replacement: 3-5 Windows"
    : "Window Replacement: 6+ Windows";
}

function parseZipCsv(text) {
  const zips = new Set();
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const first = trimmed.split(",")[0].replace(/^['\"]|['\"]$/g, "").trim();
    if (/^\d{5}$/.test(first)) zips.add(first);
  }
  return zips;
}

function loadZipAllowlist(filePath) {
  try {
    return parseZipCsv(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new PipelineError(
      503,
      "zip_allowlist_unavailable",
      "ZIP coverage is temporarily unavailable.",
      "QUARANTINE"
    );
  }
}

function getSourceBody(body) {
  const source = body && typeof body.normalized_lead === "object"
    ? body.normalized_lead
    : body;
  if (!source || Array.isArray(source) || typeof source !== "object") {
    throw new PipelineError(400, "invalid_body", "A JSON lead payload is required.", "INVALID");
  }
  return source;
}

function normalizePage(source) {
  const pageName = clean(source.page_name, 100).toLowerCase();
  if (pageName.includes("partner") || source.selected_offer_id || source.partner_route_id) {
    return "partner";
  }
  return "index";
}

function normalizeLead(body, context) {
  const source = getSourceBody(body);
  const phone = normalizePhone(source.phone_primary);
  const windowCount = clean(source.window_count, 40);
  const windowCountNumeric = parseWindowCount(windowCount);
  const consentChecked =
    source.consent_checkbox_checked === true ||
    source.consent_given === true ||
    source.consent === true ||
    source.consent === "yes";

  return {
    lead_id: context.leadId,
    client_submission_id: clean(source.submission_id, 100),
    client_idempotency_key: clean(source.idempotency_key, 100),
    page: normalizePage(source),
    page_name: clean(source.page_name, 100),
    form_version: clean(source.page_version, 40),
    first_name: clean(source.first_name, 45),
    last_name: clean(source.last_name, 45),
    address1: clean(source.address1, 110),
    city: clean(source.city, 60),
    state: clean(source.state, 2).toUpperCase(),
    postal_code: digits(source.postal_code).slice(0, 5),
    email: clean(source.email, 100).toLowerCase(),
    phone_primary: phone,
    project_intent: clean(source.project_intent, 150),
    preferred_window_style: clean(source.preferred_window_style, 100),
    window_count: windowCount,
    window_count_numeric: windowCountNumeric,
    homeowner_status: clean(source.homeowner_status, 80),
    project_timing: clean(source.project_timing, 80),
    project_goal: clean(source.project_goal, 120),
    project_notes: clean(source.project_notes, 500),
    cert: clean(source.cert || source.Cert || source.trustedform_cert_url, 1000),
    consent_checkbox_checked: consentChecked,
    company_website: clean(source.company_website, 200),
    selected_recipient: normalizePage(source) === "partner"
      ? clean(source.partner_display || source.selected_offer_name || "Champion Windows", 180)
      : "Champion Windows",
    selected_offer_id: clean(source.selected_offer_id, 100),
    selected_offer_name: clean(source.selected_offer_name, 180),
    partner_match_preference: clean(source.partner_match_preference, 180),
    subID1: clean(source.subID1 || source.utm_source, 180),
    subID2: clean(source.subID2 || source.utm_campaign, 180),
    subID3: clean(source.subID3 || source.utm_content, 180),
    page_url: clean(source.landing_page_url, 1000),
    referring_url: clean(source.referrer, 1000),
    ip: context.ip,
    user_agent: clean(context.userAgent, 1000),
    captured_at: context.now.toISOString(),
    taskName: taskNameForWindowCount(windowCount, windowCountNumeric)
  };
}

function validateTrustedFormUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "cert.trustedform.com";
  } catch {
    return false;
  }
}

function validateLead(lead, zipAllowlist) {
  if (lead.company_website) {
    throw new PipelineError(400, "honeypot_triggered", "The request could not be verified.", "INVALID");
  }

  const invalid = [];
  const required = [
    "first_name", "last_name", "address1", "city", "state", "postal_code",
    "email", "phone_primary", "project_intent", "window_count",
    "homeowner_status", "project_timing", "project_goal"
  ];
  for (const field of required) if (!lead[field]) invalid.push(field);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) invalid.push("email");
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(lead.phone_primary)) invalid.push("phone_primary");
  if (!US_STATES.has(lead.state)) invalid.push("state");
  if (!/^\d{5}$/.test(lead.postal_code)) invalid.push("postal_code");
  if (!net.isIPv4(lead.ip)) invalid.push("ip");
  if (!lead.consent_checkbox_checked) invalid.push("consent");

  if (invalid.length) {
    throw new PipelineError(
      422,
      "validation_failed",
      "The lead payload is incomplete or invalid.",
      "INVALID",
      [...new Set(invalid)]
    );
  }

  if (!lead.cert) {
    throw new PipelineError(422, "trustedform_missing", "A consent certificate is required.", "TF_MISSING", ["cert"]);
  }
  if (!validateTrustedFormUrl(lead.cert)) {
    throw new PipelineError(422, "trustedform_invalid", "The consent certificate is invalid.", "TF_VERIFY_FAILED", ["cert"]);
  }
  if (!ELIGIBLE_INTENTS.has(lead.project_intent.toLowerCase())) {
    throw new PipelineError(422, "project_not_eligible", "This project type is not eligible.", "INVALID", ["project_intent"]);
  }
  if (!ELIGIBLE_HOMEOWNERS.has(lead.homeowner_status.toLowerCase())) {
    throw new PipelineError(422, "homeowner_not_eligible", "This property relationship is not eligible.", "INVALID", ["homeowner_status"]);
  }
  if (!lead.taskName) {
    throw new PipelineError(422, "window_count_not_eligible", "At least three windows are required.", "INVALID", ["window_count"]);
  }
  if (!zipAllowlist.size || !zipAllowlist.has(lead.postal_code)) {
    throw new PipelineError(422, "zip_not_eligible", "This ZIP code is not in the approved service area.", "INVALID", ["postal_code"]);
  }
}

function cleanIpv4(values) {
  for (const value of values) {
    for (const candidate of String(value || "").split(",")) {
      const cleaned = candidate.trim().replace(/^::ffff:/i, "");
      if (net.isIPv4(cleaned)) return cleaned;
    }
  }
  return "";
}

module.exports = {
  PipelineError,
  clean,
  cleanIpv4,
  loadZipAllowlist,
  normalizeLead,
  normalizePhone,
  parseWindowCount,
  parseZipCsv,
  taskNameForWindowCount,
  validateLead,
  validateTrustedFormUrl
};
