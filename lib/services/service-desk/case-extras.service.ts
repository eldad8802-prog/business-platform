/**
 * Service Desk UI 1.3 — the owner-approved light features around a case (spec 2026-11-19, decisions 1, 5, 7):
 *   - pickup reminders  a documented pickup call while the item is READY (table ServicePhoneReminder, 1.3-0, applied);
 *                       the case counter "pickupRemindersSent" moves with it in the same transaction (ABANDON needs ≥ 1);
 *   - loaner equipment  a reminder only, never a block (table ServiceCaseLoaner, migration A7 — until it is applied every
 *                       call answers NOT_AVAILABLE_UNTIL_MIGRATION and nothing is written);
 *   - task link         an existing task of the business linked to / unlinked from a case (Task."serviceCaseId", A7);
 *   - case fields       the item location and the estimated date (A7);
 *   - activation        the business's profile and the activity types offered first (ServiceSettings, M1, applied),
 *                       journaled in ServiceSettingsEvent like every settings change.
 * The server stays the authority: every write is under the tenant (RLS) and the tables' guards; nothing here touches
 * billing or a financial document.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, uuidV7 } from "@/lib/services/tasks/task-idempotency";

import { ServiceDeskError } from "./service-desk-errors";
import {
  appendRecord, guardRefusal, isPositiveInt, lockCase, prepare, requireAuditJournalFor, type RecordAction, type ServiceDeskPrincipal, type WriteRequest,
} from "./service-case.service";
import { isServiceProfileKey, PROFILES, resolveProfileKey, SERVICE_PROFILE_KEYS, SERVICE_TRACKS, validateOverrides, type ProfileOverrides } from "./service-profiles";

/** Each profile's tracks, suggested first then enabled — what the activation screen pre-selects per profile. */
function profileCatalog(): Record<string, string[]> {
  return Object.fromEntries(SERVICE_PROFILE_KEYS.map((k) => [k, [...new Set([...PROFILES[k].defaultTracks, ...PROFILES[k].enabledTracks])]]));
}

type Tx = Parameters<Parameters<typeof tenantTx>[1]>[0];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

async function caseExists(tx: Tx, b: number, caseId: number): Promise<{ status: string } > {
  const r = (await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return r;
}

/** A case whose work is over (handed back, closed, cancelled, not collected): its working details are no longer edited. */
const FINISHED = ["DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"];
function refuseWhenFinished(status: string) {
  if (FINISHED.includes(status)) throw new ServiceDeskError("REFUSED", { violations: ["CASE_FINISHED"] });
}

/**
 * Migration 20261222090000 (owner approval 2026-11-22): the light case work — location / estimated date, a loan lent or
 * returned, a task linked or unlinked — is journaled in ServiceCaseEvent with who acted. Until that migration is applied
 * (its CHECK is absent) nothing is journaled and every write behaves exactly as before. Only a REAL change is recorded:
 * a save that changes nothing, a returned loan returned again, a task linked again writes no event (no invented history).
 */
async function caseRecordsReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place') AS ok`;
  return r[0]?.ok === true;
}
/**
 * Once the case is journaled, take its row FOR UPDATE FIRST — before the work itself. The work takes a weaker lock on the
 * same row (the loan insert's and the task link's foreign key: KEY SHARE; the fields: NO KEY UPDATE), and the record's
 * FOR UPDATE afterwards would be an upgrade: two writes on one case at the same moment would deadlock (40P01, lab A11).
 * Locked first, they queue; the fields' "what changed" is also read under the lock. Before the migration: no change.
 */
async function lockCaseFirst(tx: Tx, businessId: number, caseId: number) {
  if (!(await caseRecordsReady(tx))) return;
  await tx.$queryRaw`SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int FOR UPDATE`;
}
async function journalCaseWork(tx: Tx, p: ServiceDeskPrincipal, caseId: number, action: RecordAction, payload: Record<string, string | number | boolean | null>, key?: string) {
  if (!(await caseRecordsReady(tx))) return;
  const locked = await lockCase(tx, p.businessId, caseId); // the case row FOR UPDATE: the version bump is serialized
  const prepared = prepare(p, { idempotencyKey: key ?? uuidV7(new Date()) }, `service-desk/cases:${action}`, { caseId, ...payload });
  await appendRecord(tx, p.businessId, caseId, locked.context, action, payload, p.userId, prepared);
}

