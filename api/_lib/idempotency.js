"use strict";

const crypto = require("node:crypto");

const CLAIM_SCRIPT = `
local request_lead = redis.call('GET', KEYS[1])
if request_lead then
  return {'EXISTING_REQUEST', request_lead}
end
local phone_lead = redis.call('GET', KEYS[2])
local email_lead = redis.call('GET', KEYS[3])
if phone_lead or email_lead then
  return {'DUPLICATE', phone_lead or email_lead}
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[2])
return {'CLAIMED', ARGV[1]}
`;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeKey(value) {
  return hash(String(value || "missing"));
}

class IdempotencyService {
  constructor(store, lookbackDays) {
    this.store = store;
    this.ttlSeconds = lookbackDays * 24 * 60 * 60;
  }

  get enabled() {
    return this.store.enabled;
  }

  async resultForLeadId(leadId) {
    if (!this.enabled || !leadId) return null;
    return this.store.getJson(`lead:result:${safeKey(leadId)}`);
  }

  async claim({ requestKey, phone, email, leadId }) {
    if (!this.enabled) return { status: "SKIPPED", leadId };
    const requestRedisKey = `lead:request:${safeKey(requestKey || leadId)}`;
    const phoneKey = `lead:dedup:phone:${safeKey(phone)}`;
    const emailKey = `lead:dedup:email:${safeKey(email)}`;
    const result = await this.store.command([
      "EVAL",
      CLAIM_SCRIPT,
      "3",
      requestRedisKey,
      phoneKey,
      emailKey,
      leadId,
      String(this.ttlSeconds)
    ]);
    const status = Array.isArray(result) ? result[0] : "SKIPPED";
    const existingLeadId = Array.isArray(result) ? result[1] : leadId;
    if (status === "EXISTING_REQUEST") {
      const cached = await this.resultForLeadId(existingLeadId);
      return cached
        ? { status: "CACHED", leadId: existingLeadId, cached }
        : { status: "DUPLICATE", leadId: existingLeadId };
    }
    return { status, leadId: existingLeadId };
  }

  async cacheResult(leadId, response) {
    if (!this.enabled) return;
    await this.store.setJson(`lead:result:${safeKey(leadId)}`, response, this.ttlSeconds);
  }

  async saveEvidence(leadId, evidence) {
    if (!this.enabled) return;
    await this.store.setJson(`lead:evidence:${safeKey(leadId)}`, evidence);
  }
}

module.exports = { CLAIM_SCRIPT, IdempotencyService, hash, safeKey };
