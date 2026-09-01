# Champion Windows lead pipeline

`POST /api/lead` is the secure boundary for both forms. It assigns a server lead ID, validates the capture, deduplicates it when Redis is configured, retains and matches the TrustedForm certificate, and then independently delivers to Standard Information (SIO) and GoHighLevel.

The user receives success after validation and successful TrustedForm Retain + Match. SIO denial, SIO timeout/5xx, or GHL failure is logged and stored as a downstream state without turning the verified capture into a browser error. No downstream delivery occurs when TrustedForm cannot be retained and matched.

## ZIP allowlist

The approved allowlist is stored at `data/champion_zip_coverage_normalized.csv`. The current file contains 9,225 five-digit ZIPs plus the `zip` header. To refresh it, replace that exact file using the same format:

```csv
zip
00501
00601
00602
```

Use one five-digit ZIP per row and preserve leading zeroes. The first CSV column is read. Blank lines and lines beginning with `#` are ignored. A missing, empty, or nonmatching allowlist fails closed before TrustedForm and delivery.

Set `ZIP_ALLOWLIST_PATH` only if the deployment mounts the full CSV elsewhere.

## Configuration

Use the deployment platform's encrypted environment settings. Never add real values to `.env.example` or the browser HTML.

Required:

- `TRUSTEDFORM_API_KEY`: TrustedForm v4 Certificate API password. The Basic Auth username is fixed to uppercase `API`.
- `SI_POST_URL`: `https://exchange.standardinformation.io/post_test` for test delivery.
- `SI_API_KEY`: SIO bearer credential.
- `GHL_WEBHOOK_URL`: HTTPS GoHighLevel inbound webhook that performs a phone/email contact upsert.

Recommended:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

These enable atomic phone/email deduplication, idempotent result caching, and compliance-evidence storage. Per the brief, an entirely unconfigured Redis store logs a warning and fails open. A configured but unreachable store quarantines the request because its state is uncertain.

Optional:

- `DEDUP_LOOKBACK_DAYS` (default `30`)
- `SI_TIMEOUT_MS` (default `12000`)
- `TRUSTEDFORM_TIMEOUT_MS` (default `12000`)
- `GHL_TIMEOUT_MS` (default `12000`)
- `LEAD_ALLOWED_ORIGINS` (comma-separated; same-host is used when empty)
- `ZIP_ALLOWLIST_PATH`

## SIO payload

The SIO payload is nested JSON with `data`, `meta`, and `contact` objects. The replacement-project label and source fallback are server-side constants and are never accepted from the browser:

- `windows_project_type=Interested in replacement windows`
- `source_id` falls back to `Motiv` when `subID1` is empty

`windows_material` and `jornaya_lead_id` are omitted. `offer_id` is omitted when empty. TCPA consent text is keyed by page in `api/_lib/config.js`, but both values intentionally remain unset until the approved company name is resolved. An unset value produces an error-level structured log and is omitted rather than guessed.

## Tests

Node 20 or newer is required. No package installation is necessary because the implementation uses Node's built-in APIs.

```powershell
npm test
```

The tests do not contact TrustedForm, SIO, GoHighLevel, Redis, or any production service.

## Operational notes

- Structured transition logs intentionally omit contact data, credentials, and the unmasked certificate URL.
- The unmasked certificate is stored in the Redis compliance-evidence record and sent to SIO only after successful Retain + Match.
- SIO and GHL calls are attempted once. There is no automatic downstream retry.
- Configure the GHL workflow behind `GHL_WEBHOOK_URL` to upsert by the supplied `lookup.phone` and `lookup.email` values.
