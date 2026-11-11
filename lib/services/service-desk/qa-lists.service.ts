/**
 * Service Desk — per-business QA lists (migration 20261129090000). SERVER-ONLY. No UI, no route logic, no flag logic (the
 * HTTP edge decides FULL / READ_ONLY / NONE before a write is called; writes need FULL — the business owner, exactly as
 * the service settings).
 *
 *   reads     listQaLists, getQaList (a version, the history of versions and of changes, how many cases use it),
 *             getCaseQa (the case's QA screen: mode, checklist, every record with its per-check results)
 *   lists     createQaList (empty or from a built-in suggested template), reviseQaList (a new immutable version: rename,
 *             add / remove / reorder checks, REQUIRED per check), setQaListArchived (archive / restore)
 *             — each ONE tenant transaction: the business's list lock → an earlier answer for this Idempotency-Key? (the
 *             ServiceQaListEvent journal is the ledger, as ServiceSettingsEvent for the settings) → revision compared →
 *             the head, the version and its checks, the event; the database re-checks every count at COMMIT
 *   the case  chooseCaseQaList — a P4-style STATUS-PRESERVING case record (recordCommand): the case names the list's
 *             CURRENT version (or none) and its QA completion is reset; journaled as CHOOSE_QA_LIST / qa.list_chosen
 *
 * Results are recorded by recordQa (service-case.service.ts), against the checklist the case names.
 * Without migration 20261129090000 every write here answers NOT_AVAILABLE_UNTIL_MIGRATION and writes nothing; the reads
 * answer an empty / template-only view with `available: false`.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestWithKeyId, sameDigest } from "@/lib/services/tasks/task-idempotency";

import {
  QA_CHOICE_FIXED_STATUSES,
  caseQaMode,
  choicePayload,
  decideChoice,
  parseListInput,
  planNewList,
  planRevision,
  type PlannedVersion,
} from "./qa-lists.core";
import { caseQaChoice, qaListsSchemaReady, readVersion } from "./qa-lists.store";
import { QA_TEMPLATE_BY_ID, qaTemplateFor } from "./qa-templates";
import type { QaMode } from "./service-profiles";
import type { ServiceCaseKind, ServiceCaseStatus } from "./contracts";
import { ServiceDeskError } from "./service-desk-errors";
import {
  guardRefusal,
  insertRecordEvent,
  isPositiveInt,
  isUniqueViolation,
  prepare,
  recordCommand,
  type CommandResult,
  type Prepared,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";
import { loadTrackState } from "./tracks.service";

async function requireQaSchema(tx: Tx) {
  if (!(await qaListsSchemaReady(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION");
}

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────────────────

export type QaListSummary = {
  id: number; name: string | null; currentVersion: number; revision: number; itemCount: number; requiredCount: number;
  archived: boolean; sourceTemplateId: string | null; createdAt: string; updatedAt: string;
};

async function summaries(tx: Tx, b: number, where: { id?: number; includeArchived: boolean }): Promise<QaListSummary[]> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT l.id, v.name, l."currentVersion", l.revision, v."itemCount", v."requiredCount", l."archivedAt" IS NOT NULL AS archived, l."sourceTemplateId",
           to_char(l."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
           to_char(l."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
      FROM "ServiceQaList" l
      JOIN "ServiceQaListVersion" v ON v."businessId" = l."businessId" AND v."listId" = l.id AND v.version = l."currentVersion"
     WHERE l."businessId" = ${b}::int
       AND (${where.id ?? null}::int IS NULL OR l.id = ${where.id ?? null}::int)
       AND (${where.includeArchived}::boolean OR l."archivedAt" IS NULL)
     ORDER BY l."archivedAt" IS NOT NULL, v.name, l.id`;
  return rows.map((r) => ({
    id: Number(r.id), name: (r.name as string) ?? null, currentVersion: Number(r.currentVersion), revision: Number(r.revision),
    itemCount: Number(r.itemCount), requiredCount: Number(r.requiredCount), archived: r.archived === true,
    sourceTemplateId: (r.sourceTemplateId as string) ?? null, createdAt: String(r.createdAt), updatedAt: String(r.updatedAt),
  }));
}

/** The business's lists (active first, by name). `available: false` before the migration. */
export async function listQaLists(businessId: number, q: { includeArchived?: unknown } = {}): Promise<{ available: boolean; lists: QaListSummary[] }> {
  if (q.includeArchived !== undefined && typeof q.includeArchived !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "includeArchived" });
  return tenantTx(businessId, async (tx) => {
    if (!(await qaListsSchemaReady(tx))) return { available: false, lists: [] };
    return { available: true, lists: await summaries(tx, businessId, { includeArchived: q.includeArchived === true }) };
  });
}

