export interface Env {
  AI: Ai;
  DB: D1Database;
  /** Secret. Required to use /admin/* endpoints (issue and revoke customer keys). */
  ADMIN_TOKEN?: string;
  /** Secret. Set this if you list the API on RapidAPI (they handle billing for you). */
  RAPIDAPI_PROXY_SECRET?: string;
  /** Optional overrides */
  TEXT_MODEL?: string;
  VISION_MODEL?: string;
  ALLOWED_ORIGIN?: string;
}

export interface Principal {
  /** stable id used for metering (hash of the key, or "rapidapi:<user>") */
  id: string;
  label: string;
  plan: string;
  /** monthly call limit; null = unmetered here (billing handled elsewhere) */
  quota: number | null;
  ratePerMin: number;
}
