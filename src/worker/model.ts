import { z } from "zod";
import type { Env } from "./env";
import { log } from "./log";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 1_000;
const MODEL_PATTERN = /^claude-[a-z0-9.-]+$/;

export interface ModelTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
  /** When set, the model must answer by calling this tool; its input is returned. */
  tool?: ModelTool;
  /** Short label for logs (never content). */
  purpose: string;
  requestId: string;
}

export type ModelResult =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "tool"; input: unknown; truncated: boolean };

/** Calls the language model. Injected so tests never reach the network. */
export type ModelCaller = (env: Env, request: ModelRequest) => Promise<ModelResult>;

/**
 * model_unavailable: transient (rate limit, overload, outage) — the person can try again.
 * model_failed: the call or its answer was unusable.
 * server_misconfigured: missing/invalid key or model setting.
 */
export class ModelError extends Error {
  constructor(
    readonly code: "model_unavailable" | "model_failed" | "server_misconfigured",
    message: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

const ResponseBody = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), name: z.string(), input: z.unknown() }),
      z.object({ type: z.string() }),
    ]),
  ),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

const ErrorBody = z.object({ error: z.object({ type: z.string() }) });

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

async function send(apiKey: string, body: string): Promise<Response> {
  return fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export const anthropicCaller: ModelCaller = async (env, request) => {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!apiKey) throw new ModelError("server_misconfigured", "ANTHROPIC_API_KEY is not set");
  if (!model || !MODEL_PATTERN.test(model)) throw new ModelError("server_misconfigured", "ANTHROPIC_MODEL is missing or invalid");

  const body = JSON.stringify({
    model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    ...(request.tool ? { tools: [request.tool], tool_choice: { type: "tool", name: request.tool.name } } : {}),
  });

  const started = Date.now();
  let res: Response | null = null;
  // One retry for a network failure or a transient status; a timeout is not retried (the person is waiting).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      res = await send(apiKey, body);
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      log("warn", "model_request_failed", { requestId: request.requestId, purpose: request.purpose, attempt, timedOut });
      if (timedOut || attempt === 2) throw new ModelError("model_unavailable", timedOut ? "model timed out" : "model unreachable");
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      continue;
    }
    if (res.ok || !isTransientStatus(res.status) || res.status === 429 || attempt === 2) break;
    log("warn", "model_transient_status", { requestId: request.requestId, purpose: request.purpose, attempt, status: res.status });
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  if (!res) throw new ModelError("model_unavailable", "no response");

  if (!res.ok) {
    const errorType = ErrorBody.safeParse(await res.json().catch(() => null)).data?.error.type ?? "unknown";
    const fields = { requestId: request.requestId, purpose: request.purpose, status: res.status, errorType };
    if (res.status === 401 || res.status === 403) {
      log("error", "model_auth_failed", fields);
      throw new ModelError("server_misconfigured", `model rejected credentials (${res.status})`);
    }
    if (isTransientStatus(res.status)) {
      log("warn", "model_unavailable", fields);
      throw new ModelError("model_unavailable", `model status ${res.status}`);
    }
    log("error", "model_request_rejected", fields);
    throw new ModelError("model_failed", `model status ${res.status}`);
  }

  const parsed = ResponseBody.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    log("error", "model_response_unreadable", { requestId: request.requestId, purpose: request.purpose });
    throw new ModelError("model_failed", "unreadable model response");
  }
  const { content, stop_reason: stopReason, usage } = parsed.data;
  log("info", "model_call", {
    requestId: request.requestId,
    purpose: request.purpose,
    ms: Date.now() - started,
    stopReason,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
  });
  const truncated = stopReason === "max_tokens";

  if (request.tool) {
    const toolName = request.tool.name;
    const call = content.find(
      (block): block is { type: "tool_use"; name: string; input: unknown } =>
        block.type === "tool_use" && "name" in block && block.name === toolName,
    );
    if (!call) throw new ModelError("model_failed", "model did not call the tool");
    return { kind: "tool", input: call.input, truncated };
  }
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
    .map((block) => block.text)
    .join("")
    .trim();
  if (text === "") throw new ModelError("model_failed", "empty model answer");
  return { kind: "text", text, truncated };
};
