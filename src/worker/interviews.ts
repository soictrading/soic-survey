import { z } from "zod";
import {
  LIMITS,
  PARTS,
  type AdminListItem,
  type InterviewView,
  type Lang,
  type Message,
  type MessageRole,
  type Part,
  type PartStatus,
  type PartView,
  type Writeup,
} from "../shared/types";
import { HttpError, nowIso } from "./http";
import type { ModelCaller } from "./model";
import type { Env } from "./env";
import { interviewerRequest, stripDoneMarker, writeupRequest } from "./prompts";

interface InterviewRow {
  email: string;
  lang: Lang;
  started_at: string;
  updated_at: string;
}

interface PartRow {
  email: string;
  part: Part;
  status: PartStatus;
  summary: string | null;
  corrections: string;
  confirmed_at: string | null;
  version: number;
}

interface MessageRow {
  email: string;
  part: Part;
  seq: number;
  role: MessageRole;
  content: string;
}

const text = (max: number) => z.string().max(max);

/** A write-up as the person edits and saves it. */
export const WriteupInput = z.strictObject({
  examples: text(LIMITS.writeupTextChars),
  steps: z
    .array(
      z.strictObject({
        what: text(LIMITS.writeupTextChars),
        tool: text(LIMITS.writeupTextChars),
        who: text(LIMITS.writeupTextChars),
        info: text(LIMITS.writeupTextChars),
        time: text(LIMITS.writeupTextChars),
      }),
    )
    .max(LIMITS.writeupSteps),
  variations: z.array(text(LIMITS.writeupTextChars)).max(LIMITS.writeupListItems),
  painPoints: z.array(text(LIMITS.writeupTextChars)).max(LIMITS.writeupListItems),
});

const clipped = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

/** The model's tool input. Over-long values are clipped rather than rejected. */
const ModelWriteup = z.object({
  examples: clipped(LIMITS.writeupTextChars),
  steps: z
    .array(
      z.object({
        what: clipped(LIMITS.writeupTextChars),
        tool: clipped(LIMITS.writeupTextChars),
        who: clipped(LIMITS.writeupTextChars),
        info: clipped(LIMITS.writeupTextChars),
        time: clipped(LIMITS.writeupTextChars),
      }),
    )
    .min(1)
    .transform((steps) => steps.slice(0, LIMITS.writeupSteps)),
  variations: z.array(clipped(LIMITS.writeupTextChars)).transform((a) => a.filter(Boolean).slice(0, LIMITS.writeupListItems)),
  pain_points: z.array(clipped(LIMITS.writeupTextChars)).transform((a) => a.filter(Boolean).slice(0, LIMITS.writeupListItems)),
});

function parseStoredWriteup(json: string | null): Writeup | null {
  if (json === null) return null;
  const parsed = WriteupInput.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error("stored write-up does not match its schema");
  return parsed.data;
}

function toPartView(row: PartRow, messages: MessageRow[]): PartView {
  return {
    part: row.part,
    status: row.status,
    messages: messages.map((m): Message => ({ role: m.role, content: m.content })),
    writeup: parseStoredWriteup(row.summary),
    corrections: row.corrections,
    confirmedAt: row.confirmed_at,
    version: row.version,
  };
}

const PART_COLUMNS = "email, part, status, summary, corrections, confirmed_at, version";

async function findInterviewRow(db: D1Database, email: string): Promise<InterviewRow | null> {
  return db.prepare("SELECT email, lang, started_at, updated_at FROM interviews WHERE email = ?").bind(email).first<InterviewRow>();
}

export async function loadInterview(db: D1Database, email: string): Promise<InterviewView | null> {
  const [interviews, parts, messages] = await db.batch([
    db.prepare("SELECT email, lang, started_at, updated_at FROM interviews WHERE email = ?").bind(email),
    db.prepare(`SELECT ${PART_COLUMNS} FROM interview_parts WHERE email = ?`).bind(email),
    db.prepare("SELECT email, part, seq, role, content FROM interview_messages WHERE email = ? ORDER BY part, seq").bind(email),
  ]);
  const interview = (interviews?.results as InterviewRow[] | undefined)?.[0];
  if (!interview) return null;
  const partRows = (parts?.results ?? []) as PartRow[];
  const messageRows = (messages?.results ?? []) as MessageRow[];
  const views = {} as Record<Part, PartView>;
  for (const part of PARTS) {
    const row = partRows.find((r) => r.part === part);
    if (!row) throw new Error(`interview ${part} part is missing`);
    views[part] = toPartView(row, messageRows.filter((m) => m.part === part));
  }
  return { lang: interview.lang, startedAt: interview.started_at, updatedAt: interview.updated_at, parts: views };
}

export async function createInterview(db: D1Database, email: string, lang: Lang): Promise<InterviewView> {
  const now = nowIso();
  try {
    await db.batch([
      db.prepare("INSERT INTO interviews (email, lang, started_at, updated_at) VALUES (?, ?, ?, ?)").bind(email, lang, now, now),
      ...PARTS.map((part) =>
        db
          .prepare("INSERT INTO interview_parts (email, part, status, updated_at) VALUES (?, ?, 'not_started', ?)")
          .bind(email, part, now),
      ),
    ]);
  } catch (err) {
    if (isConstraintError(err)) throw new HttpError(409, "conflict");
    throw err;
  }
  const view = await loadInterview(db, email);
  if (!view) throw new Error("interview vanished after creation");
  return view;
}

