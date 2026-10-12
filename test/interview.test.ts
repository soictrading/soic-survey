import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type AdminInterview, type AdminListItem, type ApiErrorBody, type InterviewView, type Me, type PartView } from "../src/shared/types";
import { ADMIN, VALID_TOOL_INPUT, accessToken, api, app, fakeModel, newEmail, stagingEnv, STAGING_ORIGIN } from "./helpers";

beforeEach(() => {
  fakeModel.reset();
});

const code = (body: unknown) => (body as ApiErrorBody).error.code;

async function started(lang: "en" | "es" = "en"): Promise<string> {
  const email = newEmail();
  const res = await api<InterviewView>(email, "POST", "/api/interview", { lang });
  expect(res.status).toBe(201);
  return email;
}

/** A person with part 1 under way: first question asked. */
async function interviewing(): Promise<string> {
  const email = await started();
  fakeModel.replyText("Tell me your process.");
  expect((await api(email, "POST", "/api/interview/parts/load/ask")).status).toBe(200);
  return email;
}

async function finished(): Promise<string> {
  const email = await interviewing();
  fakeModel.replyText("Thanks, that covers it.\n[[DONE]]");
  const res = await api<PartView>(email, "POST", "/api/interview/parts/load/answer", { text: "I read the email and call buyers." });
  expect(res.body.status).toBe("finished");
  return email;
}

async function inReview(): Promise<{ email: string; view: PartView }> {
  const email = await finished();
  fakeModel.replyTool(VALID_TOOL_INPUT);
  const res = await api<PartView>(email, "POST", "/api/interview/parts/load/writeup");
  expect(res.status).toBe(200);
  return { email, view: res.body };
}

describe("starting", () => {
  it("creates both parts, not started, in the chosen language", async () => {
    const email = newEmail();
    const res = await api<InterviewView>(email, "POST", "/api/interview", { lang: "es" });
    expect(res.status).toBe(201);
    expect(res.body.lang).toBe("es");
    expect(res.body.parts.load).toMatchObject({ status: "not_started", messages: [], writeup: null });
    expect(res.body.parts.buyer).toMatchObject({ status: "not_started", messages: [], writeup: null });
    const me = await api<Me>(email, "GET", "/api/me");
    expect(me.body.interview?.lang).toBe("es");
  });

  it("refuses a second start and an unknown language", async () => {
    const email = await started();
    expect((await api(email, "POST", "/api/interview", { lang: "en" })).status).toBe(409);
    expect((await api(newEmail(), "POST", "/api/interview", { lang: "fr" })).status).toBe(400);
  });

  it("refuses part actions before the interview exists, and unknown parts", async () => {
    expect((await api(newEmail(), "POST", "/api/interview/parts/load/ask")).status).toBe(404);
    const email = await started();
    expect((await api(email, "POST", "/api/interview/parts/other/ask")).status).toBe(404);
    expect(fakeModel.requests).toHaveLength(0);
  });

  it("requires JSON for state-changing requests", async () => {
    const headers = { "cf-access-jwt-assertion": await accessToken({ email: newEmail() }), "content-type": "text/plain" };
    const res = await app.request(`${STAGING_ORIGIN}/api/interview`, { method: "POST", headers, body: "lang=en" }, stagingEnv());
    expect(res.status).toBe(415);
  });
});