export type QaListDetail = {
  list: QaListSummary;
  /** The requested version (default: the current one) with its checks in order. */
  version: { version: number; name: string | null; createdAt: string; items: { key: string; label: string | null; required: boolean; position: number }[] };
  versions: { version: number; name: string | null; itemCount: number; requiredCount: number; createdAt: string }[];
  /** The list's journal, oldest first: what changed when (counts and tokens; who = a user id). */
  history: { revision: number; action: string; listVersion: number; itemCount: number; requiredCount: number; actorUserId: number | null; occurredAt: string }[];
  /** Cases naming any version of this list: still before QA is passed / all. */
  usage: { openCases: number; allCases: number };
};

async function detailOf(tx: Tx, b: number, listId: number, version?: number): Promise<QaListDetail> {
  const list = (await summaries(tx, b, { id: listId, includeArchived: true }))[0];
  if (!list) throw new ServiceDeskError("NOT_FOUND");
  const v = await readVersion(tx, b, listId, version ?? list.currentVersion);
  if (!v) throw new ServiceDeskError("NOT_FOUND");
  const versions = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT version, name, "itemCount", "requiredCount", to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
      FROM "ServiceQaListVersion" WHERE "businessId" = ${b}::int AND "listId" = ${listId}::int ORDER BY version`;
  const history = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT revision, action::text AS action, "listVersion", "itemCount", "requiredCount", "actorUserId",
           to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt"
      FROM "ServiceQaListEvent" WHERE "businessId" = ${b}::int AND "listId" = ${listId}::int ORDER BY revision`;
  const usage = (await tx.$queryRaw<{ open: number; total: number }[]>`
    SELECT count(*) FILTER (WHERE status::text <> ALL(${[...QA_CHOICE_FIXED_STATUSES]}::text[]))::int AS open, count(*)::int AS total
      FROM "ServiceCase" WHERE "businessId" = ${b}::int AND "qaListId" = ${listId}::int`)[0];
  return {
    list,
    version: { version: v.version, name: v.name, createdAt: v.createdAt, items: v.items.map((i) => ({ key: i.key, label: i.label, required: i.required, position: i.position })) },
    versions: versions.map((r) => ({ version: Number(r.version), name: (r.name as string) ?? null, itemCount: Number(r.itemCount), requiredCount: Number(r.requiredCount), createdAt: String(r.createdAt) })),
    history: history.map((r) => ({
      revision: Number(r.revision), action: String(r.action), listVersion: Number(r.listVersion), itemCount: Number(r.itemCount), requiredCount: Number(r.requiredCount),
      actorUserId: r.actorUserId === null ? null : Number(r.actorUserId), occurredAt: String(r.occurredAt),
    })),
    usage: { openCases: Number(usage?.open ?? 0), allCases: Number(usage?.total ?? 0) },
  };
}

