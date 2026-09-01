"use strict";

function safeDetail(detail) {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === "string") return detail.slice(0, 1000);
  if (typeof detail === "number" || typeof detail === "boolean") return detail;
  if (Array.isArray(detail)) return detail.slice(0, 20).map(safeDetail);
  if (typeof detail === "object") {
    return Object.fromEntries(
      Object.entries(detail)
        .filter(([key]) => !/cert|email|phone|address|name|token|key/i.test(key))
        .slice(0, 30)
        .map(([key, value]) => [key, safeDetail(value)])
    );
  }
  return String(detail).slice(0, 1000);
}

function logTransition({ leadId, state, hop, detail, level = "info", logger = console }) {
  const entry = {
    type: "lead_transition",
    lead_id: leadId,
    timestamp: new Date().toISOString(),
    state,
    hop,
    ...(detail === undefined ? {} : { detail: safeDetail(detail) })
  };
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  logger[method](JSON.stringify(entry));
  return entry;
}

module.exports = { logTransition, safeDetail };
