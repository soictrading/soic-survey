import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicCaller, ModelError, type ModelRequest } from "../src/worker/model";
import { WRITEUP_TOOL } from "../src/worker/prompts";
import { stagingEnv } from "./helpers";

const env = stagingEnv({ ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_MODEL: "claude-sonnet-5-5" });

const request: ModelRequest = {
  system: "You are a test.",
  messages: [{ role: "user", content: "Hello" }],
  maxTokens: 100,
  purpose: "test",
  requestId: "req-1",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const textReply = (text: string) => json({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 } });

function stubFetch(...responses: (Response | Error)[]) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    if (r instanceof Error) spy.mockRejectedValueOnce(r);
    else spy.mockResolvedValueOnce(r);
  }
  return spy;
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ModelError) return err.code;
    throw err;
  }
  throw new Error("expected a ModelError");
}

afterEach(() => vi.restoreAllMocks());

describe("Anthropic caller", () => {
  it("refuses to call without a key or with an invalid model setting", async () => {
    const spy = stubFetch();
    expect(await failureCode(anthropicCaller({ ...env, ANTHROPIC_API_KEY: "" }, request))).toBe("server_misconfigured");
    expect(await failureCode(anthropicCaller({ ...env, ANTHROPIC_MODEL: "gpt-4" }, request))).toBe("server_misconfigured");
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the key in the header and returns the text answer", async () => {
    const spy = stubFetch(textReply("  Next question?  "));
    expect(await anthropicCaller(env, request)).toEqual({ kind: "text", text: "Next question?", truncated: false });
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("test-key-not-real");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: "claude-sonnet-5-5", max_tokens: 100, system: "You are a test.", messages: request.messages });
  });

  it("forces the tool when one is given and returns its input", async () => {
    const spy = stubFetch(
      json({ content: [{ type: "tool_use", id: "t1", name: WRITEUP_TOOL.name, input: { a: 1 } }], stop_reason: "tool_use" }),
    );
    expect(await anthropicCaller(env, { ...request, tool: WRITEUP_TOOL })).toEqual({ kind: "tool", input: { a: 1 }, truncated: false });
    const body = JSON.parse(spy.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body["tool_choice"]).toEqual({ type: "tool", name: WRITEUP_TOOL.name });
  });

  it("retries an overloaded or failed request once", async () => {
    const spy = stubFetch(json({ error: { type: "overloaded_error" } }, 529), textReply("ok"));
    expect((await anthropicCaller(env, request)).kind).toBe("text");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry", async () => {
    const spy = stubFetch(json({}, 500), json({}, 503));
    expect(await failureCode(anthropicCaller(env, request))).toBe("model_unavailable");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rate limit", async () => {
    const spy = stubFetch(json({ error: { type: "rate_limit_error" } }, 429));
    expect(await failureCode(anthropicCaller(env, request))).toBe("model_unavailable");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected key as misconfiguration and a bad request as a failure", async () => {
    stubFetch(json({ error: { type: "authentication_error" } }, 401), json({ error: { type: "invalid_request_error" } }, 400));
    expect(await failureCode(anthropicCaller(env, request))).toBe("server_misconfigured");
    expect(await failureCode(anthropicCaller(env, request))).toBe("model_failed");
  });

  it("treats an unreadable answer, or a missing tool call, as a failure", async () => {
    stubFetch(new Response("not json"), json({ content: [{ type: "text", text: "no tool" }], stop_reason: "end_turn" }));
    expect(await failureCode(anthropicCaller(env, request))).toBe("model_failed");
    expect(await failureCode(anthropicCaller(env, { ...request, tool: WRITEUP_TOOL }))).toBe("model_failed");
  });

  it("retries a network failure once", async () => {
    const spy = stubFetch(new TypeError("network down"), textReply("ok"));
    expect((await anthropicCaller(env, request)).kind).toBe("text");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
