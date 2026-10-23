"use client";

/**
 * Daily Tasks — the browser side of /api/tasks (Daily Tasks spec 13). Shared by the task centre and the
 * secretary's "היום שלי".
 *
 * Every write carries an Idempotency-Key (UUIDv7). A retry of the SAME intent reuses its key — `keyFor(intent)`
 * keeps one per intent until it succeeds — so a lost answer never becomes a second write (12.9, T-Y4).
 */
import { buildClientAuthHeaders } from "@/lib/client-session";
import type { Translator } from "@/lib/i18n/translate";
import type { AgendaResponse } from "@/lib/services/tasks/agenda.service";

export type { AgendaResponse };

export class TasksApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfter?: number) {
    super(code);
  }
}

/** UUIDv7: 48-bit ms timestamp, version 7, variant 10, random rest. */
export function uuidV7(at: Date = new Date()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = at.getTime();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pendingKeys = new Map<string, { key: string; at: number }>();
const KEY_REUSE_MS = 23 * 60 * 60 * 1000;

/** One key per intent until it succeeds (then `settleKey`), never older than the server's window. */
export function keyFor(intent: string): string {
  const hit = pendingKeys.get(intent);
  if (hit && Date.now() - hit.at < KEY_REUSE_MS) return hit.key;
  const key = uuidV7();
  pendingKeys.set(intent, { key, at: Date.now() });
  return key;
}
export function settleKey(intent: string): void {
  pendingKeys.delete(intent);
}

async function call<T>(method: string, url: string, body?: unknown, key?: string): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: "no-store",
    headers: buildClientAuthHeaders(key ? { "Idempotency-Key": key } : undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const retry = Number(res.headers.get("Retry-After"));
    throw new TasksApiError(res.status, String(json.error ?? res.status), Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return json as T;
}

/** A write with its intent's key; the key is released only after the server answered OK. */
export async function write<T>(intent: string, method: string, url: string, body: unknown): Promise<T> {
  const key = keyFor(intent);
  const out = await call<T>(method, url, body, key);
  settleKey(intent);
  return out;
}

export const fetchAgenda = () => call<AgendaResponse>("GET", "/api/tasks/agenda");

export type SyncAnswer =
  | { status: "OK"; syncVersion: number; changed: boolean }
  | { status: "IN_PROGRESS"; syncVersion: number; retryAfterSeconds: number };

export async function postSync(key: string): Promise<SyncAnswer> {
  try {
    return await call<SyncAnswer>("POST", "/api/tasks/sync", {}, key);
  } catch (e) {
    if (e instanceof TasksApiError && e.status === 409 && e.code !== "IDEMPOTENCY_KEY_STALE" && e.code !== "IDEMPOTENCY_KEY_REUSED") {
      return { status: "IN_PROGRESS", syncVersion: -1, retryAfterSeconds: e.retryAfter ?? 30 };
    }
    throw e;
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

export type LinkInput = { kind: "customer" | "supplier" | "lead" | "document"; id: number } | null;
export type RuleInput =
  | { kind: "DAILY" }
  | { kind: "WEEKDAYS"; weekdays: number[] }
  | { kind: "MONTH_DAY"; monthDay: number }
  | { kind: "EVERY_N_DAYS"; intervalDays: number };

export const createTask = (intent: string, input: { title: string; note?: string | null; dueOn: string | null; link: LinkInput; origin?: "OWNER" | "SECRETARY" }) =>
  write("create:" + intent, "POST", "/api/tasks", input);

export const createSeries = (intent: string, input: { title: string; note?: string | null; link: LinkInput; rule: RuleInput; startOn?: string }) =>
  write("series:" + intent, "POST", "/api/tasks/series", input);

export const editTask = (id: number, input: { expectedVersion: number; title?: string; note?: string | null; link?: LinkInput }) =>
  write(`edit:${id}:${input.expectedVersion}`, "PATCH", `/api/tasks/${id}`, input);

export type TaskAction = "complete" | "cancel" | "skip" | "reopen" | "reschedule" | "snooze" | "pin" | "unpin";
export const taskAction = (id: number, action: TaskAction, input: { expectedVersion: number; dueOn?: string }) =>
  write(`task:${id}:${action}:${input.expectedVersion}:${input.dueOn ?? ""}`, "POST", `/api/tasks/${id}/${action}`, input);

export type SeriesAction = "pause" | "resume" | "end";
export const seriesAction = (id: number, action: SeriesAction, expectedVersion: number) =>
  write(`series:${id}:${action}:${expectedVersion}`, "POST", `/api/tasks/series/${id}/${action}`, { expectedVersion });

export const changeSeries = (id: number, input: { expectedVersion: number; title?: string; note?: string | null; rule?: RuleInput }) =>
  write(`series-change:${id}:${input.expectedVersion}`, "PATCH", `/api/tasks/series/${id}`, input);

export type SourceOp =
  | "acknowledge" | "snooze" | "pin" | "unpin"
  | "lead_done" | "lead_snooze" | "payment_handled" | "payment_snooze" | "payment_paid";
export const sourceOp = (op: SourceOp, ref: { sourceKind: string; dedupeKey: string }, extra: Record<string, string> = {}) =>
  write(`source:${op}:${ref.dedupeKey}:${JSON.stringify(extra)}`, "POST", `/api/tasks/source-items/${op}`, { ...ref, ...extra });

export const ackQueue = (sourceKind: string, dedupeKeys: string[]) =>
  write(`queue-ack:${sourceKind}:${[...dedupeKeys].sort().join(",")}`, "POST", "/api/tasks/source-items/acknowledge_queue", { sourceKind, dedupeKeys });

export type ItemHistoryEntry = { kind: string; at: string; actor: "OWNER_USER" | "SYSTEM"; until?: string | null };
export const fetchItemHistory = (sourceKind: string, dedupeKey: string) =>
  call<{ history: ItemHistoryEntry[] }>("GET", `/api/tasks/source-items/history?sourceKind=${encodeURIComponent(sourceKind)}&dedupeKey=${encodeURIComponent(dedupeKey)}`);

export type LinkOption = { kind: "customer" | "supplier"; id: number; label: string };
export const searchLinks = (q: string) => call<{ options: LinkOption[] }>("GET", `/api/tasks/links?q=${encodeURIComponent(q)}`);

// ── Errors in the owner's words ─────────────────────────────────────────────────────────────────

/** `t`: the interface language (useI18n().t). */
export function errorText(e: unknown, t: Translator): string {
  const code = e instanceof TasksApiError ? e.code : "";
  switch (code) {
    case "VERSION_CONFLICT":
    case "CONFLICT":
      return t("system.tasks.errors.conflict");
    case "NOT_FOUND":
      return t("system.tasks.errors.notFound");
    case "INVALID_INPUT":
      return t("system.tasks.errors.invalidInput");
    case "INVALID_STATE":
    case "NEXT_OCCURRENCE_IN_PROGRESS":
    case "NOT_LATEST_OCCURRENCE":
      return t("system.tasks.errors.invalidState");
    case "SERIES_ENDED":
      return t("system.tasks.errors.seriesEnded");
    case "LINK_NOT_FOUND":
      return t("system.tasks.errors.linkNotFound");
    case "LINK_LEAD_OPEN":
      return t("system.tasks.errors.linkLeadOpen");
    case "IDEMPOTENCY_KEY_STALE":
      return t("system.tasks.errors.keyStale");
    default:
      return t("system.tasks.errors.saveFailed");
  }
}
