import { errors } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/worker/app";
import type { ApiErrorBody, Me } from "../src/shared/types";
import { AUD, STAGING_ORIGIN, TEAM_DOMAIN, accessToken, app, newEmail, stagingEnv } from "./helpers";

async function getMe(token: string | null, envOverrides = {}, origin = STAGING_ORIGIN) {
  const headers = new Headers();
  if (token !== null) headers.set("cf-access-jwt-assertion", token);
  return app.request(`${origin}/api/me`, { headers }, stagingEnv(envOverrides));
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json<ApiErrorBody>()).error.code;
}

describe("Access authentication (staging/production)", () => {
  it("accepts a valid token and identifies the person by their lower-cased email", async () => {
    const email = newEmail();
    const res = await getMe(await accessToken({ email: email.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(await res.json<Me>()).toEqual({ email, isAdmin: false, interview: null });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  });

  it("works identically for the production environment", async () => {
    const res = await getMe(await accessToken({ email: newEmail() }), { ENVIRONMENT: "production" });
    expect(res.status).toBe(200);
  });

  it("rejects missing, malformed, wrongly signed, wrong-audience, wrong-issuer and expired tokens", async () => {
    const email = newEmail();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const tokens = [
      null,
      "not-a-jwt",
      await accessToken({ email, signWith: "other" }),
      await accessToken({ email, audience: "b".repeat(64) }),
      await accessToken({ email, issuer: "https://attacker.cloudflareaccess.com" }),
      await accessToken({ email, expiresIn: past }),
      await accessToken({ email: undefined }),
    ];
    for (const [i, token] of tokens.entries()) {
      const res = await getMe(token);
      expect(res.status, `token ${i}`).toBe(401);
      expect(await errorCode(res)).toBe("unauthenticated");
    }
  });

  it("rejects an HS256 token even when it carries valid claims", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ email: newEmail() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEAM_DOMAIN)
      .setAudience(AUD)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect((await getMe(token)).status).toBe(401);
  });

  it("returns 503 when Access keys cannot be fetched in time", async () => {
    const timingOutApp = createApp({
      accessKeys: () => () => Promise.reject(new errors.JWKSTimeout()),
      model: () => Promise.reject(new Error("not used")),
    });
    const headers = { "cf-access-jwt-assertion": await accessToken({ email: newEmail() }) };
    const res = await timingOutApp.request(`${STAGING_ORIGIN}/api/me`, { headers }, stagingEnv());
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("auth_unavailable");
  });
});

describe("configuration fails closed", () => {
  it("refuses to run with placeholder Access configuration", async () => {
    const token = await accessToken({ email: newEmail() });
    for (const overrides of [
      { ACCESS_TEAM_DOMAIN: "REPLACE_WITH_TEAM_DOMAIN" },
      { ACCESS_AUD: "REPLACE_WITH_STAGING_APPLICATION_AUD" },
      { ACCESS_TEAM_DOMAIN: undefined },
      { ACCESS_AUD: undefined },
      { ACCESS_TEAM_DOMAIN: "http://soic-test.cloudflareaccess.com" },
    ]) {
      const res = await getMe(token, overrides);
      expect(res.status, JSON.stringify(overrides)).toBe(500);
      expect(await errorCode(res)).toBe("server_misconfigured");
    }
  });

  it("refuses an unknown or missing ENVIRONMENT", async () => {
    const token = await accessToken({ email: newEmail() });
    for (const ENVIRONMENT of ["", "prod", "Production", "test"]) {
      expect((await getMe(token, { ENVIRONMENT })).status, ENVIRONMENT).toBe(500);
    }
  });
});

describe("development identity", () => {
  it("is used on localhost when ENVIRONMENT is development", async () => {
    const email = newEmail();
    const res = await getMe(null, { ENVIRONMENT: "development", DEV_USER_EMAIL: email }, "http://localhost:8787");
    expect(res.status).toBe(200);
    expect((await res.json<Me>()).email).toBe(email);
  });

  it("is refused on a non-local host, or without DEV_USER_EMAIL", async () => {
    expect((await getMe(null, { ENVIRONMENT: "development", DEV_USER_EMAIL: newEmail() })).status).toBe(500);
    expect((await getMe(null, { ENVIRONMENT: "development" }, "http://localhost:8787")).status).toBe(500);
  });

  it("is ignored in staging and production", async () => {
    for (const ENVIRONMENT of ["staging", "production"]) {
      const res = await getMe(null, { ENVIRONMENT, DEV_USER_EMAIL: newEmail() }, "http://localhost:8787");
      expect(res.status, ENVIRONMENT).toBe(401);
    }
  });
});