function isConstraintError(err: unknown): boolean {
  return err instanceof Error && /constraint/i.test(err.message);
}

interface PartState {
  interview: InterviewRow;
  row: PartRow;
  messages: MessageRow[];
}

async function loadPart(db: D1Database, email: string, part: Part): Promise<PartState> {
  const interview = await findInterviewRow(db, email);
  if (!interview) throw new HttpError(404, "not_found");
  const [partResult, messageResult] = await db.batch([
    db.prepare(`SELECT ${PART_COLUMNS} FROM interview_parts WHERE email = ? AND part = ?`).bind(email, part),
    db.prepare("SELECT email, part, seq, role, content FROM interview_messages WHERE email = ? AND part = ? ORDER BY seq").bind(email, part),
  ]);
  const row = (partResult?.results as PartRow[] | undefined)?.[0];
  if (!row) throw new Error(`interview ${part} part is missing`);
  return { interview, row, messages: (messageResult?.results ?? []) as MessageRow[] };
}

async function currentPartView(db: D1Database, email: string, part: Part): Promise<PartView> {
  const { row, messages } = await loadPart(db, email, part);
  return toPartView(row, messages);
}

function requireStatus(row: PartRow, allowed: PartStatus[]): void {
  if (!allowed.includes(row.status)) throw new HttpError(409, "wrong_state");
}

const toMessages = (rows: MessageRow[]): Message[] => rows.map((m) => ({ role: m.role, content: m.content }));

export interface InterviewDeps {
  db: D1Database;
  env: Env;
  model: ModelCaller;
  requestId: string;
}

