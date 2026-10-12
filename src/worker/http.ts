import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { ApiErrorBody, ApiErrorCode } from "../shared/types";
import type { Env } from "./env";

export interface AppEnv {
  Bindings: Env;
  Variables: { requestId: string; email: string };
}

/** Thrown by route handlers; converted to a JSON error response by the app's error handler. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    readonly fields?: string[],
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export function errorResponse(
  requestId: string,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  fields?: string[],
): Response {
  const body: ApiErrorBody = { error: { code, requestId, ...(fields ? { fields } : {}) } };
  return Response.json(body, { status });
}

/** Parses and validates a JSON request body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono context generics vary per route
export async function readBody<S extends z.ZodType>(c: Context<AppEnv, any, any>, schema: S): Promise<z.output<S>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter(Boolean);
    throw new HttpError(400, "invalid_request", fields);
  }
  return parsed.data;
}

export function nowIso(): string {
  return new Date().toISOString();
}