async function hasA7(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (to_regclass('public."ServiceCaseLoaner"') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Task' AND column_name = 'serviceCaseId')
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ServiceCase' AND column_name = 'itemLocationNote')) AS ok`;
  return r[0]?.ok === true;
}
async function requireA7(tx: Tx) {
  if (!(await hasA7(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION", { migration: "20261214090000_service_desk_case_fields" });
}

function keyOrThrow(req: WriteRequest) {
  const v = checkIdempotencyKey(req.idempotencyKey, req.now ?? new Date());
  if (!v.ok) throw new ServiceDeskError(v.code === "IDEMPOTENCY_KEY_INVALID" ? "IDEMPOTENCY_KEY_INVALID" : "IDEMPOTENCY_KEY_STALE");
  return req.idempotencyKey;
}

async function writing<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (e instanceof ServiceDeskError) throw e;
    throw guardRefusal(e) ?? e;
  }
}

// ── Pickup reminders ───────────────────────────────────────────────────────────────────────────────────────

export type PickupReminder = { id: number; calledAt: string; outcome: "REACHED" | "LEFT_MESSAGE" | "NO_ANSWER"; note: string | null };
const OUTCOMES = ["REACHED", "LEFT_MESSAGE", "NO_ANSWER"] as const;

export async function listPickupReminders(businessId: number, caseId: unknown): Promise<{ reminders: PickupReminder[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await caseExists(tx, businessId, caseId);
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, "calledAt", outcome::text AS outcome, note FROM "ServicePhoneReminder"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY "calledAt" DESC, id DESC`;
    return { reminders: rows.map((r) => ({ id: Number(r.id), calledAt: iso(r.calledAt) as string, outcome: r.outcome as PickupReminder["outcome"], note: (r.note as string) ?? null })) };
  });
}

/** POST { outcome, note? } + Idempotency-Key — a documented pickup call, now, while the item is READY (the guard checks). */
export async function recordPickupReminder(p: ServiceDeskPrincipal, caseId: unknown, body: { outcome?: unknown; note?: unknown }, req: WriteRequest): Promise<{ reminder: PickupReminder; replayed: boolean }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!OUTCOMES.includes(body.outcome as never)) throw new ServiceDeskError("INVALID_INPUT", { field: "outcome" });
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "note" });
  if (note && [...note].length > 1000) throw new ServiceDeskError("INVALID_INPUT", { field: "note" });
  const key = keyOrThrow(req);
  const b = p.businessId;
  return writing(() => tenantTx(b, async (tx) => {
    const prior = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, "caseId", "calledAt", outcome::text AS outcome, note FROM "ServicePhoneReminder" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${key}::text`)[0];
    if (prior) {
      if (Number(prior.caseId) !== caseId || prior.outcome !== body.outcome) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { reminder: { id: Number(prior.id), calledAt: iso(prior.calledAt) as string, outcome: prior.outcome as PickupReminder["outcome"], note: (prior.note as string) ?? null }, replayed: true };
    }
    const c = await caseExists(tx, b, caseId);
    if (c.status !== "READY") throw new ServiceDeskError("REFUSED", { violations: ["PICKUP_REMINDER_ONLY_WHEN_READY"] });
    const row = (await tx.$queryRaw<Record<string, unknown>[]>`
      INSERT INTO "ServicePhoneReminder" ("businessId", "caseId", "calledAt", "actorUserId", outcome, note, "idempotencyKey")
      VALUES (${b}::int, ${caseId}::int, now(), ${p.userId}::int, ${body.outcome as string}::"ServicePhoneReminderOutcome", ${note}::text, ${key}::text)
      RETURNING id, "calledAt"`)[0];
    await tx.$executeRaw`UPDATE "ServiceCase" SET "pickupRemindersSent" = "pickupRemindersSent" + 1 WHERE id = ${caseId}::int AND "businessId" = ${b}::int`;
    return { reminder: { id: Number(row.id), calledAt: iso(row.calledAt) as string, outcome: body.outcome as PickupReminder["outcome"], note }, replayed: false };
  }));
}