/** One list: its current version (or `version`), every version, its change history and its use. */
export async function getQaList(businessId: number, listId: unknown, q: { version?: unknown } = {}): Promise<QaListDetail> {
  if (!isPositiveInt(listId)) throw new ServiceDeskError("NOT_FOUND");
  if (q.version !== undefined && !isPositiveInt(q.version)) throw new ServiceDeskError("INVALID_INPUT", { field: "version" });
  return tenantTx(businessId, async (tx) => {
    await requireQaSchema(tx);
    return detailOf(tx, businessId, listId, q.version as number | undefined);
  });
}

// ── List commands ───────────────────────────────────────────────────────────────────────────────────────────

/** The lists' journal is its own ledger: same key + same request → the stored answer; same key + another request → refused. */
async function findPriorListEvent(tx: Tx, b: number, p: Prepared): Promise<{ listId: number } | null> {
  const origin = (await tx.$queryRaw<{ l: number; d: string | null; k: string | null }[]>`
    SELECT "listId" AS l, "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceQaListEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${p.key}::text`)[0];
  if (!origin) return null;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(p.keys, origin.k, p.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { listId: Number(origin.l) };
}

type ListHead = { revision: number; currentVersion: number; archived: boolean };

async function lockHead(tx: Tx, b: number, listId: number): Promise<ListHead> {
  const h = (await tx.$queryRaw<{ revision: number; v: number; archived: boolean }[]>`
    SELECT revision, "currentVersion" AS v, "archivedAt" IS NOT NULL AS archived FROM "ServiceQaList" WHERE "businessId" = ${b}::int AND id = ${listId}::int FOR UPDATE`)[0];
  if (!h) throw new ServiceDeskError("NOT_FOUND");
  return { revision: Number(h.revision), currentVersion: Number(h.v), archived: h.archived === true };
}

async function insertVersion(tx: Tx, b: number, listId: number, version: number, v: PlannedVersion, userId: number) {
  await tx.$executeRaw`
    INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId")
    VALUES (${b}::int, ${listId}::int, ${version}::int, ${v.name}::text, ${v.items.length}::int, ${v.requiredCount}::int, ${userId}::int)`;
  for (const [i, it] of v.items.entries()) {
    await tx.$executeRaw`
      INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required)
      VALUES (${b}::int, ${listId}::int, ${version}::int, ${i + 1}::int, ${it.key}::text, ${it.label}::text, ${it.required}::boolean)`;
  }
}

async function insertListEvent(tx: Tx, b: number, listId: number, revision: number, action: "CREATE" | "REVISE" | "ARCHIVE" | "RESTORE", listVersion: number, counts: { itemCount: number; requiredCount: number }, userId: number, p: Prepared) {
  await tx.$executeRaw`
    INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES (${b}::int, ${listId}::int, ${revision}::int, ${action}::"ServiceQaListAction", ${listVersion}::int, ${counts.itemCount}::int, ${counts.requiredCount}::int,
            'OWNER_USER'::"ServiceActor", ${userId}::int, ${p.key}::text, ${p.digest.value}::text, ${p.digest.keyId}::text)`;
}

/**
 * One list command: the business's list lock ('SDQA') → the migration present → an earlier answer? → the key young
 * enough → work. A unique-key race is retried once and then answered from the winner, or CONFLICT; a database guard's
 * refusal is a refusal (never a 500).
 */
async function listCommand(p: ServiceDeskPrincipal, prepared: Prepared, work: (tx: Tx) => Promise<number>, sameList?: number): Promise<QaListDetail & { replayed: boolean }> {
  const b = p.businessId;
  const attempt = () => tenantTx(b, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53445141}::int, ${b}::int)`; // 'SDQA' — one list writer per business
    await requireQaSchema(tx);
    const prior = await findPriorListEvent(tx, b, prepared);
    if (prior) {
      if (sameList !== undefined && prior.listId !== sameList) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { ...(await detailOf(tx, b, prior.listId)), replayed: true };
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const listId = await work(tx);
    return { ...(await detailOf(tx, b, listId)), replayed: false };
  }, { timeoutMs: 15_000 });
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ServiceDeskError) throw e;
    if (isUniqueViolation(e)) {
      try { return await attempt(); } catch (e2) {
        if (e2 instanceof ServiceDeskError) throw e2;
        throw isUniqueViolation(e2) ? new ServiceDeskError("CONFLICT") : guardRefusal(e2) ?? e2;
      }
    }
    throw guardRefusal(e) ?? e;
  }
}

/**
 * POST /qa-lists { name, items?: [{ key?, label, required }], fromTemplate? } — a new list, version 1. From a built-in
 * template its checks are COPIED (keys, labels, REQUIRED flags — every suggested check is optional); the list never
 * follows later changes of the template. Journaled (CREATE).
 */
export async function createQaList(p: ServiceDeskPrincipal, body: Record<string, unknown>, req: WriteRequest): Promise<QaListDetail & { replayed: boolean }> {
  const parsed = parseListInput(body, { allowTemplate: true });
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const plan = planNewList(parsed.value);
  const prepared = prepare(p, req, "service-desk/qa-lists:create", parsed.value);
  const b = p.businessId;
  return listCommand(p, prepared, async (tx) => {
    const id = Number((await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision, "sourceTemplateId") VALUES (${b}::int, 1, 1, ${plan.sourceTemplateId}::text) RETURNING id`)[0].id);
    await insertVersion(tx, b, id, 1, plan, p.userId);
    await insertListEvent(tx, b, id, 1, "CREATE", 1, { itemCount: plan.items.length, requiredCount: plan.requiredCount }, p.userId, prepared);
    return id;
  });
}

