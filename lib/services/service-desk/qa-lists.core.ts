/**
 * Service Desk — per-business QA lists (migration 20261129090000). PURE: no database, no clock. The service
 * (qa-lists.service.ts) reads and writes; this decides.
 *
 * Owner decision 2026-11-11: every business that uses Service Desk defines its own QA lists — nothing depends on its
 * category. A list starts empty or from a built-in SUGGESTED template (qa-templates.ts, copied — never linked; every
 * built-in check is optional, owner 2026-11-12, so a copy starts all-optional); the business names it, adds / removes / reorders checks and decides per check whether it is REQUIRED. Every edit is a new
 * immutable version; a case names the version it is checked against, so an edit never reaches an older case.
 *
 *   parseListInput      the body of a create / revise: a name and the checks (or, on a create, a template to copy)
 *   planNewList         version 1: the template's checks or the given ones, every check keyed (stable token)
 *   planRevision        the next version against the current one: a kept check keeps its key; NO_CHANGE refused
 *   evaluateChecklist   results against ANY checklist (a list version or a built-in template): PASS / FAIL per check, an
 *                       optional note; complete only when every REQUIRED check PASSES (and, for a built-in template —
 *                       every check a suggestion, owner 2026-11-12 — only when every check is recorded); unknown keys /
 *                       values refused
 *   decideChoice        whether a case may name a list now (the track's QA mode, its status, the list's state)
 */
import { QA_TEMPLATE_BY_ID, type QaTemplate } from "./qa-templates";
import type { QaMode } from "./service-profiles";
import type { ServiceCaseKind, ServiceCaseStatus, ServiceTrackFacts } from "./contracts";

export const QA_LIST_NAME_MAX = 120;
export const QA_ITEM_LABEL_MAX = 200;
export const QA_LIST_ITEMS_MAX = 100;
export const QA_NOTE_MAX = 500;
/** The database's token for a check key (CHECK ServiceQaListItem_key). */
export const QA_ITEM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type QaListItem = { key: string; label: string; required: boolean };
export type QaItemInput = { key: string | null; label: string; required: boolean };
export type QaListInput = { name: string; items: QaItemInput[] | null; fromTemplate: string | null };
export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const len = (s: string) => [...s].length;

function parseText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (len(t) < 1 || len(t) > max || CONTROL.test(t)) return null;
  return t;
}

/**
 * A create (`allowTemplate`) or a revise body: `name` (1–120, trimmed, no control characters) and `items` — 1–100 checks,
 * each `{ key?, label, required }` (label 1–200; required a boolean; key, when sent, a token, unique in the list). On a
 * create, `fromTemplate` (a built-in template id) may replace `items` (its checks are copied) or accompany them (then it
 * only records where the list came from).
 */
export function parseListInput(body: Record<string, unknown>, opts: { allowTemplate: boolean }): Parsed<QaListInput> {
  const name = parseText(body.name, QA_LIST_NAME_MAX);
  if (name === null) return { ok: false, field: "name" };
  let fromTemplate: string | null = null;
  if (body.fromTemplate !== undefined && body.fromTemplate !== null) {
    if (!opts.allowTemplate || typeof body.fromTemplate !== "string" || !Object.prototype.hasOwnProperty.call(QA_TEMPLATE_BY_ID, body.fromTemplate)) {
      return { ok: false, field: "fromTemplate" };
    }
    fromTemplate = body.fromTemplate;
  }
  if (body.items === undefined || body.items === null) {
    if (fromTemplate === null) return { ok: false, field: "items" };
    return { ok: true, value: { name, items: null, fromTemplate } };
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > QA_LIST_ITEMS_MAX) return { ok: false, field: "items" };
  const items: QaItemInput[] = [];
  const keys = new Set<string>();
  for (const [i, raw] of body.items.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, field: `items[${i}]` };
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== "key" && k !== "label" && k !== "required") return { ok: false, field: `items[${i}]` };
    const label = parseText(r.label, QA_ITEM_LABEL_MAX);
    if (label === null) return { ok: false, field: `items[${i}].label` };
    if (typeof r.required !== "boolean") return { ok: false, field: `items[${i}].required` };
    let key: string | null = null;
    if (r.key !== undefined && r.key !== null) {
      if (typeof r.key !== "string" || !QA_ITEM_KEY.test(r.key) || keys.has(r.key)) return { ok: false, field: `items[${i}].key` };
      key = r.key;
      keys.add(key);
    }
    items.push({ key, label, required: r.required });
  }
  return { ok: true, value: { name, items, fromTemplate } };
}

/** A fresh key for a new check of version `version`: i<version>_<n>, never one the list ever used. */
function freshKey(version: number, used: Set<string>): string {
  for (let n = 1; ; n++) {
    const k = `i${version}_${n}`;
    if (!used.has(k)) { used.add(k); return k; }
  }
}