describe("interviewing", () => {
  it("asks the first question with server-built instructions for the part and language", async () => {
    const email = await started("es");
    fakeModel.replyText("Hola. ¿Cómo es tu proceso?");
    const res = await api<PartView>(email, "POST", "/api/interview/parts/buyer/ask");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("interviewing");
    expect(res.body.messages).toEqual([{ role: "interviewer", content: "Hola. ¿Cómo es tu proceso?" }]);
    const request = fakeModel.requests[0];
    expect(request?.system).toContain("A BUYER NEEDS A LOAD");
    expect(request?.system).toContain("Spanish");
    expect(request?.messages).toHaveLength(1);
    expect(request?.messages[0]?.role).toBe("user");
  });

  it("will not ask again while waiting for the person's answer", async () => {
    const email = await interviewing();
    const res = await api(email, "POST", "/api/interview/parts/load/ask");
    expect(res.status).toBe(409);
    expect(code(res.body)).toBe("wrong_state");
    expect(fakeModel.requests).toHaveLength(1);
  });

  it("saves the answer and returns the interviewer's reply, sending the whole conversation", async () => {
    const email = await interviewing();
    fakeModel.replyText("Which email did you open first?");
    const res = await api<PartView>(email, "POST", "/api/interview/parts/load/answer", { text: "  I check my inbox.  " });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([
      { role: "interviewer", content: "Tell me your process." },
      { role: "person", content: "I check my inbox." },
      { role: "interviewer", content: "Which email did you open first?" },
    ]);
    expect(fakeModel.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(fakeModel.requests[1]?.messages[2]?.content).toBe("I check my inbox.");
  });

  it("keeps the answer when the model fails, and lets the person ask again", async () => {
    const email = await interviewing();
    fakeModel.fail("model_unavailable");
    const failed = await api(email, "POST", "/api/interview/parts/load/answer", { text: "My answer" });
    expect(failed.status).toBe(503);
    expect(code(failed.body)).toBe("model_unavailable");
    const me = await api<Me>(email, "GET", "/api/me");
    expect(me.body.interview?.parts.load.messages.at(-1)).toEqual({ role: "person", content: "My answer" });
    // A second answer is refused until the interviewer has replied.
    expect((await api(email, "POST", "/api/interview/parts/load/answer", { text: "again" })).status).toBe(409);
    fakeModel.replyText("Next question.");
    const retry = await api<PartView>(email, "POST", "/api/interview/parts/load/ask");
    expect(retry.status).toBe(200);
    expect(retry.body.messages.at(-1)).toEqual({ role: "interviewer", content: "Next question." });
  });

  it("maps model configuration problems to a server error", async () => {
    const email = await started();
    fakeModel.fail("server_misconfigured");
    const res = await api(email, "POST", "/api/interview/parts/load/ask");
    expect(res.status).toBe(500);
    expect(code(res.body)).toBe("server_misconfigured");
  });

  it("validates answers", async () => {
    const email = await interviewing();
    expect((await api(email, "POST", "/api/interview/parts/load/answer", { text: "   " })).status).toBe(400);
    expect((await api(email, "POST", "/api/interview/parts/load/answer", { text: "x".repeat(LIMITS.answerChars + 1) })).status).toBe(400);
    expect((await api(email, "POST", "/api/interview/parts/load/answer", { text: "ok", extra: 1 })).status).toBe(400);
    expect((await api(email, "POST", "/api/interview/parts/buyer/answer", { text: "ok" })).status).toBe(409);
    expect(fakeModel.requests).toHaveLength(1);
  });

  it("finishes the part when the interviewer says it is complete, without showing the marker", async () => {
    const email = await interviewing();
    fakeModel.replyText("That's everything, thank you.\n[[DONE]]");
    const res = await api<PartView>(email, "POST", "/api/interview/parts/load/answer", { text: "Nothing else." });
    expect(res.body.status).toBe("finished");
    expect(res.body.messages.at(-1)).toEqual({ role: "interviewer", content: "That's everything, thank you." });
  });

  it("finishes without adding a message when the reply is only the marker", async () => {
    const email = await interviewing();
    fakeModel.replyText("[[DONE]]");
    const res = await api<PartView>(email, "POST", "/api/interview/parts/load/answer", { text: "Done." });
    expect(res.body.status).toBe("finished");
    expect(res.body.messages.at(-1)).toEqual({ role: "person", content: "Done." });
  });

  it("lets the person finish once they have answered at least once", async () => {
    const email = await interviewing();
    expect((await api(email, "POST", "/api/interview/parts/load/finish")).status).toBe(409);
    fakeModel.replyText("And then?");
    await api(email, "POST", "/api/interview/parts/load/answer", { text: "I quote." });
    const res = await api<PartView>(email, "POST", "/api/interview/parts/load/finish");
    expect(res.body.status).toBe("finished");
    expect((await api(email, "POST", "/api/interview/parts/load/answer", { text: "more" })).status).toBe(409);
  });

  it("stops accepting answers at the per-part limit", async () => {
    const email = await interviewing();
    const now = new Date().toISOString();
    const rows = [];
    for (let i = 0; i < LIMITS.personMessagesPerPart; i++) {
      rows.push(
        env.DB.prepare("INSERT INTO interview_messages (email, part, seq, role, content, created_at) VALUES (?, 'load', ?, 'person', 'a', ?)").bind(email, 2 + i * 2, now),
        env.DB.prepare("INSERT INTO interview_messages (email, part, seq, role, content, created_at) VALUES (?, 'load', ?, 'interviewer', 'q', ?)").bind(email, 3 + i * 2, now),
      );
    }
    await env.DB.batch(rows);
    const res = await api(email, "POST", "/api/interview/parts/load/answer", { text: "one more" });
    expect(res.status).toBe(422);
    expect(code(res.body)).toBe("limit_reached");
  });
});

describe("write-up", () => {
  it("is created from the conversation with the forced tool and mapped to the API shape", async () => {
    const { view } = await inReview();
    expect(view.status).toBe("review");
    expect(view.writeup).toEqual({
      examples: VALID_TOOL_INPUT.examples,
      steps: VALID_TOOL_INPUT.steps,
      variations: VALID_TOOL_INPUT.variations,
      painPoints: VALID_TOOL_INPUT.pain_points,
    });
    const request = fakeModel.requests.at(-1);
    expect(request?.tool?.name).toBe("record_flow");
    expect(request?.messages[0]?.content).toContain("Person: I read the email and call buyers.");
  });

  it("stays finished when the model's write-up is unusable or cut short", async () => {
    const email = await finished();
    fakeModel.replyTool({ steps: "nope" });
    expect((await api(email, "POST", "/api/interview/parts/load/writeup")).status).toBe(502);
    fakeModel.replyTool(VALID_TOOL_INPUT, true);
    expect((await api(email, "POST", "/api/interview/parts/load/writeup")).status).toBe(502);
    const me = await api<Me>(email, "GET", "/api/me");
    expect(me.body.interview?.parts.load.status).toBe("finished");
  });

  it("can only be created for a finished part", async () => {
    const email = await interviewing();
    expect((await api(email, "POST", "/api/interview/parts/load/writeup")).status).toBe(409);
  });

  it("saves the person's edits with a version check", async () => {
    const { email, view } = await inReview();
    const writeup = { ...view.writeup, steps: [{ what: "Corrected step", tool: "Excel", who: "", info: "", time: "" }] };
    const saved = await api<PartView>(email, "PUT", "/api/interview/parts/load/writeup", { version: view.version, writeup, corrections: "Note for Mike" });
    expect(saved.status).toBe(200);
    expect(saved.body.writeup?.steps).toEqual(writeup.steps);
    expect(saved.body.corrections).toBe("Note for Mike");
    const stale = await api(email, "PUT", "/api/interview/parts/load/writeup", { version: view.version, writeup, corrections: "" });
    expect(stale.status).toBe(409);
    const extra = await api(email, "PUT", "/api/interview/parts/load/writeup", {
      version: saved.body.version,
      writeup: { ...writeup, injected: true },
      corrections: "",
    });
    expect(extra.status).toBe(400);
  });

  it("is confirmed with a version check and can be reopened", async () => {
    const { email, view } = await inReview();
    expect((await api(email, "POST", "/api/interview/parts/load/confirm", { version: view.version + 5 })).status).toBe(409);
    const confirmed = await api<PartView>(email, "POST", "/api/interview/parts/load/confirm", { version: view.version });
    expect(confirmed.body.status).toBe("confirmed");
    expect(confirmed.body.confirmedAt).toMatch(/^\d{4}-/);
    const edit = await api(email, "PUT", "/api/interview/parts/load/writeup", { version: confirmed.body.version, writeup: view.writeup, corrections: "" });
    expect(edit.status).toBe(409);
    const reopened = await api<PartView>(email, "POST", "/api/interview/parts/load/reopen");
    expect(reopened.body.status).toBe("review");
    expect(reopened.body.confirmedAt).toBeNull();
  });
});

describe("privacy and the owner overview", () => {
  it("shows each person only their own interview", async () => {
    const { email } = await inReview();
    const other = newEmail();
    const me = await api<Me>(other, "GET", "/api/me");
    expect(me.body.interview).toBeNull();
    // Part routes act on the signed-in person only; the other person has no interview to change.
    expect((await api(other, "POST", "/api/interview/parts/load/reopen")).status).toBe(404);
    const owner = await api<Me>(email, "GET", "/api/me");
    expect(owner.body.interview?.parts.load.status).toBe("review");
  });

  it("refuses the overview to everyone except ADMIN_EMAILS", async () => {
    const email = await started();
    for (const path of ["/api/admin/interviews", `/api/admin/interviews/${encodeURIComponent(email)}`]) {
      const res = await api(email, "GET", path);
      expect(res.status, path).toBe(403);
      expect(code(res.body)).toBe("forbidden");
    }
    // An empty ADMIN_EMAILS makes no one an admin.
    expect((await api(ADMIN, "GET", "/api/admin/interviews", undefined, { ADMIN_EMAILS: "" })).status).toBe(403);
  });

  it("lists everyone's progress and opens any interview for the admin", async () => {
    const { email } = await inReview();
    const me = await api<Me>(ADMIN, "GET", "/api/me");
    expect(me.body.isAdmin).toBe(true);
    const list = await api<AdminListItem[]>(ADMIN, "GET", "/api/admin/interviews");
    const row = list.body.find((r) => r.email === email);
    expect(row?.parts.load).toEqual({ status: "review", personMessages: 1, confirmedAt: null });
    expect(row?.parts.buyer.status).toBe("not_started");
    const detail = await api<AdminInterview>(ADMIN, "GET", `/api/admin/interviews/${encodeURIComponent(email.toUpperCase())}`);
    expect(detail.status).toBe(200);
    expect(detail.body.email).toBe(email);
    expect(detail.body.parts.load.messages).toHaveLength(3);
    expect((await api(ADMIN, "GET", "/api/admin/interviews/nobody%40soictrading.com")).status).toBe(404);
  });
});
