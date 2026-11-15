/**
 * Service Desk — the business's own DEFAULT QA list per service track (migration 20261130100000). PURE: no database, no
 * clock. The service (qa-track-defaults.service.ts) and the opening (service-case.service.ts openCase) read and write;
 * this decides.
 *
 * Owner decision 2026-11-12: the default is chosen BY THE BUSINESS, per track (T1–T7) — never derived from its category;
 * the built-in templates stay suggestions. It reuses the QA lists of #1124 / #1125 and their case choice unchanged:
 *
 *   decideDefaultChange   whether a track's default may become `listId` (or none) now: the list exists in the business
 *                         and is active; NO_CHANGE refused; the first default of a track names a list
 *   resolveOpeningQaList  which list VERSION a case opened now names: an explicit choice in the request (a list, or
 *                         explicitly none) wins; otherwise the track's default — only when the case has a track, its QA
 *                         is not OFF, and the default list is still ACTIVE (an archived default counts as no default; a
 *                         restored one counts again). The list's CURRENT version is pinned; later edits, archive, a new
 *                         default never reach the case (it names a version, never the default).
 */
import type { QaMode, ServiceTrack } from "./service-profiles";
import { SERVICE_TRACKS } from "./service-profiles";

export const isTrackToken = (v: unknown): v is ServiceTrack => typeof v === "string" && (SERVICE_TRACKS as readonly string[]).includes(v);

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const isNonNegativeInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export type SetDefaultInput = { listId: number | null; expectedRevision: number };
export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

/** PUT body: `listId` — a positive id or null (no default); `expectedRevision` — the track's revision as read (0 = never set). */
export function parseSetDefault(body: Record<string, unknown>): Parsed<SetDefaultInput> {
  for (const k of Object.keys(body)) if (k !== "listId" && k !== "expectedRevision") return { ok: false, field: k.slice(0, 40) };
  const listId = body.listId === undefined ? undefined : body.listId;
  if (listId === undefined || (listId !== null && !isPositiveInt(listId))) return { ok: false, field: "listId" };
  if (!isNonNegativeInt(body.expectedRevision)) return { ok: false, field: "expectedRevision" };
  return { ok: true, value: { listId, expectedRevision: body.expectedRevision } };
}

export type DefaultViolation = "QA_LIST_NOT_FOUND" | "QA_LIST_ARCHIVED" | "NO_CHANGE";
export type DefaultChangeDecision = { ok: true; listId: number | null } | { ok: false; violations: DefaultViolation[] };

/**
 * `current` = the track's latest row (null = never set). `target` = the list as read in THIS business (null when
 * clearing; `{ found: false }` when no such list here — another business's list is simply not found).
 */
export function decideDefaultChange(input: {
  current: { listId: number | null } | null;
  listId: number | null;
  target: { found: boolean; archived: boolean } | null;
}): DefaultChangeDecision {
  const v: DefaultViolation[] = [];
  if (input.listId !== null) {
    if (!input.target || !input.target.found) v.push("QA_LIST_NOT_FOUND");
    else if (input.target.archived) v.push("QA_LIST_ARCHIVED");
  }
  const currentList = input.current?.listId ?? null;
  if (currentList === input.listId) v.push("NO_CHANGE");
  return v.length > 0 ? { ok: false, violations: v } : { ok: true, listId: input.listId };
}

// ── At the opening ──────────────────────────────────────────────────────────────────────────────────────────

/** What the opening request said about the QA list: absent (use the default), explicitly none, or a list id. */
export type OpeningQaRequest = { kind: "DEFAULT" } | { kind: "NONE" } | { kind: "LIST"; listId: number };

/** `qaListId` of POST /cases: undefined → DEFAULT, null → NONE, a positive id → LIST; anything else refused. */
export function parseOpeningQaList(v: unknown): Parsed<OpeningQaRequest> {
  if (v === undefined) return { ok: true, value: { kind: "DEFAULT" } };
  if (v === null) return { ok: true, value: { kind: "NONE" } };
  if (isPositiveInt(v)) return { ok: true, value: { kind: "LIST", listId: v } };
  return { ok: false, field: "qaListId" };
}

/** Why the opening named the list it named (or none) — returned to the caller, so a skipped default is never silent. */
export type OpeningQaReason =
  | "EXPLICIT" // the request named this list
  | "EXPLICIT_NONE" // the request said: no list
  | "DEFAULT" // the track's default list, its current version
  | "NO_TRACK" // a case without a track has no track default
  | "QA_OFF" // the track's QA is OFF in the case's snapshot: nothing to check, no list
  | "NO_DEFAULT" // the business chose no default for this track (or cleared it)
  | "DEFAULT_ARCHIVED" // the default list is archived: treated as no default
  | "NOT_AVAILABLE"; // the migrations are not applied: today's behaviour

