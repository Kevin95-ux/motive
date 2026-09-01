"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PipelineError,
  normalizeLead,
  parseZipCsv,
  taskNameForWindowCount,
  validateLead
} = require("../api/_lib/validate");
const { validLead } = require("./helpers");

const context = {
  leadId: "00000000-0000-4000-8000-000000000001",
  now: new Date("2026-09-01T12:34:56Z"),
  ip: "203.0.113.9",
  userAgent: "test"
};

test("normalizes contact values and does not trust browser routing fields", () => {
  const lead = normalizeLead({ normalized_lead: validLead({
    email: " ADA@EXAMPLE.COM ",
    phone_primary: "+1 (212) 555-0123",
    state: "ny",
    ip: "198.51.100.10",
    taskName: "attacker supplied"
  }) }, context);
  assert.equal(lead.email, "ada@example.com");
  assert.equal(lead.phone_primary, "2125550123");
  assert.equal(lead.state, "NY");
  assert.equal(lead.ip, "203.0.113.9");
  assert.equal(lead.taskName, "Window Replacement: 6+ Windows");
});

test("keeps the window-count qualification helper exact", () => {
  assert.equal(taskNameForWindowCount("3-5", 3), "Window Replacement: 3-5 Windows");
  assert.equal(taskNameForWindowCount("4-5", 4), "Window Replacement: 3-5 Windows");
  assert.equal(taskNameForWindowCount("6-9", 6), "Window Replacement: 6+ Windows");
  assert.equal(taskNameForWindowCount("Whole home", 20), "Window Replacement: 6+ Windows");
  assert.equal(taskNameForWindowCount("Unsure", 0), "");
});

test("enforces consent, honeypot, homeowner, intent, count, and ZIP qualification", () => {
  const cases = [
    [{ consent_checkbox_checked: false }, "validation_failed"],
    [{ company_website: "spam.example" }, "honeypot_triggered"],
    [{ homeowner_status: "Renter" }, "homeowner_not_eligible"],
    [{ homeowner_status: "Landlord or property manager" }, "homeowner_not_eligible"],
    [{ project_intent: "Repair or service an existing window" }, "project_not_eligible"],
    [{ project_intent: "Glass, hardware, seal, or component issue" }, "project_not_eligible"],
    [{ window_count: "Unsure" }, "window_count_not_eligible"]
  ];
  for (const [change, code] of cases) {
    const lead = normalizeLead(validLead(change), context);
    assert.throws(
      () => validateLead(lead, new Set(["12207"])),
      (error) => error instanceof PipelineError && error.code === code
    );
  }
  const eligible = normalizeLead(validLead(), context);
  assert.throws(
    () => validateLead(eligible, new Set()),
    (error) => error.code === "zip_not_eligible"
  );
});

test("ZIP CSV preserves five-digit values and ignores its placeholder comment", () => {
  assert.deepEqual(
    [...parseZipCsv("zip\n00501\n# placeholder\n12207,NY\nbad\n")],
    ["00501", "12207"]
  );
});
