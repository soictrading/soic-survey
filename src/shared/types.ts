export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const LANGS = ["en", "es"] as const;
export type Lang = (typeof LANGS)[number];

/** Part 1: a load becomes available. Part 2: a buyer needs a load. Always in this order. */
export const PARTS = ["load", "buyer"] as const;
export type Part = (typeof PARTS)[number];

export const PART_STATUSES = ["not_started", "interviewing", "finished", "review", "confirmed"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export type MessageRole = "interviewer" | "person";

export interface Message {
  role: MessageRole;
  content: string;
}

export interface WriteupStep {
  what: string;
  tool: string;
  who: string;
  info: string;
  time: string;
}

/** The step-by-step write-up of one part, which the person checks and corrects. */
export interface Writeup {
  examples: string;
  steps: WriteupStep[];
  variations: string[];
  painPoints: string[];
}

export interface PartView {
  part: Part;
  status: PartStatus;
  messages: Message[];
  writeup: Writeup | null;
  corrections: string;
  confirmedAt: string | null;
  version: number;
}

export interface InterviewView {
  lang: Lang;
  startedAt: string;
  updatedAt: string;
  parts: Record<Part, PartView>;
}

export interface Me {
  email: string;
  isAdmin: boolean;
  interview: InterviewView | null;
}

export interface AdminPartSummary {
  status: PartStatus;
  personMessages: number;
  confirmedAt: string | null;
}

export interface AdminListItem {
  email: string;
  lang: Lang;
  startedAt: string;
  updatedAt: string;
  parts: Record<Part, AdminPartSummary>;
}

export interface AdminInterview extends InterviewView {
  email: string;
}

/** Input limits, enforced by the Worker and mirrored by the web client. */
export const LIMITS = {
  answerChars: 8000,
  personMessagesPerPart: 150,
  correctionsChars: 8000,
  writeupSteps: 100,
  writeupTextChars: 2000,
  writeupListItems: 50,
} as const;

export type ApiErrorCode =
  | "unauthenticated"
  | "auth_unavailable"
  | "server_misconfigured"
  | "forbidden"
  | "invalid_request"
  | "unsupported_media_type"
  | "not_found"
  | "conflict"
  | "wrong_state"
  | "limit_reached"
  | "model_unavailable"
  | "model_failed"
  | "internal_error";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; requestId: string; fields?: string[] };
}
