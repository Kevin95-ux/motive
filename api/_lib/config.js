"use strict";

const path = require("node:path");

const FIXED_SIO = Object.freeze({
  sourceIdFallback: "Motiv",
  windowsProjectType: "Interested in replacement windows",

  // TODO: Set each value to the exact approved disclosure shown to the
  // consumer after REPLACE_WITH_O_AND_O_COMPANY_NAME is resolved. An unset
  // value is deliberately omitted from SIO rather than guessed.
  tcpaConsentTextByPage: Object.freeze({
    index: "",
    partner: ""
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