export type PlannedVersion = { name: string; items: QaListItem[]; requiredCount: number };

function planned(name: string, items: QaListItem[]): PlannedVersion {
  return { name, items, requiredCount: items.filter((i) => i.required).length };
}

/** Version 1 of a new list: the template's checks (keys, labels, REQUIRED flags copied) or the given checks. */
export function planNewList(input: QaListInput): PlannedVersion & { sourceTemplateId: string | null } {
  const template: QaTemplate | null = input.fromTemplate ? QA_TEMPLATE_BY_ID[input.fromTemplate] : null;
  if (input.items === null) {
    const items = (template as QaTemplate).items.map((i) => ({ key: i.key, label: i.label, required: i.required }));
    return { ...planned(input.name, items), sourceTemplateId: input.fromTemplate };
  }
  const used = new Set(input.items.flatMap((i) => (i.key ? [i.key] : [])));
  const items = input.items.map((i) => ({ key: i.key ?? freshKey(1, used), label: i.label, required: i.required }));
  return { ...planned(input.name, items), sourceTemplateId: input.fromTemplate };
}

export type RevisionChanges = { name: boolean; added: number; removed: number; relabeled: number; requiredChanged: number; reordered: boolean };
export type RevisionPlan =
  | { ok: true; version: PlannedVersion; changes: RevisionChanges }
  | { ok: false; code: "NO_CHANGE" | "UNKNOWN_ITEM_KEY" };

/**
 * The next version: a check sent with a key keeps that key (it must be a check of the CURRENT version — a removed check
 * does not come back under its old key); a check sent without one is new and gets a fresh key never used in this list
 * (`everUsedKeys`). Refused when nothing changed (name, checks, labels, REQUIRED flags and order all equal).
 */
export function planRevision(current: { name: string; items: readonly QaListItem[] }, input: QaListInput, nextVersion: number, everUsedKeys: readonly string[]): RevisionPlan {
  const items = input.items as QaItemInput[];
  const byKey = new Map(current.items.map((i) => [i.key, i]));
  for (const i of items) if (i.key !== null && !byKey.has(i.key)) return { ok: false, code: "UNKNOWN_ITEM_KEY" };
  const used = new Set([...everUsedKeys, ...current.items.map((i) => i.key)]);
  const next: QaListItem[] = items.map((i) => ({ key: i.key ?? freshKey(nextVersion, used), label: i.label, required: i.required }));
  const kept = next.filter((i) => byKey.has(i.key));
  const changes: RevisionChanges = {
    name: input.name !== current.name,
    added: next.length - kept.length,
    removed: current.items.length - kept.length,
    relabeled: kept.filter((i) => byKey.get(i.key)!.label !== i.label).length,
    requiredChanged: kept.filter((i) => byKey.get(i.key)!.required !== i.required).length,
    reordered: kept.map((i) => i.key).join("|") !== current.items.filter((i) => next.some((n) => n.key === i.key)).map((i) => i.key).join("|"),
  };
  const any = changes.name || changes.added > 0 || changes.removed > 0 || changes.relabeled > 0 || changes.requiredChanged > 0 || changes.reordered;
  if (!any) return { ok: false, code: "NO_CHANGE" };
  return { ok: true, version: planned(input.name, next), changes };
}

// ── Results ─────────────────────────────────────────────────────────────────────────────────────────────────

export type QaResultValue = "PASS" | "FAIL";
export type ItemResult = { key: string; required: boolean; result: QaResultValue; note: string | null };
export type ChecklistEvaluation =
  | {
      ok: true;
      completed: boolean;
      results: ItemResult[];
      counts: { items: number; recorded: number; passed: number; failed: number; requiredFailed: number; requiredMissing: number };
    }
  | { ok: false; field: string };

/**
 * Results against a checklist: `{ <key>: "PASS" | "FAIL" | { result: "PASS" | "FAIL", note?: string } }`. Every key must be
 * a check of THIS checklist and every value a result (unknown keys / values refused, never ignored); at least one result;
 * a note 1–500 characters (trimmed; blank = none) only when `notes` is allowed. Complete ⇔ every REQUIRED check PASS and,
 * with `everyCheckRecorded` (a built-in template: its checks are suggestions, so completing it means it was performed),
 * every check recorded — PASS or FAIL.
 * Results come back in the checklist's order.
 */
