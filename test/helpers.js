"use strict";

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); }
  };
}

function request(body, overrides = {}) {
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      host: "staging.example.test",
      origin: "https://staging.example.test",
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "pipeline-test",
      ...(overrides.headers || {})
    },
    socket: {},
    ...overrides
  };
}

function validLead(overrides = {}) {
  return {
    submission_id: "submission-123",
    idempotency_key: "idempotency-123",
    page_name: "windows_landing_page",
    page_version: "V1.0.8",
    first_name: "Ada",
    last_name: "Lovelace",
    address1: "1 Main Street",
    city: "Albany",
    state: "NY",
    postal_code: "12207",
    email: "ada@example.com",
    phone_primary: "2125550123",
    project_intent: "Replace multiple existing windows",
    preferred_window_style: "Double-Hung Windows",
    window_count: "6-9",
    homeowner_status: "Homeowner",
    project_timing: "Within 30 days",
    project_goal: "Energy efficiency",
    project_notes: "Test project",
    cert: "https://cert.trustedform.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    consent_checkbox_checked: true,
    company_website: "",
    landing_page_url: "https://staging.example.test/",
    referrer: "https://search.example.test/",
    ...overrides
  };
}

module.exports = { request, responseRecorder, validLead };