/**
 * PUT /qa-lists/[listId] { expectedRevision, name, items: [{ key?, label, required }] } — the list's next version, whole:
 * a check sent with its key is the same check (relabelled / REQUIRED changed / moved); one without a key is new; a check
 * not sent is removed. Older versions — and every case checked against them — are untouched. An archived list must be
 * restored first. Journaled (REVISE).
 */
export async function reviseQaList(p: ServiceDeskPrincipal, listId: unknown, body: Record<string, unknown>, req: WriteRequest): Promise<QaListDetail & { replayed: boolean }> {
  if (!isPositiveInt(listId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isPositiveInt(body.expectedRevision)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedRevision" });
  const parsed = parseListInput({ name: body.name, items: body.items }, { allowTemplate: false });
  if (!parsed.ok) throw new ServiceDeskError("INVALID_INPUT", { field: parsed.field });
  const prepared = prepare(p, req, "service-desk/qa-lists:revise", { listId, expectedRevision: body.expectedRevision, ...parsed.value });
  const b = p.businessId;
  return listCommand(p, prepared, async (tx) => {
    const h = await lockHead(tx, b, listId);
    if (h.revision !== body.expectedRevision) throw new ServiceDeskError("VERSION_CONFLICT");
    if (h.archived) throw new ServiceDeskError("REFUSED", { violations: ["QA_LIST_ARCHIVED"] });
    const current = await readVersion(tx, b, listId, h.currentVersion);
    if (!current || current.name === null) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "QA_LIST_VERSION_PRESENT" });
    const used = await tx.$queryRaw<{ k: string }[]>`SELECT DISTINCT "itemKey" AS k FROM "ServiceQaListItem" WHERE "businessId" = ${b}::int AND "listId" = ${listId}::int`;
    const plan = planRevision({ name: current.name, items: current.items }, parsed.value, h.currentVersion + 1, used.map((u) => u.k));
    if (!plan.ok) throw new ServiceDeskError("REFUSED", { violations: [plan.code] });
    const next = h.currentVersion + 1;
    await tx.$executeRaw`
      UPDATE "ServiceQaList" SET revision = ${h.revision + 1}::int, "currentVersion" = ${next}::int, "updatedAt" = now()
       WHERE "businessId" = ${b}::int AND id = ${listId}::int AND revision = ${h.revision}::int`;
    await insertVersion(tx, b, listId, next, plan.version, p.userId);
    await insertListEvent(tx, b, listId, h.revision + 1, "REVISE", next, { itemCount: plan.version.items.length, requiredCount: plan.version.requiredCount }, p.userId, prepared);
    return listId;
  }, listId);
}

