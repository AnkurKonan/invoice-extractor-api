# Invoice & Receipt Extractor API

A vertical AI API on Cloudflare Workers: send an invoice (text, PDF, or image) and get clean structured JSON back,
with **confidence scores and human-review flags that are computed from the arithmetic, not from the LLM's say-so.**

## Why customers will pay for this (and not just call an LLM themselves)

- **Trust layer** (`src/validate.ts`): every response is re-checked in code. Line math (qty x price = line total),
  sum of lines = subtotal, subtotal - discount + shipping + tax = total, valid calendar dates. If anything is off,
  `needs_human_review` is `true` and confidence is downgraded, even when the model claimed "high".
- Never charged for our failures (quota is refunded on model errors).
- Prompt-injection hardened (invoice text is treated as data), strict input validation, size limits.
- Audit log stores **metadata only**, never document contents.
- `POST /v1/explain`: plain-English summary of a result.

## Deploy (about 10 minutes)

```bash
npm install
npx wrangler login

# 1. Database
npx wrangler d1 create invoice-extractor          # copy the database_id into wrangler.toml
npx wrangler d1 execute invoice-extractor --remote --file=schema.sql

# 2. Admin secret (long random string; this is YOUR key to issue customer keys)
npx wrangler secret put ADMIN_TOKEN

# 3. Ship it
npx wrangler deploy

# 4. One-time: accept Meta's licence for the image model
curl -X POST https://<your-worker>.workers.dev/admin/vision-agree -H "Authorization: Bearer $ADMIN_TOKEN"
```

Workers AI needs a Cloudflare **Workers Paid plan** ($5/mo) for real traffic. Check current Workers AI pricing before you set yours.

## Issue a customer key

```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"customer@example.com","plan":"starter"}'
```
Plans (edit in `src/auth.ts`): `free` 50/mo, `starter` 1,000/mo, `pro` 10,000/mo, `scale` 100,000/mo. Override per customer with `"monthly_quota": 2500`.
Other admin calls: `GET /admin/keys` (usage per key), `POST /admin/keys/revoke {"key_prefix": "..."}`.

## API

All calls: `Authorization: Bearer <key>`. Errors look like `{"error":{"code","message"},"request_id"}`.

### `POST /v1/extract`
Send exactly one of:
```json
{ "text": "Invoice #INV-8842 from Acme ..." }
{ "file_base64": "<base64 of a PDF, PNG, JPEG or WEBP>" }
```
(`image_base64` still works.) Limits: text 60k chars, image 5 MB, PDF 8 MB. Scanned PDFs: upload as an image.

Response (abridged):
```json
{
  "vendor_name": "Acme Supplies", "invoice_number": "INV-8842", "invoice_date": "2026-11-10",
  "currency": "USD", "subtotal": 115, "tax_amount": 9.2, "total_amount": 124.2,
  "line_items": [{ "line_number": 1, "description": "Widget A", "quantity": 2, "unit_price": 45, "line_total": 90 }],
  "confidence": "high", "needs_human_review": false, "review_reasons": [],
  "validation": { "line_math_ok": true, "subtotal_ok": true, "total_ok": true },
  "meta": { "request_id": "...", "model": "...", "input_type": "text", "processing_ms": 1800 }
}
```
Headers: `X-Quota-Limit`, `X-Quota-Remaining`, `X-Request-Id`.

### `POST /v1/explain`
`{ "result": <object returned by /v1/extract> }` -> `{ "explanation": "Acme billed you $124.20 ..." }`

### `GET /v1/usage`
Plan, used, limit, remaining for the current month.

## Making money

1. **Fastest: list on RapidAPI.** They handle signup, billing and payouts. Set the secret
   `npx wrangler secret put RAPIDAPI_PROXY_SECRET`; requests carrying a valid `X-RapidAPI-Proxy-Secret` are accepted automatically.
2. **Direct:** you issue keys with the admin endpoint and bill by hand/Stripe invoice at first. Add Stripe Checkout + a webhook that
   calls the same insert as `/admin/keys` once you have paying users.
3. **Pricing guide:** model cost per call is roughly a fraction of a cent. Charging ~$0.02-0.05/call (e.g. Starter $29 for 1,000)
   leaves very high margin. Verify against your own measured cost.
4. **Pick one niche** (freight, construction, dental, property management) and tune `FIELD_RULES` in `src/extract.ts`
   (e.g. fuel surcharge, retainage, tax codes). Niche positioning is what lets you charge more than a generic OCR API.

## Before you charge real money

- **Measure accuracy** on 50+ real invoices from your target niche. Publish the numbers; your review flags should catch the misses.
- Add a Privacy Policy and Terms (you process customers' financial documents). Say plainly: contents are not stored.
- Don't promise HIPAA/SOC2 unless you've done it.

## Not built yet (honest roadmap)

- Batch endpoint with webhook delivery (needs Cloudflare Queues)
- Stripe self-serve billing
- Per-niche presets / custom fields

## Dev

```bash
npm test            # unit tests for the trust layer
npm run typecheck
npx wrangler dev
```