export function evaluateChecklist(items: readonly { key: string; required: boolean }[], results: unknown, opts: { notes: boolean; everyCheckRecorded?: boolean }): ChecklistEvaluation {
  if (!results || typeof results !== "object" || Array.isArray(results)) return { ok: false, field: "results" };
  const entries = Object.entries(results as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, field: "results" };
  const byKey = new Map(items.map((i) => [i.key, i]));
  const given = new Map<string, { result: QaResultValue; note: string | null }>();
  for (const [key, value] of entries) {
    if (!byKey.has(key)) return { ok: false, field: `results.${key}`.slice(0, 60) };
    if (value === "PASS" || value === "FAIL") { given.set(key, { result: value, note: null }); continue; }
    if (!opts.notes || !value || typeof value !== "object" || Array.isArray(value)) return { ok: false, field: `results.${key}` };
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v)) if (k !== "result" && k !== "note") return { ok: false, field: `results.${key}` };
    if (v.result !== "PASS" && v.result !== "FAIL") return { ok: false, field: `results.${key}.result` };
    let note: string | null = null;
    if (v.note !== undefined && v.note !== null) {
      if (typeof v.note !== "string") return { ok: false, field: `results.${key}.note` };
      const t = v.note.trim();
      if (len(t) > QA_NOTE_MAX) return { ok: false, field: `results.${key}.note` };
      note = t === "" ? null : t;
    }
    given.set(key, { result: v.result, note });
  }
  const out: ItemResult[] = items.filter((i) => given.has(i.key)).map((i) => ({ key: i.key, required: i.required, ...given.get(i.key)! }));
  const requiredFailed = out.filter((r) => r.required && r.result === "FAIL").length;
  const requiredMissing = items.filter((i) => i.required && !given.has(i.key)).length;
  const passed = out.filter((r) => r.result === "PASS").length;
  return {
    ok: true,
    completed: requiredFailed === 0 && requiredMissing === 0 && (opts.everyCheckRecorded !== true || out.length === items.length),
    results: out,
    counts: { items: items.length, recorded: out.length, passed, failed: out.length - passed, requiredFailed, requiredMissing },
  };
}

// ── The case's choice ───────────────────────────────────────────────────────────────────────────────────────

/** Past QA (or never to be checked): the choice is fixed. Mirrors service_case_qa_list_guard. */
export const QA_CHOICE_FIXED_STATUSES: readonly ServiceCaseStatus[] = ["READY", "WORK_DONE", "DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"];

/** The QA mode a case is judged by — the core's rule: its track's (snapshot), else IN_SHOP REQUIRED, on-site OFF. */
export function caseQaMode(kind: ServiceCaseKind, track: ServiceTrackFacts | null): QaMode {
  return track ? track.requirements.qa.mode : kind === "IN_SHOP" ? "REQUIRED" : "OFF";
}

export type ChoiceViolation = "QA_LIST_FIXED" | "QA_NOT_FOR_KIND" | "QA_LIST_ARCHIVED" | "NO_CHANGE";
export type ChoiceDecision = { ok: true; to: { listId: number; listVersion: number } | null } | { ok: false; violations: ChoiceViolation[] };

/**
 * Whether a case may name `target` now (null = back to its built-in template). A list is never required: the absence of
 * a list never blocks anything. With QA OFF on the track there is nothing to check, so no list is named (clearing one is
 * always allowed). The list's CURRENT version is taken; an archived list is not offered.
 */
export function decideChoice(input: {
  status: ServiceCaseStatus;
  mode: QaMode;
  current: { listId: number; listVersion: number } | null;
  target: { listId: number; currentVersion: number; archived: boolean } | null;
}): ChoiceDecision {
  const v: ChoiceViolation[] = [];
  if (QA_CHOICE_FIXED_STATUSES.includes(input.status)) v.push("QA_LIST_FIXED");
  if (input.target !== null) {
    if (input.mode === "OFF") v.push("QA_NOT_FOR_KIND");
    if (input.target.archived) v.push("QA_LIST_ARCHIVED");
  }
  const to = input.target === null ? null : { listId: input.target.listId, listVersion: input.target.currentVersion };
  const same = to === null ? input.current === null : input.current !== null && input.current.listId === to.listId && input.current.listVersion === to.listVersion;
  if (same) v.push("NO_CHANGE");
  return v.length > 0 ? { ok: false, violations: v } : { ok: true, to };
}

/** The journal payload of a choice: numbers and null only (ServiceCaseEvent_payload_closed; the deferred guard reads listId / listVersion). */
export function choicePayload(from: { listId: number; listVersion: number } | null, to: { listId: number; listVersion: number } | null) {
  return { listId: to?.listId ?? null, listVersion: to?.listVersion ?? null, fromListId: from?.listId ?? null, fromListVersion: from?.listVersion ?? null };
}

/** The token a list version leaves in ServiceCase.qaChecklist.template and the qa.recorded payload. */
export const listChecklistToken = (listId: number, version: number) => `list:${listId}:v${version}`;
