import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { LANGS, LIMITS, PARTS, type Me, type Part } from "../shared/types";
import { AuthError, isAdmin, normalizeEmail, resolveVerifiedEmail, type AccessKeyResolver } from "./auth";
import { errorResponse, HttpError, readBody, type AppEnv } from "./http";
import {
  WriteupInput,
  answer,
  askInterviewer,
  confirm,
  createInterview,
  createWriteup,
  finish,
  listInterviews,
  loadInterview,
  reopen,
  saveWriteup,
  type InterviewDeps,
} from "./interviews";
import { log } from "./log";
import { ModelError, type ModelCaller } from "./model";

const AUTH_ERROR_STATUS = {
  unauthenticated: 401,
  auth_unavailable: 503,
  server_misconfigured: 500,
} as const satisfies Record<AuthError["code"], ContentfulStatusCode>;

const MODEL_ERROR_STATUS = {
  model_unavailable: 503,
  model_failed: 502,
  server_misconfigured: 500,
} as const satisfies Record<ModelError["code"], ContentfulStatusCode>;

const StartBody = z.strictObject({ lang: z.enum(LANGS) });
const AnswerBody = z.strictObject({ text: z.string().trim().min(1).max(LIMITS.answerChars) });
const VersionBody = z.strictObject({ version: z.number().int().min(1) });
const WriteupBody = z.strictObject({
  version: z.number().int().min(1),
  writeup: WriteupInput,
  corrections: z.string().max(LIMITS.correctionsChars),
});
const EmailParam = z.string().max(320).transform(normalizeEmail);

function partParam(value: string): Part {
  const part = PARTS.find((p) => p === value);
  if (!part) throw new HttpError(404, "not_found");
  return part;
}

export interface AppDependencies {
  accessKeys: AccessKeyResolver;
  model: ModelCaller;
}

export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Request id, and headers that apply to every API response.
  app.use("/api/*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.header("X-Request-Id", c.get("requestId"));
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  });

  // Authentication: every API request carries a verified identity, or stops here.
  app.use("/api/*", async (c, next) => {
    try {
      c.set("email", await resolveVerifiedEmail(c.req.raw, c.env, deps.accessKeys));
    } catch (err) {
      if (err instanceof AuthError) {
        log(err.code === "unauthenticated" ? "warn" : "error", "auth_failed", {
          requestId: c.get("requestId"),
          code: err.code,
          reason: err.message,
        });
        return errorResponse(c.get("requestId"), AUTH_ERROR_STATUS[err.code], err.code);
      }
      throw err;
    }
    await next();
  });

  // State-changing API requests must be JSON. This also blocks cross-site
  // "simple" form posts, which cannot carry an application/json content type.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const contentType = c.req.header("content-type") ?? "";
      if (!/^application\/json(;|$)/i.test(contentType)) {
        return errorResponse(c.get("requestId"), 415, "unsupported_media_type");
      }
    }
    await next();
  });

  const interviewDeps = (c: Context<AppEnv>): InterviewDeps => ({
    db: c.env.DB,
    env: c.env,
    model: deps.model,
    requestId: c.get("requestId"),
  });

  app.get("/api/me", async (c) => {
    const email = c.get("email");
    const body: Me = { email, isAdmin: isAdmin(c.env, email), interview: await loadInterview(c.env.DB, email) };
    return c.json(body);
  });

  // The person's own interview. Every route acts on the signed-in person's email only.
  app.post("/api/interview", async (c) => {
    const { lang } = await readBody(c, StartBody);
    return c.json(await createInterview(c.env.DB, c.get("email"), lang), 201);
  });

  app.post("/api/interview/parts/:part/ask", async (c) =>
    c.json(await askInterviewer(interviewDeps(c), c.get("email"), partParam(c.req.param("part")))),
  );

  app.post("/api/interview/parts/:part/answer", async (c) => {
    const part = partParam(c.req.param("part"));
    const { text } = await readBody(c, AnswerBody);
    return c.json(await answer(interviewDeps(c), c.get("email"), part, text));
  });

  app.post("/api/interview/parts/:part/finish", async (c) =>
    c.json(await finish(c.env.DB, c.get("email"), partParam(c.req.param("part")))),
  );

  app.post("/api/interview/parts/:part/writeup", async (c) =>
    c.json(await createWriteup(interviewDeps(c), c.get("email"), partParam(c.req.param("part")))),
  );

  app.put("/api/interview/parts/:part/writeup", async (c) => {
    const part = partParam(c.req.param("part"));
    const body = await readBody(c, WriteupBody);
    return c.json(await saveWriteup(c.env.DB, c.get("email"), part, body));
  });

  app.post("/api/interview/parts/:part/confirm", async (c) => {
    const part = partParam(c.req.param("part"));
    const { version } = await readBody(c, VersionBody);
    return c.json(await confirm(c.env.DB, c.get("email"), part, version));
  });

  app.post("/api/interview/parts/:part/reopen", async (c) =>
    c.json(await reopen(c.env.DB, c.get("email"), partParam(c.req.param("part")))),
  );

  // Everyone's interviews: ADMIN_EMAILS only. Read-only.
  app.use("/api/admin/*", async (c, next) => {
    if (!isAdmin(c.env, c.get("email"))) {
      log("warn", "admin_refused", { requestId: c.get("requestId"), email: c.get("email") });
      return errorResponse(c.get("requestId"), 403, "forbidden");
    }
    await next();
  });

  app.get("/api/admin/interviews", async (c) => c.json(await listInterviews(c.env.DB)));

  app.get("/api/admin/interviews/:email", async (c) => {
    const parsed = EmailParam.safeParse(c.req.param("email"));
    if (!parsed.success) throw new HttpError(404, "not_found");
    const interview = await loadInterview(c.env.DB, parsed.data);
    if (!interview) throw new HttpError(404, "not_found");
    return c.json({ email: parsed.data, ...interview });
  });

  app.all("/api/*", (c) => errorResponse(c.get("requestId"), 404, "not_found"));

  // Everything else is the web app (normally served before the Worker runs).
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (requestId && err instanceof HttpError) {
      return errorResponse(requestId, err.status, err.code, err.fields);
    }
    if (requestId && err instanceof ModelError) {
      log(err.code === "model_unavailable" ? "warn" : "error", "model_error", { requestId, code: err.code, reason: err.message });
      return errorResponse(requestId, MODEL_ERROR_STATUS[err.code], err.code);
    }
    log("error", "unhandled_error", { requestId, message: err.message, stack: err.stack });
    if (!requestId) return c.text("Internal Server Error", 500);
    return errorResponse(requestId, 500, "internal_error");
  });

  return app;
}
