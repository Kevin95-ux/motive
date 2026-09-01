"use strict";

async function deliverGhl(lead, config, fetchImpl = fetch) {
  if (!config.webhookUrl) {
    return { delivered: false, reason: "ghl_unconfigured" };
  }
  let url;
  try { url = new URL(config.webhookUrl); } catch { /* handled below */ }
  if (!url || url.protocol !== "https:") {
    return { delivered: false, reason: "invalid_ghl_url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        "user-agent": "WindowMotiv-Champion-Router/1.0"
      },
      body: JSON.stringify({
        operation: "upsert",
        lookup: {
          phone: lead.phone_primary,
          email: lead.email
        },
        lead: {
          lead_id: lead.lead_id,
          first_name: lead.first_name,
          last_name: lead.last_name,
          email: lead.email,
          phone: lead.phone_primary,
          address1: lead.address1,
          city: lead.city,
          state: lead.state,
          postal_code: lead.postal_code,
          project_intent: lead.project_intent,
          preferred_window_style: lead.preferred_window_style,
          window_count: lead.window_count,
          homeowner_status: lead.homeowner_status,
          project_timing: lead.project_timing,
          project_goal: lead.project_goal,
          project_notes: lead.project_notes,
          page: lead.page,
          page_url: lead.page_url,
          referring_url: lead.referring_url,
          form_version: lead.form_version,
          captured_at: lead.captured_at,
          trustedform_cert_url: lead.cert,
          consent_checkbox_checked: lead.consent_checkbox_checked,
          selected_recipient: lead.selected_recipient
        }
      }),
      redirect: "error",
      signal: controller.signal
    });
    const text = (await response.text()).slice(0, 1000);
    if (!response.ok) return { delivered: false, reason: `ghl_http_${response.status}`, detail: text };
    return { delivered: true, status: response.status };
  } catch (error) {
    return {
      delivered: false,
      reason: error?.name === "AbortError" ? "ghl_timeout" : "ghl_unreachable"
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { deliverGhl };
