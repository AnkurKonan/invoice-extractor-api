export interface Env {
  AI: any;
  API_KEY?: string;
}

const SYSTEM_PROMPT = `You are an expert accounts-payable invoice and receipt extraction engine.

Rules:
- Extract ONLY what is clearly present in the document. Never invent or guess values.
- If a field is missing or unclear, return null.
- Always return valid JSON only. No markdown, no explanation.
- Calculate line totals when quantity and unit_price are available.
- Prefer the grand total that includes tax.
- Detect currency if possible (default to USD if unclear).
- Flag low-confidence extractions.

Return exactly this JSON structure:
{
  "vendor_name": string | null,
  "invoice_number": string | null,
  "invoice_date": "YYYY-MM-DD" | null,
  "due_date": "YYYY-MM-DD" | null,
  "currency": string | null,
  "subtotal": number | null,
  "tax_amount": number | null,
  "total_amount": number | null,
  "po_number": string | null,
  "line_items": [
    {
      "description": string,
      "quantity": number | null,
      "unit": string | null,
      "unit_price": number | null,
      "line_total": number | null
    }
  ],
  "confidence": "high" | "medium" | "low",
  "needs_human_review": boolean,
  "review_reasons": string[]
}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Only POST allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Simple API key protection
    const authHeader = request.headers.get("Authorization");
    const expectedKey = env.API_KEY || "sk-test-123"; // Change this in production!

    if (!authHeader || authHeader !== `Bearer ${expectedKey}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = (await request.json()) as {
        text?: string;
        image_base64?: string;
        model?: string;
      };

      if (!body.text && !body.image_base64) {
        return new Response(
          JSON.stringify({ error: "Provide either 'text' or 'image_base64'" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // Default to a strong model available on Workers AI
      const model = body.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

      const messages: any[] = [
        { role: "system", content: SYSTEM_PROMPT },
      ];

      if (body.image_base64) {
        messages.push({
          role: "user",
          content: [
            {
              type: "image",
              image: body.image_base64.startsWith("data:")
                ? body.image_base64
                : `data:image/jpeg;base64,${body.image_base64}`,
            },
            {
              type: "text",
              text: "Extract all structured data from this invoice/receipt image.",
            },
          ],
        });
      } else {
        messages.push({
          role: "user",
          content: `Extract structured data from this invoice/receipt text:\n\n${body.text}`,
        });
      }

      const response = await env.AI.run(model, {
        messages,
        max_tokens: 2048,
        temperature: 0.1, // low temperature for more consistent extraction
      });

      // Parse the response
      let result: any;
      try {
        const raw =
          typeof response === "string"
            ? response
            : (response as any).response || response;
        // Clean possible markdown wrappers
        const cleaned = String(raw)
          .replace(/```json/gi, "")
          .replace(/```/g, "")
          .trim();
        result = JSON.parse(cleaned);
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: "Failed to parse model output",
            raw: response,
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      // Add line numbers for convenience
      if (result.line_items && Array.isArray(result.line_items)) {
        result.line_items = result.line_items.map((item: any, idx: number) => ({
          line_number: idx + 1,
          ...item,
        }));
      }

      return new Response(JSON.stringify(result, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err.message || "Internal error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
