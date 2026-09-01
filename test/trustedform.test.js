"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { verifyTrustedForm } = require("../api/_lib/trustedform");
const { normalizeLead } = require("../api/_lib/validate");
const { validLead } = require("./helpers");

function lead() {
  return normalizeLead(validLead(), {
    leadId: "00000000-0000-4000-8000-000000000001",
    now: new Date("2026-09-01T12:34:56Z"),
    ip: "203.0.113.9",
    userAgent: "test"
  });
}

test("TrustedForm v4 request contains only email and phone in match_lead", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      outcome: "success",
      retain: { results: [{ status: "success" }] },
      match_lead: { result: { success: true } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await verifyTrustedForm(lead(), { apiKey: "secret", timeoutMs: 1000 }, fetchImpl);
  assert.deepEqual(captured.body, {
    retain: {},
    match_lead: { email: "ada@example.com", phone: "2125550123" }
  });
  assert.equal(captured.options.headers["api-version"], "4.0");
  assert.equal(
    captured.options.headers.authorization,
    `Basic ${Buffer.from("API:secret").toString("base64")}`
  );
  assert.deepEqual(result, { retained: true, matched: true, outcome: "success" });
});

test("TrustedForm mismatch fails closed", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    outcome: "success",
    retain: { results: [{}] },
    match_lead: { result: { success: false } }
  }), { status: 200 });
  await assert.rejects(
    verifyTrustedForm(lead(), { apiKey: "secret", timeoutMs: 1000 }, fetchImpl),
    (error) => error.code === "trustedform_mismatch" && error.state === "TF_MISMATCH"
  );
});
