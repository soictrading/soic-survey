import { LIMITS, PARTS, type AdminInterview, type AdminListItem, type Lang, type Part, type PartStatus, type PartView, type Writeup, type WriteupStep } from "../shared/types";
import * as api from "./api";
import { setLang, t, type MessageKey } from "./i18n";

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing`);
  return node;
}

function typed<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = $(id);
  if (!(node instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const state = {
  email: "",
  isAdmin: false,
  lang: "en" as Lang,
  parts: null as Record<Part, PartView> | null,
  current: null as Part | null,
  busy: false,
  adminSel: null as string | null,
};

function show(id: string): void {
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((view) => {
    view.hidden = view.id !== id;
  });
}

function banner(message: string): void {
  const b = $("banner");
  b.textContent = message;
  b.hidden = message === "";
}

type ErrorContext = "interview" | "writeup" | "general";

function errorText(err: unknown, context: ErrorContext): string {
  if (err instanceof api.ConnectionError) return t("e_connection");
  if (!(err instanceof api.ApiError)) return t("e_generic");
  const byCode: Partial<Record<string, MessageKey>> = {
    unauthenticated: "e_session",
    conflict: "e_conflict",
    wrong_state: "e_conflict",
    limit_reached: "e_limit",
    model_unavailable: context === "writeup" ? "e_writeup_failed" : "e_model_unavailable",
    model_failed: context === "writeup" ? "e_writeup_failed" : "e_model_failed",
  };
  return t(byCode[err.code] ?? "e_generic");
}

function currentPart(): PartView {
  if (!state.parts || !state.current) throw new Error("no current part");
  return state.parts[state.current];
}

function setPart(view: PartView): void {
  if (state.parts) state.parts[view.part] = view;
}

/** Reloads the person's interview from the server (after an error or a conflict). */
async function resync(): Promise<void> {
  const me = await api.getMe();
  state.parts = me.interview?.parts ?? null;
  if (me.interview) state.lang = me.interview.lang;
}

/* ---------- boot ---------- */

async function boot(): Promise<void> {
  let me;
  try {
    me = await api.getMe();
  } catch (err) {
    show("v-boot");
    banner(errorText(err, "general"));
    return;
  }
  state.email = me.email;
  state.isAdmin = me.isAdmin;
  state.parts = me.interview?.parts ?? null;
  if (me.interview) state.lang = me.interview.lang;
  if (me.isAdmin) {
    void startAdmin();
    return;
  }
  startParticipant();
}

/* ---------- participant ---------- */

function startParticipant(): void {
  banner("");
  $("to-admin").hidden = !state.isAdmin;
  if (!state.parts) {
    $("parts").hidden = true;
    show("v-lang");
    return;
  }
  setLang(state.lang);
  $("h-sub").textContent = t("sub");
  route();
}

async function chooseLang(lang: Lang): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    const interview = await api.startInterview(lang);
    state.lang = interview.lang;
    state.parts = interview.parts;
  } catch (err) {
    if (err instanceof api.ApiError && err.code === "conflict") await resync().catch(() => undefined);
    else {
      banner(errorText(err, "general"));
      return;
    }
  } finally {
    state.busy = false;
  }
  startParticipant();
}

function renderPartsBadge(): void {
  if (!state.parts) return;
  $("parts").hidden = false;
  for (const part of PARTS) {
    $(`p-${part}`).className = state.parts[part].status === "confirmed" ? "done" : part === state.current ? "on" : "";
  }
}

function route(): void {
  if (!state.parts) return;
  const parts = state.parts;
  const next = PARTS.find((p) => parts[p].status !== "confirmed");
  if (!next) {
    state.current = null;
    renderPartsBadge();
    renderDone();
    return;
  }
  openPart(next);
}

function openPart(part: Part): void {
  state.current = part;
  renderPartsBadge();
  const status = currentPart().status;
  if (status === "finished") {
    renderReview();
    void writeUp();
  } else if (status === "review" || status === "confirmed") renderReview();
  else renderInterview();
}

function setHeader(prefix: "iv" | "rv"): void {
  const part = state.current;
  if (!part) return;
  const eyebrow = $(`${prefix}-eyebrow`);
  eyebrow.textContent = t(`${part}_eyebrow`);
  eyebrow.className = `eyebrow ${part}`;
  $(`${prefix}-title`).textContent = t(`${part}_title`);
}

/* ---------- interview ---------- */

function addBubble(role: "interviewer" | "person", text: string): HTMLElement {
  const bubble = el("div", `msg ${role}`, text);
  $("log").appendChild(bubble);
  return bubble;
}

function renderInterview(): void {
  show("v-interview");
  setHeader("iv");
  const part = currentPart();
  $("iv-desc").textContent = t(`${part.part}_desc`);
  $("iv-how").textContent = t("how");
  $("iv-private").textContent = t("private");
  $("iv-begin").textContent = t("begin");
  $("send").textContent = t("send");
  $("iv-retry-btn").textContent = t("retry");
  $("answer-label").textContent = t("answer_label");
  $("finish-open").textContent = t("finish_open");
  $("finish-q").textContent = t("finish_q");
  $("finish-yes").textContent = t("finish_yes");
  $("finish-no").textContent = t("finish_no");
  typed("answer", HTMLTextAreaElement).maxLength = LIMITS.answerChars;
  $("finish-confirm").hidden = true;

  $("log").replaceChildren();
  for (const m of part.messages) addBubble(m.role, m.content);
  const started = part.messages.length > 0;
  $("iv-start").hidden = started;
  $("composer").hidden = !started;
  $("finish-open").hidden = !part.messages.some((m) => m.role === "person");
  $("iv-retry").hidden = part.messages.at(-1)?.role !== "person";
  setBusy(false);
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  for (const id of ["send", "iv-begin", "iv-retry-btn", "finish-yes"]) typed(id, HTMLButtonElement).disabled = busy;
}

function afterInterviewerReply(view: PartView): void {
  setPart(view);
  if (view.status === "finished") {
    setBusy(false);
    openPart(view.part);
    return;
  }
  renderInterview();
  $("answer").focus();
}

/** Shows "Thinking…" while `call` runs; on failure resyncs so the screen matches what was saved. */
async function withInterviewer(call: () => Promise<PartView>): Promise<void> {
  const part = state.current;
  if (state.busy || !part) return;
  banner("");
  setBusy(true);
  $("iv-retry").hidden = true;
  $("iv-start").hidden = true;
  $("composer").hidden = false;
  const thinking = addBubble("interviewer", t("thinking"));
  thinking.classList.add("pending");
  thinking.scrollIntoView({ block: "nearest" });
  try {
    afterInterviewerReply(await call());
  } catch (err) {
    const message = errorText(err, "interview");
    await resync().catch(() => undefined);
    setBusy(false);
    openPart(part);
    banner(message);
  }
}

function sendAnswer(): void {
  const box = typed("answer", HTMLTextAreaElement);
  const text = box.value.trim();
  const part = state.current;
  if (!text || state.busy || !part) return;
  addBubble("person", text);
  box.value = "";
  void withInterviewer(() => api.sendAnswer(part, text));
}

async function finishPart(): Promise<void> {
  const part = state.current;
  if (!part || state.busy) return;
  setBusy(true);
  try {
    setPart(await api.finishPart(part));
  } catch (err) {
    banner(errorText(err, "general"));
    await resync().catch(() => undefined);
  }
  setBusy(false);
  openPart(part);
}

/* ---------- write-up ---------- */

let draft: { writeup: Writeup; corrections: string } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveChain: Promise<void> = Promise.resolve();

/** Part whose write-up is being created, so it is never requested twice at once. */
let writingUp: Part | null = null;

async function writeUp(): Promise<void> {
  const part = state.current;
  if (!part || writingUp === part) return;
  writingUp = part;
  $("rv-working").hidden = false;
  $("rv-again-row").hidden = true;
  $("rv-working-msg").textContent = t("rv_working");
  try {
    setPart(await api.createWriteup(part));
    if (state.current === part) renderReview();
  } catch (err) {
    if (state.current === part) {
      $("rv-working-msg").textContent = errorText(err, "writeup");
      $("rv-again-row").hidden = false;
    }
  } finally {
    writingUp = null;
  }
}

function renderReview(): void {
  show("v-review");
  setHeader("rv");
  for (const [id, key] of [
    ["rv-desc", "rv_desc"],
    ["rv-again", "rv_again"],
    ["rv-examples-l", "examples_l"],
    ["rv-var-l", "var_l"],
    ["rv-pain-l", "pain_l"],
    ["rv-corr-l", "corr_l"],
    ["rv-add", "add"],
    ["rv-confirm", "confirm"],
  ] as const) {
    $(id).textContent = t(key);
  }
  $("rv-saved").textContent = "";
  const part = currentPart();
  if (!part.writeup) {
    $("rv-body").hidden = true;
    $("rv-working").hidden = false;
    $("rv-working-msg").textContent = t("rv_working");
    return;
  }
  draft = { writeup: structuredClone(part.writeup), corrections: part.corrections };
  $("rv-working").hidden = true;
  $("rv-body").hidden = false;
  typed("rv-examples", HTMLInputElement).value = draft.writeup.examples;
  typed("rv-var", HTMLTextAreaElement).value = draft.writeup.variations.join("\n");
  typed("rv-pain", HTMLTextAreaElement).value = draft.writeup.painPoints.join("\n");
  typed("rv-corr", HTMLTextAreaElement).value = draft.corrections;
  typed("rv-corr", HTMLTextAreaElement).maxLength = LIMITS.correctionsChars;
  renderSteps();
}

function field(labelKey: MessageKey, value: string, multiline: boolean, id: string, onChange: (v: string) => void): HTMLElement {
  const wrap = el("div", "field");
  const label = el("label", undefined, t(labelKey));
  const input = multiline ? el("textarea") : el("input");
  if (input instanceof HTMLInputElement) input.type = "text";
  else input.rows = 2;
  input.id = id;
  input.maxLength = LIMITS.writeupTextChars;
  label.htmlFor = id;
  input.value = value;
  input.addEventListener("input", () => {
    onChange(input.value);
    scheduleSave();
  });
  wrap.append(label, input);
  return wrap;
}

function renderSteps(): void {
  if (!draft || !state.current) return;
  const steps = draft.writeup.steps;
  const box = $("rv-steps");
  box.replaceChildren();
  steps.forEach((step, i) => {
    const row = el("div", "step");
    const fields = el("div", "fields");
    const base = `st-${state.current ?? ""}-${i}`;
    fields.append(field("what_l", step.what, true, `${base}-what`, (v) => (step.what = v)));
    const grid = el("div", "grid2");
    const keys: [keyof WriteupStep, MessageKey][] = [
      ["tool", "tool_l"],
      ["who", "who_l"],
      ["info", "info_l"],
      ["time", "time_l"],
    ];
    for (const [key, label] of keys) grid.append(field(label, step[key], false, `${base}-${key}`, (v) => (step[key] = v)));
    const remove = el("button", "linkish rm", t("remove"));
    remove.type = "button";
    remove.addEventListener("click", () => {
      steps.splice(i, 1);
      renderSteps();
      scheduleSave(0);
    });
    fields.append(grid, remove);
    row.append(el("div", "n", String(i + 1).padStart(2, "0")), fields);
    box.appendChild(row);
  });
  typed("rv-add", HTMLButtonElement).disabled = steps.length >= LIMITS.writeupSteps;
}

const lines = (value: string) =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, LIMITS.writeupListItems);

function scheduleSave(delay = 800): void {
  clearTimeout(saveTimer);
  $("rv-saved").textContent = t("saving");
  saveTimer = setTimeout(() => void flushSave(), delay);
}

/** Saves the draft now, one save at a time. Resolves false if it could not be saved. */
function flushSave(): Promise<boolean> {
  clearTimeout(saveTimer);
  const result = saveChain.then(async () => {
    const part = state.current;
    if (!draft || !part || state.parts?.[part].status !== "review") return true;
    try {
      setPart(await api.saveWriteup(part, currentPart().version, draft.writeup, draft.corrections));
      $("rv-saved").textContent = t("saved");
      return true;
    } catch (err) {
      banner(errorText(err, "general"));
      if (err instanceof api.ApiError && (err.code === "conflict" || err.code === "wrong_state")) {
        await resync().catch(() => undefined);
        openPart(part);
      }
      return false;
    }
  });
  saveChain = result.then(() => undefined);
  return result;
}

async function confirmPart(): Promise<void> {
  const part = state.current;
  if (!part || state.busy) return;
  state.busy = true;
  typed("rv-confirm", HTMLButtonElement).disabled = true;
  try {
    if (!(await flushSave())) return;
    setPart(await api.confirmPart(part, currentPart().version));
    window.scrollTo(0, 0);
    route();
  } catch (err) {
    banner(errorText(err, "general"));
    await resync().catch(() => undefined);
    openPart(part);
  } finally {
    state.busy = false;
    typed("rv-confirm", HTMLButtonElement).disabled = false;
  }
}

/* ---------- done ---------- */

function renderDone(): void {
  show("v-done");
  $("dn-title").textContent = t("dn_title");
  $("dn-desc").textContent = t("dn_desc");
  $("dn-edit-load").textContent = t("edit_load");
  $("dn-edit-buyer").textContent = t("edit_buyer");
}

async function reopen(part: Part): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  try {
    setPart(await api.reopenPart(part));
    openPart(part);
  } catch (err) {
    banner(errorText(err, "general"));
  } finally {
    state.busy = false;
  }
}

/* ---------- owner overview (English only) ---------- */

const STATUS_LABEL: Record<PartStatus, string> = {
  not_started: "Not started",
  interviewing: "In progress",
  finished: "Writing up",
  review: "Awaiting their check",
  confirmed: "Confirmed",
};
const STATUS_CLASS: Record<PartStatus, string> = {
  not_started: "",
  interviewing: "prog",
  finished: "prog",
  review: "rev",
  confirmed: "ok",
};

function statusPill(status: PartStatus, answers: number): HTMLElement {
  const label = status === "interviewing" ? `${STATUS_LABEL[status]} · ${answers} ${answers === 1 ? "answer" : "answers"}` : STATUS_LABEL[status];
  return el("span", `pill ${STATUS_CLASS[status]}`, label);
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function startAdmin(): Promise<void> {
  setLang("en");
  banner("");
  $("h-sub").textContent = "Sales flow interviews";
  $("parts").hidden = true;
  $("to-admin").hidden = true;
  show("v-admin");
  try {
    renderAdminList(await api.listInterviews());
    if (state.adminSel) await showAdminDetail(state.adminSel);
  } catch (err) {
    banner(errorText(err, "general"));
  }
}

function renderAdminList(items: AdminListItem[]): void {
  $("ad-empty").hidden = items.length > 0;
  $("ad-tbl-wrap").hidden = items.length === 0;
  const body = $("ad-rows");
  body.replaceChildren();
  for (const item of items) {
    const tr = el("tr", `pick${state.adminSel === item.email ? " sel" : ""}`);
    tr.tabIndex = 0;
    const cell = (child: Node | string, className?: string) => {
      const td = el("td", className);
      td.append(child);
      tr.append(td);
    };
    cell(item.email);
    cell(item.lang.toUpperCase());
    cell(statusPill(item.parts.load.status, item.parts.load.personMessages));
    cell(statusPill(item.parts.buyer.status, item.parts.buyer.personMessages));
    cell(formatDate(item.updatedAt), "num");
    const pick = () => {
      state.adminSel = item.email;
      body.querySelectorAll("tr").forEach((row) => row.classList.toggle("sel", row === tr));
      void showAdminDetail(item.email).catch((err: unknown) => {
        banner(errorText(err, "general"));
      });
    };
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    body.append(tr);
  }
}

async function showAdminDetail(email: string): Promise<void> {
  renderAdminDetail(await api.getInterview(email));
}

function labelled(label: string, value: string): HTMLElement {
  const span = el("span");
  span.append(el("b", undefined, `${label}: `), document.createTextNode(value));
  return span;
}

function renderAdminDetail(interview: AdminInterview): void {
  const box = $("ad-detail");
  box.replaceChildren(el("h2", undefined, interview.email));
  for (const partKey of PARTS) {
    const part = interview.parts[partKey];
    const panel = el("div", "panel");
    const head = el("div", "row spread");
    const titles = el("div", "stack tight");
    titles.append(
      el("p", `eyebrow ${partKey}`, partKey === "load" ? "Part 1" : "Part 2"),
      el("h3", undefined, partKey === "load" ? "A load becomes available" : "A buyer needs a load"),
    );
    head.append(titles, statusPill(part.status, part.messages.filter((m) => m.role === "person").length));
    panel.append(head);
    if (part.status === "confirmed") panel.append(el("p", "notice", `Confirmed by them ${formatDate(part.confirmedAt)}`));
    if (part.status === "review") panel.append(el("p", "notice", "Write-up generated; they haven't confirmed it yet."));
    const w = part.writeup;
    if (w) {
      if (w.examples) {
        const p = el("p");
        p.append(el("b", undefined, "Examples: "), document.createTextNode(w.examples));
        panel.append(p);
      }
      const list = el("ol", "flow");
      for (const step of w.steps) {
        const li = el("li");
        li.append(el("div", "prewrap", step.what));
        const meta = el("div", "meta");
        for (const [label, value] of [
          ["Tool", step.tool],
          ["Who", step.who],
          ["Info", step.info],
          ["Time", step.time],
        ] as const) {
          if (value) meta.append(labelled(label, value));
        }
        if (meta.childElementCount) li.append(meta);
        list.append(li);
      }
      panel.append(list);
      if (w.variations.length) {
        const ul = el("ul", "plain");
        for (const v of w.variations) ul.append(el("li", undefined, v));
        panel.append(el("h3", undefined, "Variations"), ul);
      }
      if (w.painPoints.length) {
        const ul = el("ul", "plain");
        for (const v of w.painPoints) ul.append(el("li", undefined, v));
        panel.append(el("h3", undefined, "What goes wrong or slows them down"), ul);
      }
    }
    if (part.corrections) panel.append(el("h3", undefined, "Their note to you"), el("p", "prewrap", part.corrections));
    if (part.messages.length) {
      const details = el("details");
      details.append(el("summary", undefined, `Full transcript (${part.messages.length} messages)`));
      const tx = el("div", "tx");
      for (const m of part.messages) tx.append(el("div", "who", m.role === "interviewer" ? "Interviewer" : interview.email), el("div", "prewrap", m.content));
      details.append(tx);
      panel.append(details);
    } else if (!w) panel.append(el("p", "notice", "Not started."));
    box.append(panel);
  }
}

/* ---------- wiring ---------- */

$("lang-en").addEventListener("click", () => void chooseLang("en"));
$("lang-es").addEventListener("click", () => void chooseLang("es"));
$("iv-begin").addEventListener("click", () => {
  const part = state.current;
  if (part) void withInterviewer(() => api.ask(part));
});
$("iv-retry-btn").addEventListener("click", () => {
  const part = state.current;
  if (part) void withInterviewer(() => api.ask(part));
});
$("send").addEventListener("click", sendAnswer);
$("answer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendAnswer();
  }
});
$("finish-open").addEventListener("click", () => ($("finish-confirm").hidden = false));
$("finish-no").addEventListener("click", () => ($("finish-confirm").hidden = true));
$("finish-yes").addEventListener("click", () => void finishPart());
$("rv-again").addEventListener("click", () => void writeUp());
$("rv-examples").addEventListener("input", (e) => {
  if (!draft) return;
  draft.writeup.examples = (e.target as HTMLInputElement).value;
  scheduleSave();
});
$("rv-var").addEventListener("input", (e) => {
  if (!draft) return;
  draft.writeup.variations = lines((e.target as HTMLTextAreaElement).value);
  scheduleSave();
});
$("rv-pain").addEventListener("input", (e) => {
  if (!draft) return;
  draft.writeup.painPoints = lines((e.target as HTMLTextAreaElement).value);
  scheduleSave();
});
$("rv-corr").addEventListener("input", (e) => {
  if (!draft) return;
  draft.corrections = (e.target as HTMLTextAreaElement).value;
  scheduleSave();
});
$("rv-add").addEventListener("click", () => {
  if (!draft) return;
  draft.writeup.steps.push({ what: "", tool: "", who: "", info: "", time: "" });
  renderSteps();
  scheduleSave(0);
});
$("rv-confirm").addEventListener("click", () => void confirmPart());
$("dn-edit-load").addEventListener("click", () => void reopen("load"));
$("dn-edit-buyer").addEventListener("click", () => void reopen("buyer"));
$("ad-self").addEventListener("click", () => {
  void resync()
    .then(startParticipant)
    .catch((err: unknown) => {
      banner(errorText(err, "general"));
    });
});
$("ad-refresh").addEventListener("click", () => void startAdmin());
$("to-admin").addEventListener("click", () => void startAdmin());

void boot();
