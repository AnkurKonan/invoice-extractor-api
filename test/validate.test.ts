import { test } from "node:test";
import assert from "node:assert/strict";
import { toNumber, toDate, parseModelJson, normalize } from "../src/validate.ts";

test("toNumber handles messy money", () => {
  assert.equal(toNumber("$1,234.50"), 1234.5);
  assert.equal(toNumber("1.234,50"), 1234.5);
  assert.equal(toNumber("12,50"), 12.5);
  assert.equal(toNumber("1,234"), 1234);
  assert.equal(toNumber("(45.00)"), -45);
  assert.equal(toNumber("USD 99"), 99);
  assert.equal(toNumber("abc"), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(7), 7);
});

test("toDate validates real calendar dates", () => {
  assert.equal(toDate("2026-11-10"), "2026-11-10");
  assert.equal(toDate("2026/1/5"), "2026-01-05");
  assert.equal(toDate("2026-02-30"), null);
  assert.equal(toDate("10/11/2026"), null);
  assert.equal(toDate(null), null);
});

test("parseModelJson survives fences, chatter and objects", () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('Sure! Here you go: {"a":{"b":"}"}} hope that helps'), { a: { b: "}" } });
  assert.deepEqual(parseModelJson({ a: 2 }), { a: 2 });
  assert.throws(() => parseModelJson("no json here"));
});

const good = {
  vendor_name: "Acme Supplies", invoice_number: "INV-8842", invoice_date: "2026-11-10", due_date: null,
  currency: "usd", subtotal: 115, tax_amount: 9.2, total_amount: 124.2,
  line_items: [
    { description: "Widget A", quantity: 2, unit_price: 45, line_total: 90 },
    { description: "Service Fee", quantity: 1, unit_price: 25, line_total: 25 },
  ],
  confidence: "high", needs_human_review: false, review_reasons: [],
};

test("clean invoice -> high confidence, no review", () => {
  const r = normalize(good);
  assert.equal(r.confidence, "high");
  assert.equal(r.needs_human_review, false);
  assert.equal(r.currency, "USD");
  assert.equal(r.line_items[1].line_number, 2);
  assert.deepEqual(r.validation, { line_math_ok: true, subtotal_ok: true, total_ok: true });
});

test("model claims high but math is wrong -> we override", () => {
  const r = normalize({ ...good, total_amount: 150 });
  assert.notEqual(r.confidence, "high");
  assert.equal(r.needs_human_review, true);
  assert.equal(r.validation.total_ok, false);
});

test("string numbers + computed line_total", () => {
  const r = normalize({ ...good, subtotal: "$115.00", total_amount: "124.20", tax_amount: "9.20",
    line_items: [{ description: "A", quantity: "2", unit_price: "$45.00" }, { description: "B", quantity: 1, unit_price: 25, line_total: 25 }] });
  assert.equal(r.line_items[0].line_total, 90);
  assert.equal(r.confidence, "high");
});

test("missing total -> low + review", () => {
  const r = normalize({ ...good, total_amount: null });
  assert.equal(r.confidence, "low");
  assert.equal(r.needs_human_review, true);
});

test("empty / junk input never throws and demands review", () => {
  const r = normalize({});
  assert.equal(r.confidence, "low");
  assert.equal(r.needs_human_review, true);
  assert.deepEqual(r.line_items, []);
});

test("discount and shipping reconcile", () => {
  const r = normalize({ ...good, discount_amount: 15, shipping_amount: 10, total_amount: 119.2 });
  assert.equal(r.validation.total_ok, true);
});

test("bad date is flagged, not trusted", () => {
  const r = normalize({ ...good, invoice_date: "2026-13-45" });
  assert.equal(r.invoice_date, null);
  assert.ok(r.review_reasons.some((x) => x.includes("invoice_date")));
});
