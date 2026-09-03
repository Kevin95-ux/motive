"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { FIXED_SIO } = require("../api/_lib/config");
const {
  deliverSio,
  mapSioLead,
  ownPropertyForLead,
  parseSioResponse,
  projectTypeForLead
} = require("../api/_lib/sio");
const { normalizeLead } = require("../api/_lib/validate");
const { validLead } = require("./helpers");

function normalized(overrides = {}) {
  return normalizeLead(validLead(overrides), {
    leadId: "00000000-0000-4000-8000-000000000001",
    now: new Date("2026-09-01T12:34:56Z"),
    ip: "203.0.113.9",
    userAgent: "consumer-agent"
  });
}

function renderedDisclosure(file, inputId) {
  const html = fs.readFileSync(file, "utf8");
  const match = html.match(
    new RegExp(`<label\\s+for=["']${inputId}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i")
  );
  assert.ok(match, `Consent label ${inputId} must exist in ${file}`);
  return match[1]
    .replace(/<span[^>]*>[\s\S]*?<\/span>/gi, "Motiv Brands Group, LLC DBA Window Motiv")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

test("TCPA constants exactly match the rendered disclosures", () => {
  assert.equal(
    FIXED_SIO.tcpaConsentTextByPage.index,
    renderedDisclosure("index.html", "wp-consent")
  );
  assert.equal(
    FIXED_SIO.tcpaConsentTextByPage.partner,
    renderedDisclosure("Partner.html", "wp-offer-consent")
  );
});

test("SIO payload has the exact nested shape and omits unavailable optional fields", () => {
  const payload = mapSioLead(normalized(), FIXED_SIO);
  assert.deepEqual(payload, {
    data: {
      own_property: true,
      windows_num_windows: 6,
      windows_project_type: "Interested in replacement windows"
    },
    meta: {
      landing_page_url: "https://staging.example.test/",
      originally_created: "2026-09-01T12:34:56.000Z",
      source_id: "Motiv",
      tcpa_consent_text: FIXED_SIO.tcpaConsentTextByPage.index,
      trusted_form_cert_url: validLead().cert,
      user_agent: "consumer-agent"
    },
    contact: {
      address: "1 Main Street",
      city: "Albany",
      email: "ada@example.com",
      first_name: "Ada",
      ip_address: "203.0.113.9",
      last_name: "Lovelace",
      phone: "2125550123",
      state: "NY",
      zip_code: "12207"
    }
  });
  assert.equal("windows_material" in payload.data, false);
  assert.equal("jornaya_lead_id" in payload.meta, false);
  assert.equal("offer_id" in payload.meta, false);
});

test("SIO includes source, offer, and the page-specific TCPA text", () => {
  const payload = mapSioLead(normalized({
    page_name: "our_partner_offers",
    selected_offer_id: "offer-123",
    subID1: "source-123"
  }), FIXED_SIO);
  assert.equal(payload.meta.source_id, "source-123");
  assert.equal(payload.meta.offer_id, "offer-123");
  assert.equal(payload.meta.tcpa_consent_text, FIXED_SIO.tcpaConsentTextByPage.partner);
});

test("ownership and project guards reject unexpected future values", () => {
  assert.equal(ownPropertyForLead(normalized()), true);
  assert.throws(
    () => ownPropertyForLead(normalized({ homeowner_status: "Renter" })),
    (error) => error.code === "invalid_property_ownership"
  );
  assert.equal(
    projectTypeForLead(normalized(), FIXED_SIO),
    "Interested in replacement windows"
  );
  assert.throws(
    () => projectTypeForLead(normalized({ project_intent: "Repair or service an existing window" }), FIXED_SIO),
    (error) => error.code === "unexpected_project_intent"
  );
});

test("SIO mapping quarantines missing required metadata before posting", () => {
  assert.throws(
    () => mapSioLead(normalized({ landing_page_url: "" }), FIXED_SIO),
    (error) => error.code === "missing_landing_page_url"
  );
  assert.throws(
    () => mapSioLead(normalized(), {
      ...FIXED_SIO,
      tcpaConsentTextByPage: { index: "", partner: FIXED_SIO.tcpaConsentTextByPage.partner }
    }),
    (error) => error.code === "missing_tcpa_consent_text"
  );
});

test("SIO response parser uses only documented status values", () => {
  assert.deepEqual(
    parseSioResponse(200, { status: "success", price: 42.5, confirmation_id: "confirm-1" }),
    {
      state: "BUYER_ACCEPTED",
      accepted: true,
      price: 42.5,
      confirmation_id: "confirm-1",
      reason: "accepted"
    }
  );
  assert.deepEqual(
    parseSioResponse(200, { status: "denied", errors: { zip_code: ["not accepted"] } }),
    {
      state: "BUYER_REJECTED",
      accepted: false,
      reason: '{"zip_code":["not accepted"]}'
    }
  );
  assert.equal(parseSioResponse(503, { status: "denied" }).state, "QUARANTINE");
  assert.equal(parseSioResponse(200, { status: "accepted" }).reason, "unexpected_sio_status");
});

test("SIO credentials fail closed independently for index and partner pages", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    throw new Error("SIO must not be called without the page-specific key");
  };
  const baseConfig = {
    ...FIXED_SIO,
    postUrl: "https://exchange.standardinformation.test/post_test",
    timeoutMs: 1000
  };

  const missingIndex = await deliverSio(normalized(), {
    ...baseConfig,
    apiKeysByPage: { index: "", partner: "partner-key" }
  }, fetchImpl);
  const missingPartner = await deliverSio(normalized({
    page_name: "our_partner_offers",
    selected_offer_id: "partner-offer"
  }), {
    ...baseConfig,
    apiKeysByPage: { index: "index-key", partner: "" }
  }, fetchImpl);

  assert.equal(missingIndex.reason, "missing_sio_api_key_index");
  assert.equal(missingIndex.credential_source, "SI_API_KEY");
  assert.equal(missingPartner.reason, "missing_sio_api_key_partner");
  assert.equal(missingPartner.credential_source, "SI_PARTNER_API_KEY");
  assert.equal(fetchCount, 0);
});
