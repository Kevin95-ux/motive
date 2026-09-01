"use strict";

const path = require("node:path");

const FIXED_SIO = Object.freeze({
  sourceIdFallback: "Motiv",
  windowsProjectType: "Interested in replacement windows",
  tcpaConsentTextByPage: Object.freeze({
    index: "By checking this box and clicking “Submit My Project,” I provide my electronic signature and consent to receive marketing calls and text messages, including through automated technology or prerecorded messages, from Motiv Brands Group, LLC. DBA Window Motiv, its service providers, and participating window and home-improvement providers regarding my inquiry at the telephone number provided. Consent is not a condition of purchase. Message and data rates may apply. I agree to the Terms of Use and acknowledge the Privacy Policy .",
    partner: "By checking this box and clicking “Submit My Offer Request,” I provide my electronic signature and consent to receive marketing calls and text messages, including through automated technology or prerecorded messages, from Motiv Brands Group, LLC. DBA Window Motiv, its service providers, and participating window and home-improvement providers regarding my inquiry at the telephone number provided. This may include the participating provider associated with my selected offer when I request or permit direct matching. Consent is not a condition of purchase. Message and data rates may apply. I agree to the Terms of Use and acknowledge the Privacy Policy ."
  })
});

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function getConfig(env = process.env) {
  return {
    sio: {
      ...FIXED_SIO,
      postUrl: String(env.SI_POST_URL || "").trim(),
      apiKey: String(env.SI_API_KEY || "").trim(),
      timeoutMs: boundedInteger(env.SI_TIMEOUT_MS, 12000, 1000, 30000)
    },
    trustedForm: {
      apiKey: String(env.TRUSTEDFORM_API_KEY || "").trim(),
      timeoutMs: boundedInteger(env.TRUSTEDFORM_TIMEOUT_MS, 12000, 1000, 30000)
    },
    ghl: {
      webhookUrl: String(env.GHL_WEBHOOK_URL || "").trim(),
      timeoutMs: boundedInteger(env.GHL_TIMEOUT_MS, 12000, 1000, 30000)
    },
    redis: {
      url: String(env.KV_REST_API_URL || "").trim().replace(/\/$/, ""),
      token: String(env.KV_REST_API_TOKEN || "").trim()
    },
    dedupLookbackDays: boundedInteger(env.DEDUP_LOOKBACK_DAYS, 30, 1, 365),
    allowedOrigins: csv(env.LEAD_ALLOWED_ORIGINS),
    zipAllowlistPath:
      env.ZIP_ALLOWLIST_PATH ||
      path.join(process.cwd(), "data", "champion_zip_coverage_normalized.csv")
  };
}

module.exports = { FIXED_SIO, getConfig };
