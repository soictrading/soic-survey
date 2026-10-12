import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";

// Same verification as the SOIC CRM (soic-crm/src/worker/auth.ts).

/** Returns the key set used to verify Access tokens for a team domain. */
export type AccessKeyResolver = (teamDomain: string) => JWTVerifyGetKey;

const jwksByTeamDomain = new Map<string, JWTVerifyGetKey>();

/** Production resolver: Cloudflare Access public keys, cached per isolate by jose. */
export const remoteAccessKeys: AccessKeyResolver = (teamDomain) => {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
};

const TEAM_DOMAIN_PATTERN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type AuthErrorCode = "unauthenticated" | "auth_unavailable" | "server_misconfigured";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Establishes the caller's verified email address.
 * Staging/production: from the Cloudflare Access JWT (signature, issuer, audience, expiry verified).
 * Development: from DEV_USER_EMAIL, only on a local hostname.
 * Any other ENVIRONMENT value is refused.
 */
export async function resolveVerifiedEmail(
  request: Request,
  env: Env,
  accessKeys: AccessKeyResolver,
): Promise<string> {
  switch (env.ENVIRONMENT) {
    case "development": {
      const hostname = new URL(request.url).hostname;
      if (!LOCAL_HOSTNAMES.has(hostname)) {
        throw new AuthError("server_misconfigured", `development identity refused for host ${hostname}`);
      }
      if (!env.DEV_USER_EMAIL) {
        throw new AuthError("server_misconfigured", "DEV_USER_EMAIL is not set");
      }
      return normalizeEmail(env.DEV_USER_EMAIL);
    }
    case "staging":
    case "production": {
      const teamDomain = env.ACCESS_TEAM_DOMAIN;
      const audience = env.ACCESS_AUD;
      if (!teamDomain || !TEAM_DOMAIN_PATTERN.test(teamDomain)) {
        throw new AuthError("server_misconfigured", "ACCESS_TEAM_DOMAIN is missing or invalid");
      }
      if (!audience || !AUD_PATTERN.test(audience)) {
        throw new AuthError("server_misconfigured", "ACCESS_AUD is missing or invalid");
      }
      const token = request.headers.get("cf-access-jwt-assertion");
      if (!token) {
        throw new AuthError("unauthenticated", "missing Access token");
      }
      let email: unknown;
      try {
        const { payload } = await jwtVerify(token, accessKeys(teamDomain), {
          issuer: teamDomain,
          audience,
          algorithms: ["RS256"],
        });
        email = payload["email"];
      } catch (err) {
        if (err instanceof errors.JWKSTimeout) {
          throw new AuthError("auth_unavailable", "timed out fetching Access keys");
        }
        if (err instanceof errors.JOSEError) {
          throw new AuthError("unauthenticated", `invalid Access token (${err.code})`);
        }
        throw err;
      }
      if (typeof email !== "string" || email.trim() === "") {
        throw new AuthError("unauthenticated", "Access token has no email claim");
      }
      return normalizeEmail(email);
    }
    default:
      throw new AuthError("server_misconfigured", "ENVIRONMENT is missing or invalid");
  }
}

/** Whether the verified email is listed in ADMIN_EMAILS. */
export function isAdmin(env: Env, email: string): boolean {
  return (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map(normalizeEmail)
    .some((admin) => admin !== "" && admin === email);
}
