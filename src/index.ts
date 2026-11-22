import type { Env, Principal } from "./types";
import { PLANS, authenticate, currentPeriod, enforceRateLimit, getUsage, refundQuota, reserveQuota } from "./auth";
import { DEFAULT_TEXT_MODEL, acceptVisionLicense, explainResult, extractDocument, type DocInput } from "./extract";
import { HttpError, corsHeaders, decodeBase64, detectFileKind, jsonResponse, randomHex, safeEqual, sha256Hex } from "./util";
import { normalize } from "./validate";

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const res = await route(request, env, ctx, requestId);
      res.headers.set("X-Request-Id", requestId);
      return res;
    } catch (e) {
      if (e instanceof HttpError) {
        return jsonResponse(env, { error: { code: e.code, message: e.message }, request_id: requestId }, e.status, { "X-Request-Id": requestId, ...e.headers });
      }
      console.error("unhandled", requestId, (e as Error)?.name, (e as Error)?.message?.slice(0, 200));
      return jsonResponse(env, { error: { code: "internal_error", message: "Something went wrong on our side." }, request_id: requestId }, 500, { "X-Request-Id": requestId });
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });

  if (method === "GET" && (path === "/" || path === "/health")) {
    return jsonResponse(env, {
      service: "invoice-extractor-api",
      status: "ok",
      endpoints: ["POST /v1/extract", "POST /v1/explain", "GET /v1/usage"],
    });
  }

  if (path.startsWith("/admin")) return admin(request, env, path, method);

  if (path === "/v1/extract" || path === "/") {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { Allow: "POST, OPTIONS" });
    return extract(request, env, ctx, requestId);
  }
  if (path === "/v1/explain") {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.", { Allow: "POST, OPTIONS" });
    return explain(request, env, ctx, requestId);
  }
  if (path === "/v1/usage") {
    if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.", { Allow: "GET, OPTIONS" });
    const p = await authenticate(request, env);
    const u = await getUsage(env, p);
    return jsonResponse(env, { plan: p.plan, period: currentPeriod(), used: u.used, limit: u.limit, remaining: u.limit === null ? null : Math.max(u.limit - u.used, 0), rate_limit_per_min: p.ratePerMin });
  }
  throw new HttpError(404, "not_found", "Unknown endpoint.");
}

async function readJson(request: Request): Promise<Record<string, any>> {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Send Content-Type: application/json.");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large (max 12 MB).");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body too large (max 12 MB).");
  try {
    const body = JSON.parse(new TextDecoder().decode(buf));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function resolveInput(body: Record<string, any>): { input: DocInput; type: string; bytes: number } {
  const file = body.file_base64 ?? body.image_base64; // image_base64 kept for backward compatibility
  const hasText = body.text !== undefined && body.text !== null;
  if (hasText && file) throw new HttpError(400, "invalid_request", "Provide only one of 'text' or 'file_base64'.");
  if (!hasText && !file) throw new HttpError(400, "invalid_request", "Provide 'text' or 'file_base64' (PDF, PNG, JPEG or WEBP).");

  if (hasText) {
    if (typeof body.text !== "string") throw new HttpError(400, "invalid_request", "'text' must be a string.");
    const text = body.text.trim();
    if (text.length < 10) throw new HttpError(400, "invalid_request", "'text' is too short to be an invoice.");
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, "payload_too_large", `'text' exceeds ${MAX_TEXT_CHARS} characters.`);
    return { input: { kind: "text", text }, type: "text", bytes: text.length };
  }

  if (typeof file !== "string") throw new HttpError(400, "invalid_request", "'file_base64' must be a string.");
  const bytes = decodeBase64(file);
  const kind = detectFileKind(bytes);
  if (!kind) throw new HttpError(415, "unsupported_file_type", "Unsupported file. Use PDF, PNG, JPEG or WEBP.");
  if (kind === "pdf") {
    if (bytes.length > MAX_PDF_BYTES) throw new HttpError(413, "payload_too_large", "PDF exceeds 8 MB.");
    return { input: { kind: "pdf", bytes }, type: "pdf", bytes: bytes.length };
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "payload_too_large", "Image exceeds 5 MB.");
  return { input: { kind: "image", fileKind: kind, bytes }, type: kind, bytes: bytes.length };
}