/**
 * PUT /qa-lists/[listId]/archive { expectedRevision, archived } — archive (no longer offered to cases; every case that
 * names it keeps its version and its results) or restore. Journaled (ARCHIVE / RESTORE).
 */
export async function setQaListArchived(p: ServiceDeskPrincipal, listId: unknown, body: Record<string, unknown>, req: WriteRequest): Promise<QaListDetail & { replayed: boolean }> {
  if (!isPositiveInt(listId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isPositiveInt(body.expectedRevision)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedRevision" });
  if (typeof body.archived !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "archived" });
  const archived = body.archived;
  const prepared = prepare(p, req, "service-desk/qa-lists:archive", { listId, expectedRevision: body.expectedRevision, archived });
  const b = p.businessId;
  return listCommand(p, prepared, async (tx) => {
    const h = await lockHead(tx, b, listId);
    if (h.revision !== body.expectedRevision) throw new ServiceDeskError("VERSION_CONFLICT");
    if (h.archived === archived) throw new ServiceDeskError("REFUSED", { violations: ["NO_CHANGE"] });
    const v = await readVersion(tx, b, listId, h.currentVersion);
    if (!v) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "QA_LIST_VERSION_PRESENT" });
    await tx.$executeRaw`
      UPDATE "ServiceQaList" SET revision = ${h.revision + 1}::int, "archivedAt" = CASE WHEN ${archived}::boolean THEN now() ELSE NULL END, "updatedAt" = now()
       WHERE "businessId" = ${b}::int AND id = ${listId}::int AND revision = ${h.revision}::int`;
    await insertListEvent(tx, b, listId, h.revision + 1, archived ? "ARCHIVE" : "RESTORE", h.currentVersion, { itemCount: v.itemCount, requiredCount: v.requiredCount }, p.userId, prepared);
    return listId;
  }, listId);
}

// ── The case ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * PUT /cases/[id]/qa/list { listId: number | null, expectedVersion } — the case names the CURRENT version of an active list
 * of the business (or none: its built-in template, as before). Before QA is passed only; not where the track has no QA
 * (QA OFF); the QA completion is reset (the new checklist is unchecked). A STATUS-PRESERVING case record, journaled
 * (CHOOSE_QA_LIST / qa.list_chosen: list ids and versions — numbers only).
 */
export async function chooseCaseQaList(p: ServiceDeskPrincipal, caseId: unknown, body: { listId?: unknown; expectedVersion?: unknown }, req: WriteRequest): Promise<CommandResult & { qaList: { listId: number; listVersion: number } | null }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const listId = body.listId ?? null;
  if (listId !== null && !isPositiveInt(listId)) throw new ServiceDeskError("INVALID_INPUT", { field: "listId" });
  const prepared = prepare(p, req, "service-desk/cases:qa-list", { caseId, listId, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  let qaList: { listId: number; listVersion: number } | null = null;
  const r = await recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    await requireQaSchema(tx);
    const current = await caseQaChoice(tx, b, caseId);
    let target: { listId: number; currentVersion: number; archived: boolean } | null = null;
    if (listId !== null) {
      const l = (await tx.$queryRaw<{ v: number; archived: boolean }[]>`
        SELECT "currentVersion" AS v, "archivedAt" IS NOT NULL AS archived FROM "ServiceQaList" WHERE "businessId" = ${b}::int AND id = ${listId as number}::int FOR SHARE`)[0];
      if (!l) throw new ServiceDeskError("REFUSED", { violations: ["QA_LIST_NOT_FOUND"] });
      target = { listId: listId as number, currentVersion: Number(l.v), archived: l.archived === true };
    }
    const d = decideChoice({ status: context.status, mode: caseQaMode(context.kind, context.track ?? null), current, target });
    if (!d.ok) throw new ServiceDeskError("REFUSED", { violations: d.violations });
    const n = await tx.$executeRaw`
      UPDATE "ServiceCase" SET "qaListId" = ${d.to?.listId ?? null}::int, "qaListVersion" = ${d.to?.listVersion ?? null}::int, "qaCompletedAt" = NULL,
             version = ${context.version + 1}::int, "updatedAt" = now()
       WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${context.version}::int`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await insertRecordEvent(tx, b, caseId, context, "CHOOSE_QA_LIST", choicePayload(current, d.to), p.userId, prepared);
    qaList = d.to;
  });
  if (r.replayed) qaList = await tenantTx(b, (tx) => caseQaChoice(tx, b, caseId));
  return { ...r, qaList };
}

