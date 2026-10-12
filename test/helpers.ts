import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createApp } from "../src/worker/app";
import type { AccessKeyResolver } from "../src/worker/auth";
import type { Env } from "../src/worker/env";
import { ModelError, type ModelCaller, type ModelRequest, type ModelResult } from "../src/worker/model";

export const TEAM_DOMAIN = "https://soic-test.cloudflareaccess.com";
export const AUD = "a".repeat(64);
export const STAGING_ORIGIN = "https://survey-staging.soictrading.online";
export const ADMIN = "mike.chartrand@soictrading.com";

const signingKeys = await generateKeyPair("RS256", { extractable: true });
const otherKeys = await generateKeyPair("RS256", { extractable: true });
const publicJwk: JWK = { ...(await exportJWK(signingKeys.publicKey)), kid: "test-key", alg: "RS256" };
const localJwks = createLocalJWKSet({ keys: [publicJwk] });

/** Key resolver used by tests in place of Cloudflare's certificate endpoint. */
export const testAccessKeys: AccessKeyResolver = (teamDomain) => {
  if (teamDomain !== TEAM_DOMAIN) throw new Error(`unexpected team domain ${teamDomain}`);
  return localJwks;
};

/** Stand-in for the language model: tests queue its answers and inspect what it was asked. */
export const fakeModel = {
  queue: [] as (ModelResult | ModelError)[],
  requests: [] as ModelRequest[],
  reset(): void {
    this.queue = [];
    this.requests = [];
  },
  replyText(text: string): void {
    this.queue.push({ kind: "text", text, truncated: false });
  },
  replyTool(input: unknown, truncated = false): void {
    this.queue.push({ kind: "tool", input, truncated });
  },
  fail(code: ModelError["code"]): void {
    this.queue.push(new ModelError(code, "test failure"));
  },
};

const testModel: ModelCaller = (_env, request) => {
  fakeModel.requests.push(request);
  const next = fakeModel.queue.shift();
  if (!next) return Promise.reject(new Error("fake model has no queued answer"));
  return next instanceof ModelError ? Promise.reject(next) : Promise.resolve(next);
};

export const app = createApp({ accessKeys: testAccessKeys, model: testModel });

export function stagingEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    ASSETS: env.ASSETS,
    ENVIRONMENT: "staging",
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: ADMIN,
    ANTHROPIC_MODEL: "claude-test-model",
    ...overrides,
  };
}

interface TokenOptions {
  email?: string | undefined;
  audience?: string;
  issuer?: string;
  expiresIn?: string | number;
  signWith?: "valid" | "other";
}

export async function accessToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { type: "app" };
  if (options.email !== undefined) claims["email"] = options.email;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(options.issuer ?? TEAM_DOMAIN)
    .setAudience(options.audience ?? AUD)
    .setSubject(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m");
  const key = options.signWith === "other" ? otherKeys.privateKey : signingKeys.privateKey;
  return jwt.sign(key);
}

export function newEmail(): string {
  return `person-${crypto.randomUUID()}@soictrading.com`;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

/** JSON API call as the given person (staging-style Access authentication). */
export async function api<T = unknown>(
  email: string,
  method: string,
  path: string,
  body?: unknown,
  envOverrides: Partial<Env> = {},
): Promise<ApiResult<T>> {
  const headers = new Headers({ "cf-access-jwt-assertion": await accessToken({ email }) });
  const init: RequestInit = { method, headers };
  // Like the web client: every state-changing request carries a JSON body.
  if (method !== "GET") {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body ?? {});
  }
  const res = await app.request(`${STAGING_ORIGIN}${path}`, init, stagingEnv(envOverrides));
  return { status: res.status, body: await res.json<T>() };
}

export const VALID_TOOL_INPUT = {
  examples: "Last week's kraft liner offer",
  steps: [
    { what: "Read the sourcer's email", tool: "Outlook", who: "Sebastian", info: "Grade, tonnage", time: "" },
    { what: "Ask two buyers", tool: "WhatsApp", who: "", info: "", time: "1 day" },
  ],
  variations: ["Different for Brazil"],
  pain_points: ["Waiting for freight quotes"],
};