// ── Loaner equipment (A7) ─────────────────────────────────────────────────────────────────────────────────────

export type Loan = { id: number; itemName: string; lentAt: string; returnedAt: string | null; note: string | null };
const toLoan = (r: Record<string, unknown>): Loan => ({ id: Number(r.id), itemName: String(r.itemName), lentAt: iso(r.lentAt) as string, returnedAt: iso(r.returnedAt), note: (r.note as string) ?? null });

export async function listLoans(businessId: number, caseId: unknown): Promise<{ available: boolean; loans: Loan[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await caseExists(tx, businessId, caseId);
    if (!(await hasA7(tx))) return { available: false, loans: [] };
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, "itemName", "lentAt", "returnedAt", note FROM "ServiceCaseLoaner"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY "lentAt", id`;
    return { available: true, loans: rows.map(toLoan) };
  });
}

/** POST { itemName, note? } + Idempotency-Key — lend a replacement item on this case. Never blocks anything. */
export async function lendItem(p: ServiceDeskPrincipal, caseId: unknown, body: { itemName?: unknown; note?: unknown }, req: WriteRequest): Promise<{ loan: Loan; replayed: boolean }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const name = typeof body.itemName === "string" ? body.itemName.trim() : "";
  if (!name || [...name].length > 120) throw new ServiceDeskError("INVALID_INPUT", { field: "itemName" });
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  if (note && [...note].length > 500) throw new ServiceDeskError("INVALID_INPUT", { field: "note" });
  const key = keyOrThrow(req);
  const b = p.businessId;
  return writing(() => tenantTx(b, async (tx) => {
    await requireA7(tx);
    await lockCaseFirst(tx, b, caseId as number);
    const prior = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, "caseId", "itemName", "lentAt", "returnedAt", note FROM "ServiceCaseLoaner" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${key}::text`)[0];
    if (prior) {
      if (Number(prior.caseId) !== caseId || prior.itemName !== name) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { loan: toLoan(prior), replayed: true };
    }
    refuseWhenFinished((await caseExists(tx, b, caseId)).status);
    const row = (await tx.$queryRaw<Record<string, unknown>[]>`
      INSERT INTO "ServiceCaseLoaner" ("businessId", "caseId", "itemName", note, "idempotencyKey")
      VALUES (${b}::int, ${caseId}::int, ${name}::text, ${note}::text, ${key}::text)
      RETURNING id, "itemName", "lentAt", "returnedAt", note`)[0];
    await journalCaseWork(tx, p, caseId as number, "LEND_ITEM", { loanId: Number(row.id) }, key);
    return { loan: toLoan(row), replayed: false };
  }));
}

