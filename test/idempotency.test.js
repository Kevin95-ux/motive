"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { IdempotencyService } = require("../api/_lib/idempotency");

test("idempotency claim uses an atomic Redis script for request, phone, and email", async () => {
  let command;
  const store = {
    enabled: true,
    async command(parts) { command = parts; return ["CLAIMED", "lead-1"]; },
    async getJson() { return null; },
    async setJson() {}
  };
  const service = new IdempotencyService(store, 30);
  const result = await service.claim({
    requestKey: "request-1",
    phone: "2125550123",
    email: "ada@example.com",
    leadId: "lead-1"
  });
  assert.equal(result.status, "CLAIMED");
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], "3");
  assert.equal(command.at(-1), String(30 * 24 * 60 * 60));
});

test("an existing request returns its cached response", async () => {
  const cached = { http_status: 200, body: { success: true, lead_id: "lead-1" } };
  const store = {
    enabled: true,
    async command() { return ["EXISTING_REQUEST", "lead-1"]; },
    async getJson() { return cached; },
    async setJson() {}
  };
  const service = new IdempotencyService(store, 30);
  const result = await service.claim({
    requestKey: "request-1",
    phone: "2125550123",
    email: "ada@example.com",
    leadId: "lead-2"
  });
  assert.equal(result.status, "CACHED");
  assert.deepEqual(result.cached, cached);
});