export type ListState = { listId: number; currentVersion: number; archived: boolean };
export type OpeningQaResolution =
  | { ok: true; to: { listId: number; listVersion: number } | null; reason: OpeningQaReason }
  | { ok: false; violations: ("QA_LIST_NOT_FOUND" | "QA_LIST_ARCHIVED" | "QA_NOT_FOR_KIND")[] };

/**
 * The list a NEW case names. `mode` is the case's QA mode as the case machine will judge it (its own snapshot's track
 * row; without a track, the kind's rule). `explicitList` is the requested list as read in THIS business (null = not found);
 * `defaultList` the track's current default as read (null = none); `track` null for a case without a track.
 * A REQUIRED track without a list keeps its built-in template (recordQa, unchanged) — no list is ever required.
 */
export function resolveOpeningQaList(input: {
  request: OpeningQaRequest;
  mode: QaMode;
  track: ServiceTrack | null;
  explicitList: ListState | null;
  defaultList: ListState | null;
  available: { lists: boolean; defaults: boolean };
}): OpeningQaResolution {
  const r = input.request;
  if (r.kind === "NONE") return { ok: true, to: null, reason: "EXPLICIT_NONE" };
  if (r.kind === "LIST") {
    const v: ("QA_LIST_NOT_FOUND" | "QA_LIST_ARCHIVED" | "QA_NOT_FOR_KIND")[] = [];
    if (input.mode === "OFF") v.push("QA_NOT_FOR_KIND");
    const l = input.explicitList;
    if (!l || l.listId !== r.listId) v.push("QA_LIST_NOT_FOUND");
    else if (l.archived) v.push("QA_LIST_ARCHIVED");
    if (v.length > 0) return { ok: false, violations: v };
    return { ok: true, to: { listId: l!.listId, listVersion: l!.currentVersion }, reason: "EXPLICIT" };
  }
  if (!input.available.lists || !input.available.defaults) return { ok: true, to: null, reason: "NOT_AVAILABLE" };
  if (input.track === null) return { ok: true, to: null, reason: "NO_TRACK" };
  if (input.mode === "OFF") return { ok: true, to: null, reason: "QA_OFF" };
  const d = input.defaultList;
  if (!d) return { ok: true, to: null, reason: "NO_DEFAULT" };
  if (d.archived) return { ok: true, to: null, reason: "DEFAULT_ARCHIVED" };
  return { ok: true, to: { listId: d.listId, listVersion: d.currentVersion }, reason: "DEFAULT" };
}

/** The journal payload of a choice made at the opening: #1124's choice payload + where it came from (a short token). */
export function openingChoicePayload(to: { listId: number; listVersion: number }, reason: "EXPLICIT" | "DEFAULT") {
  return { listId: to.listId, listVersion: to.listVersion, fromListId: null, fromListVersion: null, atOpening: true, source: reason };
}

// ── The read model (API contract) ───────────────────────────────────────────────────────────────────────────

export type QaTrackDefaultView = {
  track: ServiceTrack;
  /** 0 = never set. The PUT's expectedRevision. */
  revision: number;
  listId: number | null;
  /** The list as it stands now (name of its current version; null after the account erasure). */
  list: { id: number; name: string | null; currentVersion: number; archived: boolean } | null;
  /** The track's QA mode in the business's CURRENT profile (a new case's snapshot): REQUIRED / OPTIONAL / OFF. */
  qaMode: QaMode;
  /** A case opened on this track now would name the default (list active and QA not OFF). */
  appliesAtOpening: boolean;
  /** Why not, when it would not. */
  reason: "DEFAULT" | "NO_DEFAULT" | "DEFAULT_ARCHIVED" | "QA_OFF";
  changedAt: string | null;
  changedByUserId: number | null;
};

export function viewReason(listId: number | null, list: { archived: boolean } | null, mode: QaMode): QaTrackDefaultView["reason"] {
  // the same order as resolveOpeningQaList: QA OFF, then no default, then an archived one
  if (mode === "OFF") return "QA_OFF";
  if (listId === null || list === null) return "NO_DEFAULT";
  if (list.archived) return "DEFAULT_ARCHIVED";
  return "DEFAULT";
}
