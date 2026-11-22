// Pure functions (no imports) so they can be unit-tested with plain Node.
// This is the "trust layer": we never believe the LLM's own confidence score.
// We re-check the arithmetic ourselves and decide whether a human must review.

export interface LineItem {
  line_number: number;
  description: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
}

export interface Extraction {
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  po_number: string | null;
  line_items: LineItem[];
  confidence: "high" | "medium" | "low";
  needs_human_review: boolean;
  review_reasons: string[];
  validation: {
    line_math_ok: boolean | null;
    subtotal_ok: boolean | null;
    total_ok: boolean | null;
  };
}

const MAX_LINES = 500;

export function toStr(v: unknown, max = 300): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || /^(null|n\/a|none|unknown)$/i.test(s)) return null;
  return s.slice(0, max);
}

/** Accepts 12.5, "12.50", "$1,234.50", "1.234,50", "(45.00)" -> number | null */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? clean(v) : null;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/-\s*$/.test(s)) negative = true;
  if (/^\s*-/.test(s)) negative = true;
  s = s.replace(/[^0-9.,]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // whichever separator comes last is the decimal separator
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // "1,234" -> thousands ; "12,50" -> decimal
    const after = s.length - lastComma - 1;
    s = after === 3 && s.indexOf(",") === lastComma && lastComma > 0 && !/^0,/.test(s) ? s.replace(/,/g, "") : s.replace(/,/g, ".");
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  } else if ((s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return clean(negative ? -n : n);
}

function clean(n: number): number {
  return Number(n.toFixed(4));
}

/** Returns a valid YYYY-MM-DD or null. */
export function toDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Pull a JSON object out of whatever the model returned. */
export function parseModelJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") throw new Error("model returned no JSON");
  let s = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    const direct = JSON.parse(s);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct;
  } catch {
    /* fall through to balanced scan */
  }
  const start = s.indexOf("{");
  if (start < 0) throw new Error("model returned no JSON object");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const obj = JSON.parse(s.slice(start, i + 1));
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
        break;
      }
    }
  }
  throw new Error("model returned malformed JSON");
}

const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(0.02, 0.001 * Math.max(Math.abs(a), Math.abs(b)));

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function normalize(raw: Record<string, unknown>): Extraction {
  const reasons: string[] = [];
  let major = 0;

  // ---- line items
  const rawLines = Array.isArray(raw.line_items) ? raw.line_items.slice(0, MAX_LINES) : [];
  const lines: LineItem[] = [];
  for (const r of rawLines) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const description = toStr(o.description, 500) ?? "";
    const quantity = toNumber(o.quantity);
    const unit_price = toNumber(o.unit_price);
    let line_total = toNumber(o.line_total);
    if (!description && quantity === null && unit_price === null && line_total === null) continue;
    if (line_total === null && quantity !== null && unit_price !== null) {
      line_total = round2(quantity * unit_price);
    }
    lines.push({
      line_number: lines.length + 1,
      description,
      quantity,
      unit: toStr(o.unit, 30),
      unit_price,
      line_total,
    });
  }

  // ---- header fields
  const dateField = (key: string): string | null => {
    const parsed = toDate(raw[key]);
    if (parsed === null && toStr(raw[key]) !== null) reasons.push(`${key} could not be read as a valid date`);
    return parsed;
  };
  const currencyRaw = toStr(raw.currency, 10);
  const currency = currencyRaw && /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null;

  const out: Extraction = {
    vendor_name: toStr(raw.vendor_name),
    invoice_number: toStr(raw.invoice_number, 100),
    invoice_date: dateField("invoice_date"),
    due_date: dateField("due_date"),
    currency,
    subtotal: toNumber(raw.subtotal),
    discount_amount: toNumber(raw.discount_amount),
    shipping_amount: toNumber(raw.shipping_amount),
    tax_amount: toNumber(raw.tax_amount),
    total_amount: toNumber(raw.total_amount),
    po_number: toStr(raw.po_number, 100),
    line_items: lines,
    confidence: "medium",
    needs_human_review: false,
    review_reasons: [],
    validation: { line_math_ok: null, subtotal_ok: null, total_ok: null },
  };

  // ---- deterministic checks
  if (out.total_amount === null) {
    reasons.push("No total amount found");
    major++;
  }
  if (lines.length === 0) {
    reasons.push("No line items found");
    major++;
  }
  if (!out.vendor_name) reasons.push("Vendor name not found");
  if (!out.invoice_number) reasons.push("Invoice number not found");

  // line math: qty * unit_price == line_total
  const checkable = lines.filter((l) => l.quantity !== null && l.unit_price !== null && l.line_total !== null);
  if (checkable.length) {
    const bad = checkable.filter((l) => !close(l.quantity! * l.unit_price!, l.line_total!));
    out.validation.line_math_ok = bad.length === 0;
    if (bad.length) {
      reasons.push(`Line ${bad.map((b) => b.line_number).join(", ")}: quantity x unit price does not equal line total`);
      if (bad.length > 1) major++;
    }
  }

  // subtotal vs sum of lines
  const lineTotals = lines.map((l) => l.line_total);
  const allLinesHaveTotals = lines.length > 0 && lineTotals.every((t) => t !== null);
  const sumLines = allLinesHaveTotals ? round2(lineTotals.reduce((a, b) => a + (b as number), 0)) : null;
  if (out.subtotal !== null && sumLines !== null) {
    out.validation.subtotal_ok = close(out.subtotal, sumLines);
    if (!out.validation.subtotal_ok) {
      reasons.push(`Sum of line items (${sumLines}) does not match subtotal (${out.subtotal})`);
      major++;
    }
  }

  // total = subtotal - discount + shipping + tax
  const base = out.subtotal ?? sumLines;
  if (out.total_amount !== null && base !== null) {
    const expected = round2(base - Math.abs(out.discount_amount ?? 0) + (out.shipping_amount ?? 0) + (out.tax_amount ?? 0));
    out.validation.total_ok = close(expected, out.total_amount);
    if (!out.validation.total_ok) {
      reasons.push(`Total (${out.total_amount}) does not equal subtotal - discount + shipping + tax (${expected})`);
      major++;
    }
  }

  // ---- merge with the model's own opinion (it can only make things stricter)
  const modelLevel = ({ high: 2, medium: 1, low: 0 } as Record<string, number>)[String(raw.confidence).toLowerCase()] ?? 1;
  let level = modelLevel;
  if (reasons.length) level = Math.min(level, 1);
  if (major >= 2 || out.total_amount === null) level = 0;
  out.confidence = (["low", "medium", "high"] as const)[level];

  const modelReasons = Array.isArray(raw.review_reasons)
    ? raw.review_reasons.map((r) => toStr(r, 200)).filter((r): r is string => !!r).slice(0, 10)
    : [];
  const merged = [...reasons];
  for (const r of modelReasons) if (!merged.includes(r)) merged.push(r);
  out.review_reasons = merged;
  out.needs_human_review = merged.length > 0 || out.confidence !== "high" || raw.needs_human_review === true;
  return out;
}
