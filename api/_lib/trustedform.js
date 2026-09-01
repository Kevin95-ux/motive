"use strict";

const { PipelineError } = require("./validate");
const { STATES } = require("./states");

async function verifyTrustedForm(lead, config, fetchImpl = fetch) {
  if (!config.apiKey) {
    throw new PipelineError(
      503,
      "trustedform_unconfigured",
      "Consent verification is temporarily unavailable.",
      STATES.QUARANTINE
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(lead.cert, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`API:${config.apiKey}`).toString("base64")}`,
        "api-version": "4.0",
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        retain: {},
        match_lead: {
          email: lead.email,
          phone: lead.phone_primary
        }
      }),
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    throw new PipelineError(
      502,
      error?.name === "AbortError" ? "trustedform_timeout" : "trustedform_unreachable",
      "Consent verification could not be completed.",
      STATES.TF_VERIFY_FAILED
    );
  } finally {
    clearTimeout(timer);
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new PipelineError(
      502,
      "trustedform_invalid_response",
      "Consent verification returned an invalid response.",
      STATES.TF_VERIFY_FAILED
    );
  }

  if (!response.ok || result?.outcome !== "success" || !result?.retain?.results) {
    throw new PipelineError(
      422,
      "trustedform_retain_failed",
      "The consent certificate could not be retained.",
      STATES.QUARANTINE
    );
  }

  if (result?.match_lead?.result?.success !== true) {
    throw new PipelineError(
      422,
      "trustedform_mismatch",
      "The consent certificate did not match the submitted contact information.",
      STATES.TF_MISMATCH
    );
  }

  return {
    retained: true,
    matched: true,
    outcome: result.outcome
  };
}

module.exports = { verifyTrustedForm };