export type CaseQaView = {
  available: boolean;
  caseId: number; status: ServiceCaseStatus; version: number;
  /** The track's rule (or the kind's, for a case without a track): REQUIRED / OPTIONAL / OFF. */
  mode: QaMode;
  completed: boolean;
  /** What the case is checked against now (null when QA is OFF). */
  checklist:
    | { source: "LIST"; listId: number; listVersion: number; name: string | null; listCurrentVersion: number; listArchived: boolean; items: { key: string; label: string | null; required: boolean }[] }
    | { source: "TEMPLATE"; templateId: string; items: { key: string; label: string; required: boolean }[] }
    | null;
  /** Every QA record, newest first, each check with its result, REQUIRED flag (as it was) and note. */
  records: {
    caseVersion: number; recordedAt: string; completed: boolean; listId: number | null; listVersion: number | null; templateId: string | null;
    counts: { items: number; recorded: number; passed: number; failed: number; requiredFailed: number; requiredMissing: number };
    actorUserId: number | null;
    results: { key: string; label: string | null; required: boolean; result: "PASS" | "FAIL"; note: string | null }[];
  }[];
  /** The case's last stored checklist (tokens) — the only trace of results recorded before the migration. */
  lastChecklist: unknown;
  canChooseList: boolean;
  canRecord: boolean;
};

