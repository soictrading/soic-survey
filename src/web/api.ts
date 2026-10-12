import type { AdminInterview, AdminListItem, ApiErrorBody, ApiErrorCode, InterviewView, Lang, Me, Part, PartView, Writeup } from "../shared/types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
  ) {
    super(`API error ${status} ${code}`);
    this.name = "ApiError";
  }
}

/** The request never produced an HTTP response (offline, DNS, blocked). */
export class ConnectionError extends Error {
  constructor(cause: unknown) {
    super("Could not reach the survey", { cause });
    this.name = "ConnectionError";
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: method === "GET" ? null : JSON.stringify(body ?? {}),
      credentials: "same-origin",
      // When the Access session has expired, Cloudflare answers with a redirect to its
      // login page. Surface that as "session ended" instead of following it.
      redirect: "manual",
    });
  } catch (err) {
    throw new ConnectionError(err);
  }
  if (res.type === "opaqueredirect") throw new ApiError(401, "unauthenticated");
  if (!res.ok) {
    let code: ApiErrorCode = "internal_error";
    try {
      code = ((await res.json()) as ApiErrorBody).error.code;
    } catch {
      // Non-JSON error body (e.g. from the edge); keep the default.
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

const partPath = (part: Part, action: string) => `/api/interview/parts/${part}/${action}`;

export const getMe = () => request<Me>("/api/me");
export const startInterview = (lang: Lang) => request<InterviewView>("/api/interview", "POST", { lang });
export const ask = (part: Part) => request<PartView>(partPath(part, "ask"), "POST");
export const sendAnswer = (part: Part, text: string) => request<PartView>(partPath(part, "answer"), "POST", { text });
export const finishPart = (part: Part) => request<PartView>(partPath(part, "finish"), "POST");
export const createWriteup = (part: Part) => request<PartView>(partPath(part, "writeup"), "POST");
export const saveWriteup = (part: Part, version: number, writeup: Writeup, corrections: string) =>
  request<PartView>(partPath(part, "writeup"), "PUT", { version, writeup, corrections });
export const confirmPart = (part: Part, version: number) => request<PartView>(partPath(part, "confirm"), "POST", { version });
export const reopenPart = (part: Part) => request<PartView>(partPath(part, "reopen"), "POST");
export const listInterviews = () => request<AdminListItem[]>("/api/admin/interviews");
export const getInterview = (email: string) => request<AdminInterview>(`/api/admin/interviews/${encodeURIComponent(email)}`);
