"use strict";

class RedisStore {
  constructor(config, fetchImpl = fetch) {
    this.url = config.url;
    this.token = config.token;
    this.fetchImpl = fetchImpl;
    this.enabled = Boolean(this.url && this.token);
  }

  async command(parts) {
    if (!this.enabled) return null;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(parts),
      redirect: "error"
    });
    if (!response.ok) throw new Error(`redis_http_${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error("redis_command_failed");
    return payload.result;
  }

  async getJson(key) {
    const value = await this.command(["GET", key]);
    if (!value) return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  async setJson(key, value, ttlSeconds) {
    const command = ["SET", key, JSON.stringify(value)];
    if (ttlSeconds) command.push("EX", String(ttlSeconds));
    await this.command(command);
  }
}

function createStore(config, fetchImpl) {
  return new RedisStore(config, fetchImpl);
}

module.exports = { RedisStore, createStore };