/** GET /cases/[id]/qa — the case's QA: mode, the checklist it names, every record with its per-check results. */
export async function getCaseQa(businessId: number, caseId: unknown): Promise<CaseQaView> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const b = businessId;
  return tenantTx(b, async (tx) => {
    const c = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT kind::text AS kind, status::text AS status, version, "qaCompletedAt" IS NOT NULL AS done, "qaChecklist",
             "workType"::text AS "workType", "serviceLocation"::text AS "serviceLocation", "siteAddress", "returnReason"::text AS "returnReason",
             "afterSaleResolution"::text AS "afterSaleResolution", "profileSnapshot", "appointmentId", "deviceId"
        FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
    if (!c) throw new ServiceDeskError("NOT_FOUND");
    const kind = c.kind as ServiceCaseKind;
    const status = c.status as ServiceCaseStatus;
    const track = await loadTrackState(tx, b, caseId, {
      kind, workType: (c.workType as string) ?? null, serviceLocation: (c.serviceLocation as string) ?? null, siteAddress: (c.siteAddress as string) ?? null,
      returnReason: (c.returnReason as string) ?? null, afterSaleResolution: (c.afterSaleResolution as string) ?? null, profileSnapshot: c.profileSnapshot ?? null,
      appointmentId: c.appointmentId === null ? null : Number(c.appointmentId), deviceId: c.deviceId === null ? null : Number(c.deviceId),
    });
    const mode = caseQaMode(kind, track.track);
    const available = await qaListsSchemaReady(tx);
    const chosen = available ? await caseQaChoice(tx, b, caseId) : null;
    let checklist: CaseQaView["checklist"] = null;
    if (chosen) {
      const v = await readVersion(tx, b, chosen.listId, chosen.listVersion);
      const h = (await tx.$queryRaw<{ v: number; archived: boolean }[]>`
        SELECT "currentVersion" AS v, "archivedAt" IS NOT NULL AS archived FROM "ServiceQaList" WHERE "businessId" = ${b}::int AND id = ${chosen.listId}::int`)[0];
      checklist = {
        source: "LIST", listId: chosen.listId, listVersion: chosen.listVersion, name: v?.name ?? null, listCurrentVersion: Number(h?.v ?? chosen.listVersion),
        listArchived: h?.archived === true, items: (v?.items ?? []).map((i) => ({ key: i.key, label: i.label, required: i.required })),
      };
    } else if (mode !== "OFF") {
      const t = qaTemplateFor(kind, track.track?.requirements.qa.template ?? null);
      if (t) checklist = { source: "TEMPLATE", templateId: t.id, items: t.items.map((i) => ({ key: i.key, label: i.label, required: i.required })) };
    }
    const records: CaseQaView["records"] = [];
    if (available) {
      const recs = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT id, "caseVersion", to_char("recordedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt", completed, "listId", "listVersion", "templateId",
               "itemCount", "resultCount", "passCount", "failCount", "requiredFailed", "requiredMissing", "actorUserId"
          FROM "ServiceCaseQaRecord" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int ORDER BY "caseVersion" DESC`;
      const results = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT x."recordId", x."itemKey", x.required, x.result::text AS result, x.note, i.label, i.position
          FROM "ServiceCaseQaItemResult" x
          JOIN "ServiceCaseQaRecord" r ON r."businessId" = x."businessId" AND r.id = x."recordId"
          LEFT JOIN "ServiceQaListItem" i ON i."businessId" = x."businessId" AND i."listId" = x."listId" AND i."listVersion" = x."listVersion" AND i."itemKey" = x."itemKey"
         WHERE x."businessId" = ${b}::int AND r."caseId" = ${caseId}::int
         ORDER BY x."recordId", i.position NULLS LAST, x.id`;
      for (const r of recs) {
        const template = r.templateId ? QA_TEMPLATE_BY_ID[String(r.templateId)] : undefined;
        const order = (k: string) => template ? template.items.findIndex((i) => i.key === k) : 0;
        const mine = results.filter((x) => Number(x.recordId) === Number(r.id));
        if (template) mine.sort((a, z) => order(String(a.itemKey)) - order(String(z.itemKey)));
        records.push({
          caseVersion: Number(r.caseVersion), recordedAt: String(r.recordedAt), completed: r.completed === true,
          listId: r.listId === null ? null : Number(r.listId), listVersion: r.listVersion === null ? null : Number(r.listVersion), templateId: (r.templateId as string) ?? null,
          counts: { items: Number(r.itemCount), recorded: Number(r.resultCount), passed: Number(r.passCount), failed: Number(r.failCount), requiredFailed: Number(r.requiredFailed), requiredMissing: Number(r.requiredMissing) },
          actorUserId: r.actorUserId === null ? null : Number(r.actorUserId),
          results: mine.map((x) => ({
            key: String(x.itemKey), required: x.required === true, result: x.result as "PASS" | "FAIL", note: (x.note as string) ?? null,
            label: x.label !== null && x.label !== undefined ? String(x.label) : template?.items.find((i) => i.key === x.itemKey)?.label ?? null,
          })),
        });
      }
    }
    return {
      available, caseId, status, version: Number(c.version), mode, completed: c.done === true, checklist, records, lastChecklist: c.qaChecklist ?? null,
      canChooseList: available && mode !== "OFF" && !QA_CHOICE_FIXED_STATUSES.includes(status),
      canRecord: status === "QA" && mode !== "OFF",
    };
  });
}