/** POST — the item came back (idempotent: an already returned loan answers as it is). */
export async function returnLoan(p: ServiceDeskPrincipal, caseId: unknown, loanId: unknown): Promise<{ loan: Loan }> {
  if (!isPositiveInt(caseId) || !isPositiveInt(loanId)) throw new ServiceDeskError("NOT_FOUND");
  const b = p.businessId;
  return writing(() => tenantTx(b, async (tx) => {
    await requireA7(tx);
    await lockCaseFirst(tx, b, caseId as number);
    const wasOut = (await tx.$queryRaw<{ out: boolean }[]>`
      SELECT "returnedAt" IS NULL AS out FROM "ServiceCaseLoaner" WHERE id = ${loanId}::int AND "caseId" = ${caseId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0]?.out === true;
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      UPDATE "ServiceCaseLoaner" SET "returnedAt" = COALESCE("returnedAt", now())
       WHERE id = ${loanId}::int AND "caseId" = ${caseId}::int AND "businessId" = ${b}::int
      RETURNING id, "itemName", "lentAt", "returnedAt", note`;
    if (!rows[0]) throw new ServiceDeskError("NOT_FOUND");
    if (wasOut) await journalCaseWork(tx, p, caseId as number, "RETURN_ITEM", { loanId: loanId as number });
    return { loan: toLoan(rows[0]) };
  }));
}

// ── Task link (A7) ────────────────────────────────────────────────────────────────────────────────────────────

export type LinkedTask = { id: number; title: string; done: boolean; dueOn: string | null };

export async function listCaseTasks(businessId: number, caseId: unknown): Promise<{ available: boolean; linked: LinkedTask[]; open: LinkedTask[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await caseExists(tx, businessId, caseId);
    if (!(await hasA7(tx))) return { available: false, linked: [], open: [] };
    const map = (r: Record<string, unknown>): LinkedTask => ({ id: Number(r.id), title: String(r.title), done: r.done === true, dueOn: (r.dueOn as string) ?? null });
    const linked = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, title, (status::text IN ('DONE', 'CANCELED')) AS done, to_char("dueOn", 'YYYY-MM-DD') AS "dueOn" FROM "Task"
       WHERE "businessId" = ${businessId}::int AND "serviceCaseId" = ${caseId}::int ORDER BY (status::text IN ('DONE', 'CANCELED')), id DESC LIMIT 50`;
    const open = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, title, false AS done, to_char("dueOn", 'YYYY-MM-DD') AS "dueOn" FROM "Task"
       WHERE "businessId" = ${businessId}::int AND "serviceCaseId" IS NULL AND status::text IN ('OPEN', 'IN_PROGRESS')
       ORDER BY id DESC LIMIT 30`;
    return { available: true, linked: linked.map(map), open: open.map(map) };
  });
}

/** PUT { taskId, link: boolean } — link an open task of this business to the case, or remove the link. */
export async function setTaskLink(p: ServiceDeskPrincipal, caseId: unknown, body: { taskId?: unknown; link?: unknown }): Promise<{ ok: true }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isPositiveInt(body.taskId) || typeof body.link !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "taskId" });
  const b = p.businessId;
  return writing(() => tenantTx(b, async (tx) => {
    await requireA7(tx);
    await lockCaseFirst(tx, b, caseId as number);
    const c = await caseExists(tx, b, caseId);
    // Linking a task to a finished case is refused (pilot review 2026-11-21); removing a link stays possible (clean-up).
    if (body.link) refuseWhenFinished(c.status);
    const before = (await tx.$queryRaw<{ c: number | null }[]>`
      SELECT "serviceCaseId" AS c FROM "Task" WHERE id = ${body.taskId as number}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
    const n = body.link
      ? await tx.$executeRaw`UPDATE "Task" SET "serviceCaseId" = ${caseId}::int WHERE id = ${body.taskId as number}::int AND "businessId" = ${b}::int AND ("serviceCaseId" IS NULL OR "serviceCaseId" = ${caseId}::int)`
      : await tx.$executeRaw`UPDATE "Task" SET "serviceCaseId" = NULL WHERE id = ${body.taskId as number}::int AND "businessId" = ${b}::int AND "serviceCaseId" = ${caseId}::int`;
    if (n !== 1) throw new ServiceDeskError("NOT_FOUND");
    if (body.link && before?.c === null) await journalCaseWork(tx, p, caseId as number, "LINK_TASK", { taskId: body.taskId as number });
    if (!body.link) await journalCaseWork(tx, p, caseId as number, "UNLINK_TASK", { taskId: body.taskId as number });
    return { ok: true as const };
  }));
}

// ── Case light fields (A7) ────────────────────────────────────────────────────────────────────────────────────

export async function getCaseFields(businessId: number, caseId: unknown): Promise<{ available: boolean; itemLocationNote: string | null; estimatedReadyOn: string | null }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    await caseExists(tx, businessId, caseId);
    if (!(await hasA7(tx))) return { available: false, itemLocationNote: null, estimatedReadyOn: null };
    const r = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT "itemLocationNote", to_char("estimatedReadyOn", 'YYYY-MM-DD') AS d FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int`)[0];
    return { available: true, itemLocationNote: (r?.itemLocationNote as string) ?? null, estimatedReadyOn: (r?.d as string) ?? null };
  });
}

