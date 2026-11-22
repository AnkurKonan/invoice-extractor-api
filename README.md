# Invoice & Receipt Line-Item Extractor API

A ready-to-deploy **Vertical AI Wrapper** built on Cloudflare Workers.

Specialized for extracting structured data (vendor, dates, totals, line items, confidence scores) from invoices and receipts.

## Features

- Works with plain text **or** base64 images
- Strong specialized system prompt
- Structured JSON output with confidence + human-review flags
- Simple API key authentication
- Extremely cheap to run (Cloudflare Workers + Workers AI)
- CORS enabled

## Quick Start

1. Install Wrangler (if you don't have it):
   ```bash
   npm install -g wrangler
   ```

2. Login to Cloudflare:
   ```bash
   wrangler login
   ```

3. Deploy:
   ```bash
   wrangler deploy
   ```

4. (Recommended) Set a real API key:
   ```bash
   wrangler secret put API_KEY
   ```

## Usage

### Text input

```bash
curl -X POST https://your-worker.workers.dev \
  -H "Authorization: Bearer sk-test-123" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Invoice #INV-8842 from Acme Supplies\nDate: 2026-11-10\n2x Widget A @ $45.00 = $90.00\n1x Service Fee = $25.00\nSubtotal: $115.00\nTax: $9.20\nTotal: $124.20"
  }'
```

### Image input (base64)

```json
{
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAA..."
}
```

## Response Example

```json
{
  "vendor_name": "Acme Supplies",
  "invoice_number": "INV-8842",
  "invoice_date": "2026-11-10",
  "due_date": null,
  "currency": "USD",
  "subtotal": 115.0,
  "tax_amount": 9.2,
  "total_amount": 124.2,
  "po_number": null,
  "line_items": [
    {
      "line_number": 1,
      "description": "Widget A",
      "quantity": 2,
      "unit": null,
      "unit_price": 45.0,
      "line_total": 90.0
    },
    {
      "line_number": 2,
      "description": "Service Fee",
      "quantity": 1,
      "unit": null,
      "unit_price": 25.0,
      "line_total": 25.0
    }
  ],
  "confidence": "high",
  "needs_human_review": false,
  "review_reasons": []
}
```

## Next Steps (Recommended USPs)

- Switch the model to Cloudflare's specialized **Clairic** extraction model for higher accuracy + native confidence scores
- Add rate limiting
- Add usage tracking + simple billing
- Support PDF uploads
- Add batch endpoint + webhooks

## License

MIT — free to use and commercialize.