function audit(env: Env, ctx: ExecutionContext, row: { id: string; p: Principal; endpoint: string; status: number; started: number; type?: string; bytes?: number; confidence?: string; review?: boolean }) {
  ctx.waitUntil(
    env.DB.prepare(
      "INSERT INTO audit_log (id, ts, key_id, endpoint, status, latency_ms, input_type, input_bytes, confidence, needs_review) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(row.id, new Date().toISOString(), row.p.id, row.endpoint, row.status, Date.now() - row.started, row.type ?? null, row.bytes ?? null, row.confidence ?? null, row.review === undefined ? null : row.review ? 1 : 0)
      .run()
      .then(() => undefined, () => undefined)
  );
}

function quotaHeaders(q: { used: number; limit: number | null }): Record<string, string> {
  return q.limit === null ? {} : { "X-Quota-Limit": String(q.limit), "X-Quota-Remaining": String(Math.max(q.limit - q.used, 0)) };
}

async function extract(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const started = Date.now();
  const p = await authenticate(request, env);
  await enforceRateLimit(env, p, ctx);
  const { input, type, bytes } = resolveInput(await readJson(request)); // bad requests are free
  const quota = await reserveQuota(env, p);

  try {
    const { parsed, model } = await extractDocument(env, input);
    const result = normalize(parsed);
    audit(env, ctx, { id: requestId, p, endpoint: "extract", status: 200, started, type, bytes, confidence: result.confidence, review: result.needs_human_review });
    return jsonResponse(env, { ...result, meta: { request_id: requestId, model, input_type: type, processing_ms: Date.now() - started } }, 200, quotaHeaders(quota));
  } catch (e) {
    await refundQuota(env, p); // our failure, not the customer's
    audit(env, ctx, { id: requestId, p, endpoint: "extract", status: e instanceof HttpError ? e.status : 500, started, type, bytes });
    throw e;
  }
}

async function explain(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const started = Date.now();
  const p = await authenticate(request, env);
  await enforceRateLimit(env, p, ctx);
  const body = await readJson(request);
  if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
    throw new HttpError(400, "invalid_request", "Provide 'result': the JSON object returned by /v1/extract.");
  }
  if (JSON.stringify(body.result).length > 40_000) throw new HttpError(413, "payload_too_large", "'result' is too large.");
  const quota = await reserveQuota(env, p);
  try {
    const { explanation, model } = await explainResult(env, body.result);
    audit(env, ctx, { id: requestId, p, endpoint: "explain", status: 200, started });
    return jsonResponse(env, { explanation, meta: { request_id: requestId, model, processing_ms: Date.now() - started } }, 200, quotaHeaders(quota));
  } catch (e) {
    await refundQuota(env, p);
    audit(env, ctx, { id: requestId, p, endpoint: "explain", status: e instanceof HttpError ? e.status : 500, started });
    throw e;
  }
}

// ---------------------------------------------------------------- admin (you, the owner)
async function admin(request: Request, env: Env, path: string, method: string): Promise<Response> {
  const header = request.headers.get("Authorization") || "";
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1];
  // 404 (not 401) when unset or wrong so the admin surface is invisible to scanners.
  if (!env.ADMIN_TOKEN || !token || !(await safeEqual(token, env.ADMIN_TOKEN))) throw new HttpError(404, "not_found", "Unknown endpoint.");

  if (path === "/admin/keys" && method === "POST") {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 200) : "";
    const plan = typeof body.plan === "string" ? body.plan : "free";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "invalid_request", "A valid 'email' is required.");
    const defaults = PLANS[plan];
    if (!defaults) throw new HttpError(400, "invalid_request", `Unknown plan. Use one of: ${Object.keys(PLANS).join(", ")}.`);
    const quota = Number.isInteger(body.monthly_quota) && body.monthly_quota > 0 ? body.monthly_quota : defaults.quota;
    const key = `ik_live_${randomHex(24)}`;
    const prefix = key.slice(0, 20);
    await env.DB.prepare("INSERT INTO api_keys (key_hash, key_prefix, email, plan, monthly_quota, rate_per_min, active, created_at) VALUES (?,?,?,?,?,?,1,?)")
      .bind(await sha256Hex(key), prefix, email, plan, quota, defaults.rate, new Date().toISOString())
      .run();
    return jsonResponse(env, { api_key: key, key_prefix: prefix, email, plan, monthly_quota: quota, note: "Store this now. It cannot be shown again." }, 201);
  }

  if (path === "/admin/keys" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT k.key_prefix, k.email, k.plan, k.monthly_quota, k.active, k.created_at, COALESCE(u.calls, 0) AS used_this_month " +
        "FROM api_keys k LEFT JOIN usage u ON u.key_id = k.key_hash AND u.period = ? ORDER BY k.created_at DESC LIMIT 500"
    ).bind(currentPeriod()).all();
    return jsonResponse(env, { keys: results });
  }

  if (path === "/admin/keys/revoke" && method === "POST") {
    const body = await readJson(request);
    if (typeof body.key_prefix !== "string" || body.key_prefix.length < 20) throw new HttpError(400, "invalid_request", "Provide the full 20-character 'key_prefix'.");
    const r = await env.DB.prepare("UPDATE api_keys SET active = 0 WHERE key_prefix = ?").bind(body.key_prefix).run();
    return jsonResponse(env, { revoked: (r.meta?.changes ?? 0) > 0 });
  }

  if (path === "/admin/vision-agree" && method === "POST") {
    await acceptVisionLicense(env);
    return jsonResponse(env, { ok: true, note: `Vision licence accepted. Text model is ${env.TEXT_MODEL || DEFAULT_TEXT_MODEL}.` });
  }

  throw new HttpError(404, "not_found", "Unknown endpoint.");
}
