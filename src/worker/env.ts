export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** "development" | "staging" | "production". Anything else is refused. */
  ENVIRONMENT: string;
  /** e.g. https://<team>.cloudflareaccess.com — required in staging and production. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application audience (AUD) tag — required in staging and production. */
  ACCESS_AUD?: string;
  /** Local development identity. Honoured only when ENVIRONMENT is "development" and the host is local. */
  DEV_USER_EMAIL?: string;
  /** Comma-separated emails that may see everyone's interviews. */
  ADMIN_EMAILS?: string;
  /** Anthropic model id used for the interviewer and the write-ups. */
  ANTHROPIC_MODEL?: string;
  /** Secret. Set with `wrangler secret put ANTHROPIC_API_KEY --env production`; never in wrangler.jsonc. */
  ANTHROPIC_API_KEY?: string;
}
