"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createHandler } = require("../api/lead");
const { FIXED_SIO, getConfig } = require("../api/_lib/config");
const { request, responseRecorder, validLead } = require("./helpers");

const env = {
  TRUSTEDFORM_API_KEY: "trustedform-test-key",
  SI_POST_URL: "https://exchange.standardinformation.test/post_test",
  SI_API_KEY: "sio-test-key",
  SI_PARTNER_API_KEY: "sio-partner-test-key",
  GHL_WEBHOOK_URL: "https://ghl.example.test/hook",
  LEAD_ALLOWED_ORIGINS: "https://staging.example.test"
};

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

test("verified capture returns success even when SIO denies and GHL fails", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://cert.trustedform.com/")) {
      return new Response(JSON.stringify({
        outcome: "success",
        retain: { results: [{}] },
        match_lead: { result: { success: true } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://exchange.standardinformation.test/")) {
      return new Response(JSON.stringify({ status: "denied", errors: ["Invalid test lead"] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("GHL unavailable", { status: 503 });
  };
  const handler = createHandler({
    env,
    fetchImpl,
    zipAllowlist: new Set(["12207"]),
    logger: quietLogger(),
    now: () => new Date("2026-09-01T12:34:56Z")
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.delivery.sio, "BUYER_REJECTED");
  assert.equal(body.delivery.ghl, "QUARANTINE");
  assert.equal(calls.length, 3);

  const sioCall = calls.find((call) => call.url.startsWith("https://exchange.standardinformation.test/"));
  const sioPayload = JSON.parse(sioCall.options.body);
  assert.equal(sioCall.options.headers.authorization, "Bearer sio-test-key");
  assert.equal(sioCall.options.headers["content-type"], "application/json");
  assert.equal(sioPayload.contact.phone, "2125550123");
  assert.equal(sioPayload.data.windows_num_windows, 6);
  assert.equal("windows_material" in sioPayload.data, false);
  assert.equal(sioPayload.meta.tcpa_consent_text, FIXED_SIO.tcpaConsentTextByPage.index);
});

test("SIO success captures price and confirmation", async () => {
  const errors = [];
  const fetchImpl = async (url) => {
    if (String(url).startsWith("https://cert.trustedform.com/")) {
      return new Response(JSON.stringify({
        outcome: "success",
        retain: { results: [{}] },
        match_lead: { result: { success: true } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://exchange.standardinformation.test/")) {
      return new Response(JSON.stringify({
        status: "success",
        price: 37.5,
        confirmation_id: "confirmation-123"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const handler = createHandler({
    env,
    fetchImpl,
    zipAllowlist: new Set(["12207"]),
    logger: { log() {}, warn() {}, error(message) { errors.push(message); } }
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.delivery.sio, "BUYER_ACCEPTED");
  assert.deepEqual(body.sio, {
    price: 37.5,
    confirmation_id: "confirmation-123"
  });
  assert.equal(errors.some((entry) => entry.includes("tcpa_consent_text_missing")), false);
});

test("partner delivery selects and logs only the partner SIO key source", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("https://cert.trustedform.com/")) {
      return new Response(JSON.stringify({
        outcome: "success",
        retain: { results: [{}] },
        match_lead: { result: { success: true } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://exchange.standardinformation.test/")) {
      return new Response(JSON.stringify({
        status: "success",
        price: 10,
        confirmation_id: "partner-confirmation"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("GHL unavailable", { status: 503 });
  };
  const handler = createHandler({
    env,
    fetchImpl,
    zipAllowlist: new Set(["12207"]),
    logger: {
      log(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      error(message) { logs.push(message); }
    }
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead({
    page_name: "our_partner_offers",
    selected_offer_id: "partner-offer"
  }) }), res);

  const sioCall = calls.find((call) => call.url.startsWith("https://exchange.standardinformation.test/"));
  assert.ok(sioCall);
  assert.equal(sioCall.options.headers.authorization, "Bearer sio-partner-test-key");
  assert.equal(logs.some((entry) => entry.includes('"page":"partner"') && entry.includes('"credential_source":"SI_PARTNER_API_KEY"')), true);
  assert.equal(logs.some((entry) => entry.includes("sio-partner-test-key")), false);
});

test("partner delivery fails closed when its SIO key is missing", async () => {
  const calls = [];
  const logs = [];
  const handler = createHandler({
    env: { ...env, SI_PARTNER_API_KEY: "" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).startsWith("https://cert.trustedform.com/")) {
        return new Response(JSON.stringify({
          outcome: "success",
          retain: { results: [{}] },
          match_lead: { result: { success: true } }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
    zipAllowlist: new Set(["12207"]),
    logger: {
      log(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      error(message) { logs.push(message); }
    }
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead({
    page_name: "our_partner_offers",
    selected_offer_id: "partner-offer"
  }) }), res);
  const body = JSON.parse(res.body);

  assert.equal(body.delivery.sio, "QUARANTINE");
  assert.equal(calls.some((url) => url.startsWith("https://exchange.standardinformation.test/")), false);
  assert.equal(logs.some((entry) => entry.includes("missing_sio_api_key_partner")), true);
  assert.equal(logs.some((entry) => entry.includes('"credential_source":"SI_PARTNER_API_KEY"')), true);
});

test("missing page TCPA text logs loudly and quarantines before SIO", async () => {
  const errors = [];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://cert.trustedform.com/")) {
      return new Response(JSON.stringify({
        outcome: "success",
        retain: { results: [{}] },
        match_lead: { result: { success: true } }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const config = getConfig(env);
  config.sio = {
    ...config.sio,
    tcpaConsentTextByPage: {
      index: "",
      partner: config.sio.tcpaConsentTextByPage.partner
    }
  };
  const handler = createHandler({
    config,
    env,
    fetchImpl,
    zipAllowlist: new Set(["12207"]),
    logger: { log() {}, warn() {}, error(message) { errors.push(message); } }
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.delivery.sio, "QUARANTINE");
  assert.equal(errors.some((entry) => entry.includes("tcpa_consent_text_missing")), true);
  assert.equal(calls.some((url) => url.startsWith("https://exchange.standardinformation.test/")), false);
});

test("TrustedForm failure prevents SIO and GHL delivery", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({
      outcome: "success",
      retain: { results: [{}] },
      match_lead: { result: { success: false } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const handler = createHandler({
    env,
    fetchImpl,
    zipAllowlist: new Set(["12207"]),
    logger: quietLogger()
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 422);
  assert.equal(body.success, false);
  assert.equal(body.state, "TF_MISMATCH");
  assert.equal(calls.length, 1);
});

test("duplicate short-circuits before TrustedForm and returns user success", async () => {
  let fetchCount = 0;
  const idempotency = {
    enabled: true,
    async resultForLeadId() { return null; },
    async claim() {
      return { status: "DUPLICATE", leadId: "00000000-0000-4000-8000-000000000099" };
    },
    async saveEvidence() {},
    async cacheResult() {}
  };
  const handler = createHandler({
    env,
    idempotency,
    fetchImpl: async () => { fetchCount += 1; throw new Error("should not fetch"); },
    zipAllowlist: new Set(["12207"]),
    logger: quietLogger()
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.state, "DUPLICATE");
  assert.equal(fetchCount, 0);
});

test("placeholder ZIP list fails closed before external calls", async () => {
  let fetchCount = 0;
  const handler = createHandler({
    env,
    fetchImpl: async () => { fetchCount += 1; throw new Error("should not fetch"); },
    zipAllowlist: new Set(),
    logger: quietLogger()
  });
  const res = responseRecorder();
  await handler(request({ normalized_lead: validLead() }), res);
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 422);
  assert.equal(body.code, "zip_not_eligible");
  assert.equal(fetchCount, 0);
});