/** Gets the interviewer's next message: the first question, or the reply to the person's last answer. */
export async function askInterviewer(deps: InterviewDeps, email: string, part: Part): Promise<PartView> {
  const { db } = deps;
  const { interview, row, messages } = await loadPart(db, email, part);
  requireStatus(row, ["not_started", "interviewing"]);
  const last = messages.at(-1);
  if (last?.role === "interviewer") throw new HttpError(409, "wrong_state");

  const result = await deps.model(deps.env, interviewerRequest(part, interview.lang, toMessages(messages), deps.requestId));
  if (result.kind !== "text") throw new Error("interviewer call returned a tool result");
  const { text: content, done } = stripDoneMarker(result.text);
  // A reply that was only the completion marker ends the part without adding a message.
  if (content === "" && !done) throw new HttpError(502, "model_failed");
  const nextStatus: PartStatus = done ? "finished" : "interviewing";
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (content !== "") {
    statements.push(
      db
        .prepare("INSERT INTO interview_messages (email, part, seq, role, content, created_at) VALUES (?, ?, ?, 'interviewer', ?, ?)")
        .bind(email, part, (last?.seq ?? 0) + 1, content.slice(0, 20000), now),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE interview_parts SET status = ?, version = version + 1, updated_at = ?
          WHERE email = ? AND part = ? AND status IN ('not_started', 'interviewing')`,
      )
      .bind(nextStatus, now, email, part),
    db.prepare("UPDATE interviews SET updated_at = ? WHERE email = ?").bind(now, email),
  );
  try {
    await db.batch(statements);
  } catch (err) {
    // Another request added this message first (two tabs, a double click).
    if (isConstraintError(err)) throw new HttpError(409, "conflict");
    throw err;
  }
  return currentPartView(db, email, part);
}

/** Saves the person's answer, then gets the interviewer's reply. */
export async function answer(deps: InterviewDeps, email: string, part: Part, content: string): Promise<PartView> {
  const { db } = deps;
  const { row, messages } = await loadPart(db, email, part);
  requireStatus(row, ["interviewing"]);
  const last = messages.at(-1);
  if (last?.role !== "interviewer") throw new HttpError(409, "wrong_state");
  if (messages.filter((m) => m.role === "person").length >= LIMITS.personMessagesPerPart) {
    throw new HttpError(422, "limit_reached");
  }
  const now = nowIso();
  try {
    await db.batch([
      db
        .prepare("INSERT INTO interview_messages (email, part, seq, role, content, created_at) VALUES (?, ?, ?, 'person', ?, ?)")
        .bind(email, part, last.seq + 1, content, now),
      db.prepare("UPDATE interviews SET updated_at = ? WHERE email = ?").bind(now, email),
    ]);
  } catch (err) {
    if (isConstraintError(err)) throw new HttpError(409, "conflict");
    throw err;
  }
  // If the model call fails, the answer stays saved and the person can ask again.
  return askInterviewer(deps, email, part);
}

/** The person says the part is fully covered. */
export async function finish(db: D1Database, email: string, part: Part): Promise<PartView> {
  const { row, messages } = await loadPart(db, email, part);
  requireStatus(row, ["interviewing"]);
  if (!messages.some((m) => m.role === "person")) throw new HttpError(409, "wrong_state");
  await updatePart(db, email, part, "UPDATE interview_parts SET status = 'finished', version = version + 1, updated_at = ? WHERE email = ? AND part = ? AND status = 'interviewing'", []);
  return currentPartView(db, email, part);
}

/** Writes up a finished part for the person to check. */
export async function createWriteup(deps: InterviewDeps, email: string, part: Part): Promise<PartView> {
  const { db } = deps;
  const { interview, row, messages } = await loadPart(db, email, part);
  requireStatus(row, ["finished"]);
  const result = await deps.model(deps.env, writeupRequest(part, interview.lang, toMessages(messages), deps.requestId));
  if (result.kind !== "tool") throw new Error("write-up call returned text");
  const parsed = ModelWriteup.safeParse(result.input);
  if (result.truncated || !parsed.success) throw new HttpError(502, "model_failed");
  const writeup: Writeup = {
    examples: parsed.data.examples,
    steps: parsed.data.steps,
    variations: parsed.data.variations,
    painPoints: parsed.data.pain_points,
  };
  await updatePart(
    db,
    email,
    part,
    "UPDATE interview_parts SET status = 'review', summary = ?, version = version + 1, updated_at = ? WHERE email = ? AND part = ? AND status = 'finished'",
    [JSON.stringify(writeup)],
  );
  return currentPartView(db, email, part);
}

/** Saves the person's edits to their write-up. */
export async function saveWriteup(
  db: D1Database,
  email: string,
  part: Part,
  input: { version: number; writeup: Writeup; corrections: string },
): Promise<PartView> {
  const { row } = await loadPart(db, email, part);
  requireStatus(row, ["review"]);
  await updatePart(
    db,
    email,
    part,
    "UPDATE interview_parts SET summary = ?, corrections = ?, version = version + 1, updated_at = ? WHERE email = ? AND part = ? AND status = 'review' AND version = ?",
    [JSON.stringify(input.writeup), input.corrections],
    [input.version],
  );
  return currentPartView(db, email, part);
}

export async function confirm(db: D1Database, email: string, part: Part, version: number): Promise<PartView> {
  const { row } = await loadPart(db, email, part);
  requireStatus(row, ["review"]);
  const now = nowIso();
  await updatePart(
    db,
    email,
    part,
    "UPDATE interview_parts SET status = 'confirmed', confirmed_at = ?, version = version + 1, updated_at = ? WHERE email = ? AND part = ? AND status = 'review' AND version = ?",
    [now],
    [version],
  );
  return currentPartView(db, email, part);
}

/** Back from confirmed to review, so the person can correct it. */
export async function reopen(db: D1Database, email: string, part: Part): Promise<PartView> {
  const { row } = await loadPart(db, email, part);
  requireStatus(row, ["confirmed"]);
  await updatePart(
    db,
    email,
    part,
    "UPDATE interview_parts SET status = 'review', confirmed_at = NULL, version = version + 1, updated_at = ? WHERE email = ? AND part = ? AND status = 'confirmed'",
    [],
  );
  return currentPartView(db, email, part);
}

/**
 * Runs a single-row part update. SQL placeholders, in order: `before`, updated_at, email, part, `after`.
 * Zero rows changed means another request changed the part first.
 */
async function updatePart(
  db: D1Database,
  email: string,
  part: Part,
  sql: string,
  before: (string | number)[],
  after: (string | number)[] = [],
): Promise<void> {
  const now = nowIso();
  const [update] = await db.batch([
    db.prepare(sql).bind(...before, now, email, part, ...after),
    db.prepare("UPDATE interviews SET updated_at = ? WHERE email = ?").bind(now, email),
  ]);
  if (update?.meta.changes !== 1) throw new HttpError(409, "conflict");
}

export async function listInterviews(db: D1Database): Promise<AdminListItem[]> {
  const [interviews, parts, counts] = await db.batch([
    db.prepare("SELECT email, lang, started_at, updated_at FROM interviews ORDER BY updated_at DESC"),
    db.prepare("SELECT email, part, status, confirmed_at FROM interview_parts"),
    db.prepare("SELECT email, part, COUNT(*) AS n FROM interview_messages WHERE role = 'person' GROUP BY email, part"),
  ]);
  const partRows = (parts?.results ?? []) as { email: string; part: Part; status: PartStatus; confirmed_at: string | null }[];
  const countRows = (counts?.results ?? []) as { email: string; part: Part; n: number }[];
  return ((interviews?.results ?? []) as InterviewRow[]).map((i) => {
    const summary = {} as AdminListItem["parts"];
    for (const part of PARTS) {
      const row = partRows.find((r) => r.email === i.email && r.part === part);
      if (!row) throw new Error(`interview ${part} part is missing`);
      summary[part] = {
        status: row.status,
        confirmedAt: row.confirmed_at,
        personMessages: countRows.find((r) => r.email === i.email && r.part === part)?.n ?? 0,
      };
    }
    return { email: i.email, lang: i.lang, startedAt: i.started_at, updatedAt: i.updated_at, parts: summary };
  });
}