/** PUT { itemLocationNote: string | null, estimatedReadyOn: "YYYY-MM-DD" | null } — both optional, no alerts, no SLA. */
export async function setCaseFields(p: ServiceDeskPrincipal, caseId: unknown, body: { itemLocationNote?: unknown; estimatedReadyOn?: unknown }) {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const loc = body.itemLocationNote === null || body.itemLocationNote === undefined ? null : typeof body.itemLocationNote === "string" ? body.itemLocationNote.trim() || null : undefined;
  if (loc === undefined || (loc && [...loc].length > 120)) throw new ServiceDeskError("INVALID_INPUT", { field: "itemLocationNote" });
  const d = body.estimatedReadyOn ?? null;
  if (d !== null && (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) throw new ServiceDeskError("INVALID_INPUT", { field: "estimatedReadyOn" });
  const b = p.businessId;
  return writing(() => tenantTx(b, async (tx) => {
    await requireA7(tx);
    await lockCaseFirst(tx, b, caseId as number);
    refuseWhenFinished((await caseExists(tx, b, caseId)).status);
    const prev = (await tx.$queryRaw<{ loc: string | null; d: string | null }[]>`
      SELECT "itemLocationNote" AS loc, to_char("estimatedReadyOn", 'YYYY-MM-DD') AS d FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
    await tx.$executeRaw`UPDATE "ServiceCase" SET "itemLocationNote" = ${loc}::text, "estimatedReadyOn" = ${d as string | null}::date WHERE id = ${caseId}::int AND "businessId" = ${b}::int`;
    const locationChanged = (prev?.loc ?? null) !== loc, estimatedChanged = (prev?.d ?? null) !== (d as string | null);
    if (locationChanged || estimatedChanged) {
      await journalCaseWork(tx, p, caseId as number, "RECORD_WORK_DETAILS", {
        locationChanged, locationSet: loc !== null, estimatedChanged, estimatedReadyOn: (d as string | null) ?? null,
      });
    }
    return { available: true, itemLocationNote: loc, estimatedReadyOn: d as string | null };
  }));
}

// ── Activation: the profile and the activity types offered first (decision 1) ──────────────────────────────────

export type ProfileChoice = {
  version: number | null;
  /** the owner already chose (the activation is done) */
  chosen: boolean;
  /** the stored choice, else the one the business category suggests (decision 1: pre-selected, the owner may change) */
  key: string;
  suggestedKey: string;
  offeredTracks: string[] | null;
  /** profile key → its tracks (suggested first): the screen's pre-selection when the owner picks a profile. */
  catalog: Record<string, string[]>;
};

export async function getProfileChoice(businessId: number): Promise<ProfileChoice> {
  return tenantTx(businessId, async (tx) => {
    const s = (await tx.$queryRaw<{ version: number; key: string | null; overrides: unknown }[]>`
      SELECT version, "serviceProfileKey" AS key, "profileOverrides" AS overrides FROM "ServiceSettings" WHERE "businessId" = ${businessId}::int`)[0];
    const bp = (await tx.$queryRaw<{ category: string | null; subCategory: string | null }[]>`
      SELECT category, "subCategory" FROM "BusinessProfile" WHERE "businessId" = ${businessId}::int`)[0];
    const suggestedKey = resolveProfileKey({ category: bp?.category ?? null, subCategory: bp?.subCategory ?? null });
    const chosen = isServiceProfileKey(s?.key ?? null);
    const o = (s?.overrides ?? null) as ProfileOverrides | null;
    return {
      version: s ? Number(s.version) : null, chosen, key: chosen ? (s!.key as string) : suggestedKey, suggestedKey,
      offeredTracks: Array.isArray(o?.offeredTracks) ? [...o!.offeredTracks] : null, catalog: profileCatalog(),
    };
  });
}

/**
 * PUT { expectedVersion, serviceProfileKey, offeredTracks } + Idempotency-Key — the activation choice. Keeps the owner's
 * other overrides (terms, requirements); the offered list only orders the opening form — every track stays open to every
 * business (owner decision 2026-11-11). Journaled in ServiceSettingsEvent in the same transaction.
 */
export async function saveProfileChoice(p: ServiceDeskPrincipal, body: { expectedVersion?: unknown; serviceProfileKey?: unknown; offeredTracks?: unknown }, req: WriteRequest): Promise<ProfileChoice & { replayed: boolean }> {
  const b = p.businessId;
  if (!isServiceProfileKey(body.serviceProfileKey)) throw new ServiceDeskError("INVALID_INPUT", { field: "serviceProfileKey" });
  const list = body.offeredTracks;
  if (!Array.isArray(list) || list.length === 0 || list.length > SERVICE_TRACKS.length || new Set(list).size !== list.length
      || !list.every((t) => (SERVICE_TRACKS as readonly unknown[]).includes(t))) throw new ServiceDeskError("INVALID_INPUT", { field: "offeredTracks" });
  const expected = body.expectedVersion === undefined ? null : body.expectedVersion;
  if (expected !== null && !isPositiveInt(expected)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const key = body.serviceProfileKey;
  const offered = list as string[];
  const prepared = prepare(p, req, "service-desk/settings/profile", { expectedVersion: expected, serviceProfileKey: key, offeredTracks: offered });
  return writing(() => tenantTx(b, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53445354}::int, ${b}::int)`; // 'SDST' — the settings writer lock
    await requireAuditJournalFor(tx);
    const prior = (await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "ServiceSettingsEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text`)[0];
    if (prior && prior.n > 0) return { ...(await getProfileChoiceTx(tx, b)), replayed: true };
    const v = checkIdempotencyKey(prepared.key, prepared.now);
    if (!v.ok) throw new ServiceDeskError(v.code === "IDEMPOTENCY_KEY_INVALID" ? "IDEMPOTENCY_KEY_INVALID" : "IDEMPOTENCY_KEY_STALE");
    const cur = (await tx.$queryRaw<{ version: number; key: string | null; overrides: unknown }[]>`
      SELECT version, "serviceProfileKey" AS key, "profileOverrides" AS overrides FROM "ServiceSettings" WHERE "businessId" = ${b}::int`)[0];
    if ((cur ? Number(cur.version) : null) !== expected) throw new ServiceDeskError("VERSION_CONFLICT");
    const prev = (cur?.overrides ?? {}) as ProfileOverrides;
    const next: ProfileOverrides = { ...prev, offeredTracks: offered };
    const bad = validateOverrides(key, next);
    if (bad.length) throw new ServiceDeskError("REFUSED", { violations: bad.map((x) => `${x.code}:${x.path}`) });
    const changed = [
      ...(cur?.key !== key ? ["serviceProfileKey"] : []),
      ...(JSON.stringify(prev.offeredTracks ?? null) !== JSON.stringify(offered) ? ["profileOverrides"] : []),
    ];
    if (changed.length === 0) throw new ServiceDeskError("REFUSED", { violations: ["NO_CHANGE"] });
    if (!cur) {
      await tx.$executeRaw`INSERT INTO "ServiceSettings" ("businessId", "serviceProfileKey", "profileOverrides", "updatedAt")
        VALUES (${b}::int, ${key}::text, ${JSON.stringify(next)}::jsonb, now())`;
    } else {
      await tx.$executeRaw`UPDATE "ServiceSettings" SET "serviceProfileKey" = ${key}::text, "profileOverrides" = ${JSON.stringify(next)}::jsonb,
        version = version + 1, "updatedAt" = now() WHERE "businessId" = ${b}::int AND version = ${cur.version}::int`;
    }
    const after = await getProfileChoiceTx(tx, b);
    await tx.$executeRaw`
      INSERT INTO "ServiceSettingsEvent" ("businessId", "settingsVersion", "changedFields", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${after.version as number}::int, ${changed}::text[], 'OWNER_USER'::"ServiceActor", ${p.userId}::int,
              ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    return { ...after, replayed: false };
  }, { timeoutMs: 15_000 }));
}

async function getProfileChoiceTx(tx: Tx, b: number): Promise<ProfileChoice> {
  const s = (await tx.$queryRaw<{ version: number; key: string | null; overrides: unknown }[]>`
    SELECT version, "serviceProfileKey" AS key, "profileOverrides" AS overrides FROM "ServiceSettings" WHERE "businessId" = ${b}::int`)[0];
  const o = (s?.overrides ?? null) as ProfileOverrides | null;
  const key = isServiceProfileKey(s?.key ?? null) ? (s!.key as string) : "general";
  return { version: s ? Number(s.version) : null, chosen: isServiceProfileKey(s?.key ?? null), key, suggestedKey: key, offeredTracks: Array.isArray(o?.offeredTracks) ? [...o!.offeredTracks] : null, catalog: profileCatalog() };
}

// ── QA (read): the checklist this case is judged by, and what was recorded ─────────────────────────────────────

export type CaseQaView = {
  /** REQUIRED / OPTIONAL / OFF from the case's own snapshot; a case without a snapshot follows its kind (REQUIRED). */
  mode: "REQUIRED" | "OPTIONAL" | "OFF";
  template: { id: string; items: { key: string; label: string; required: boolean }[]; everyCheckRecorded: boolean } | null;
  results: Record<string, "PASS" | "FAIL">;
  completed: boolean;
};

/** GET — the same template the server judges a new result by (track snapshot, else the kind's), never a guess. */
export async function getCaseQa(businessId: number, caseId: unknown): Promise<CaseQaView> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const { loadTrackState } = await import("./tracks.service");
  const { qaTemplateFor } = await import("./qa-templates");
  return tenantTx(businessId, async (tx) => {
    const c = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT kind::text AS kind, "workType"::text AS "workType", "serviceLocation"::text AS "serviceLocation", "siteAddress",
             "returnReason"::text AS "returnReason", "afterSaleResolution"::text AS "afterSaleResolution", "profileSnapshot",
             "appointmentId", "deviceId", "qaChecklist", "qaCompletedAt"
        FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int`)[0];
    if (!c) throw new ServiceDeskError("NOT_FOUND");
    const state = await loadTrackState(tx, businessId, caseId, {
      kind: c.kind as never, workType: (c.workType as string) ?? null, serviceLocation: (c.serviceLocation as string) ?? null,
      siteAddress: (c.siteAddress as string) ?? null, returnReason: (c.returnReason as string) ?? null,
      afterSaleResolution: (c.afterSaleResolution as string) ?? null, profileSnapshot: c.profileSnapshot ?? null,
      appointmentId: c.appointmentId === null ? null : Number(c.appointmentId), deviceId: c.deviceId === null ? null : Number(c.deviceId),
    } as never);
    const qa = state.track?.requirements.qa ?? null;
    const mode = (qa?.mode ?? (c.kind === "IN_SHOP" ? "REQUIRED" : "OFF")) as CaseQaView["mode"];
    const t = mode === "OFF" ? null : qaTemplateFor(c.kind as never, qa?.template ?? null);
    const stored = (c.qaChecklist ?? null) as { results?: Record<string, "PASS" | "FAIL"> } | null;
    return {
      mode,
      template: t ? { id: t.id, items: t.items.map((i) => ({ ...i })), everyCheckRecorded: t.everyCheckRecorded } : null,
      results: stored?.results ?? {},
      completed: c.qaCompletedAt !== null,
    };
  });
}
