import type { Env, Principal } from "./types";
import { HttpError, safeEqual, sha256Hex } from "./util";

/** Suggested plans. Edit freely. Quotas are stored per key, so you can also customize per customer. */
export const PLANS: Record<string, { quota: number; rate: number }> = {
  free: { quota: 50, rate: 10 },
  starter: { quota: 1_000, rate: 60 },
  pro: { quota: 10_000, rate: 120 },
  scale: { quota: 100_000, rate: 300 },
};

const UNLIMITED = 1e12;

export const currentPeriod = (): string => new Date().toISOString().slice(0, 7);

export async function authenticate(request: Request, env: Env): Promise<Principal> {
  // RapidAPI marketplace: they authenticate/bill the customer and forward a shared secret.
  const proxy = request.headers.get("X-RapidAPI-Proxy-Secret");
  if (proxy) {
    if (env.RAPIDAPI_PROXY_SECRET && (await safeEqual(proxy, env.RAPIDAPI_PROXY_SECRET))) {
      const user = (request.headers.get("X-RapidAPI-User") || "unknown").slice(0, 64);
      return { id: `rapidapi:${user}`, label: `rapidapi:${user}`, plan: "rapidapi", quota: null, ratePerMin: 120 };
    }
    throw new HttpError(401, "unauthorized", "Invalid proxy secret.");
  }

  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  const key = m ? m[1] : request.headers.get("X-API-Key")?.trim();
  if (!key) throw new HttpError(401, "unauthorized", "Missing API key. Send 'Authorization: Bearer <key>'.", { "WWW-Authenticate": "Bearer" });

  const hash = await sha256Hex(key);
  const row = await env.DB.prepare(
    "SELECT key_hash, key_prefix, plan, monthly_quota, rate_per_min FROM api_keys WHERE key_hash = ? AND active = 1"
  ).bind(hash).first<{ key_hash: string; key_prefix: string; plan: string; monthly_quota: number; rate_per_min: number }>();
  if (!row) throw new HttpError(401, "unauthorized", "Invalid or revoked API key.", { "WWW-Authenticate": "Bearer" });

  return { id: row.key_hash, label: row.key_prefix, plan: row.plan, quota: row.monthly_quota, ratePerMin: row.rate_per_min };
}

export async function enforceRateLimit(env: Env, p: Principal, ctx: ExecutionContext): Promise<void> {
  const win = Math.floor(Date.now() / 60_000);
  const row = await env.DB.prepare(
    "INSERT INTO rate_window (key_id, win, hits) VALUES (?, ?, 1) " +
      "ON CONFLICT(key_id, win) DO UPDATE SET hits = hits + 1 WHERE hits < ? RETURNING hits"
  ).bind(p.id, win, p.ratePerMin).first();
  if (Math.random() < 0.01) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_window WHERE win < ?").bind(win - 10).run().then(() => undefined, () => undefined));
  }
  if (!row) {
    const retry = 60 - (Math.floor(Date.now() / 1000) % 60);
    throw new HttpError(429, "rate_limited", `Rate limit of ${p.ratePerMin}/min exceeded.`, { "Retry-After": String(retry) });
  }
}

/** Atomically reserve one call. Fails (429) if the monthly quota is used up. */
export async function reserveQuota(env: Env, p: Principal): Promise<{ used: number; limit: number | null }> {
  const limit = p.quota ?? UNLIMITED;
  const row = await env.DB.prepare(
    "INSERT INTO usage (key_id, period, calls) VALUES (?, ?, 1) " +
      "ON CONFLICT(key_id, period) DO UPDATE SET calls = calls + 1 WHERE calls < ? RETURNING calls"
  ).bind(p.id, currentPeriod(), limit).first<{ calls: number }>();
  if (!row) {
    throw new HttpError(429, "quota_exceeded", `Monthly quota of ${p.quota} calls used up. Upgrade your plan to continue.`, {
      "X-Quota-Limit": String(p.quota),
      "X-Quota-Remaining": "0",
    });
  }
  return { used: row.calls, limit: p.quota };
}

/** Give the call back when WE failed (model error etc). Customers never pay for our failures. */
export async function refundQuota(env: Env, p: Principal): Promise<void> {
  try {
    await env.DB.prepare("UPDATE usage SET calls = MAX(calls - 1, 0) WHERE key_id = ? AND period = ?").bind(p.id, currentPeriod()).run();
  } catch {
    /* best effort */
  }
}

export async function getUsage(env: Env, p: Principal): Promise<{ used: number; limit: number | null }> {
  const row = await env.DB.prepare("SELECT calls FROM usage WHERE key_id = ? AND period = ?").bind(p.id, currentPeriod()).first<{ calls: number }>();
  return { used: row?.calls ?? 0, limit: p.quota };
}
