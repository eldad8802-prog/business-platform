/**
 * Service Desk 1.3a — the data service over the case core. SERVER-ONLY. No UI, no route logic, no flag logic (the HTTP
 * edge decides FULL / READ_ONLY / NONE before calling a write here).
 *
 * Every journaled command is ONE tenant transaction (SERVICE_COMMAND_SERVER_DUTIES):
 *   1. lock: the case row FOR UPDATE (a transition) or the business's case counter (an opening);
 *   2. an earlier answer? The journal is the ledger: a request's event carries its Idempotency-Key and an HMAC digest of
 *      (route, business, user, body) under UNIQUE (businessId, idempotencyKey) — same key + same request → the stored
 *      result (`replayed: true`); same key + another request → IDEMPOTENCY_KEY_REUSED; the key is a UUIDv7 ≤ 24 h old;
 *   3. expectedVersion compared under the lock; the pure core decides (openServiceCase / evaluateTransition);
 *   4. every server check the decision lists is verified here, against the database — or the command is refused
 *      (fail closed: a check this layer cannot verify refuses);
 *   5. status / hold / outcome / version and the event, in the same transaction; the database guards re-check it.
 * A concurrent first request with the same key loses on the unique key and is answered from the winner.
 *
 * P4: the technician, the intake data and QA results are status-preserving case records (journaled like a transition,
 * the version bumped, the status untouched); a settings change is journaled in ServiceSettingsEvent — each in the same
 * transaction as the change it records, with the same key / digest / replay rules. Without the P4 journal in the
 * database they answer NOT_AVAILABLE_UNTIL_AUDIT and write nothing.
 *
 * Raw SQL with explicit casts throughout: the queries name exactly the columns and locks they need.
 *
 * The request / journal / lock helpers are exported for the sibling services of the same module (external work, parts),
 * so every Service Desk command keeps ONE implementation of the idempotency, locking and guard-refusal rules.
 */
import { Prisma } from "@prisma/client";

import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestKeysFromEnv, digestWithKeyId, requestDigest, sameDigest, type RequestIdentity } from "@/lib/services/tasks/task-idempotency";
import { getStorageService } from "@/lib/storage/storage.factory";

import {
  SERVICE_CASE_KINDS,
  SERVICE_HOLD_REASONS,
  type RepeatCaseDecision,
  type ServiceCaseAction,
  type ServiceCaseActionType,
  type ServiceCaseContext,
  type ServiceCaseKind,
  type ServiceCaseStatus,
  type ServiceJournalEventDraft,
  type ServiceServerCheck,
  type ServiceTransitionDecision,
} from "./contracts";
import { OPEN_PART_STATES } from "./parts.contracts";
import { checkCommandEnvelope, evaluateRepeatCase, evaluateTransition, openServiceCase } from "./service-case.core";
import { ServiceDeskError, refused } from "./service-desk-errors";
import { settlementForCore, type SettlementReader } from "./settlement";
import { readCaseSettlement } from "./case-settlement-reader";
import { qaTemplateFor } from "./qa-templates";
import { caseQaMode, evaluateChecklist, listChecklistToken } from "./qa-lists.core";
import { openingChoicePayload, parseOpeningQaList, resolveOpeningQaList, type OpeningQaReason, type OpeningQaRequest } from "./qa-track-defaults.core";
import { qaTrackDefaultsSchemaReady, readListState, readTrackDefaults } from "./qa-track-defaults.store";
import { caseQaChoice, insertQaRecord, qaListsSchemaReady, readVersion } from "./qa-lists.store";
import { releaseCaseReservations } from "./part-release";
import { deriveIdempotencyKey } from "./idempotency-key";
import { supersedeOpenQuote, withdrawOpenQuote, type FrozenQuote } from "./quote-rows";
import { countDetailBlockers, createSubject, creditDocumentLinked, loadTrackState, planOpening, subjectKindOf, verifyTrackFits, type TrackState } from "./tracks.service";
import { buildTrackFacts, decideAfterSale, planTrackOpening, subjectFitsTrack } from "./tracks.core";

export type Tx = Prisma.TransactionClient;

export type ServiceDeskPrincipal = { businessId: number; userId: number };
export type WriteRequest = { idempotencyKey: string; now?: Date };

/**
 * The transitions the generic action route carries (owner-approved scope ש2; CLOSE since 1.3c). Everything else is refused
 * there as ACTION_NOT_IN_SCOPE — the four quote actions run through their own commands (quote.service), like external work.
 */
export const IN_SCOPE_ACTIONS = [
  "CHECK_IN", "START_DIAGNOSIS", "START_REPAIR", "SET_HOLD", "CLEAR_HOLD", "FINISH_REPAIR", "PASS_QA", "FAIL_QA",
  "MARK_NOT_REPAIRABLE", "CANCEL", "ABANDON", "DELIVER", "CLOSE",
  // M1 (migration 20261127090000): the owner-confirmed completion of a track that hands nothing back, and D3 details
  "COMPLETE", "CHANGE_DETAILS",
] as const satisfies readonly ServiceCaseActionType[];

/** 1.3c: carried by quote.service (the /cases/[id]/quotes routes) — the frozen sent copy is prepared before the case lock. */
export const QUOTE_COMMAND_ACTIONS = ["SEND_QUOTE", "REVISE_QUOTE", "APPROVE_QUOTE", "REJECT_QUOTE"] as const satisfies readonly ServiceCaseActionType[];

/** Why each other action is not on the generic route — the gap report reads this. */
export const OUT_OF_SCOPE_ACTIONS: Readonly<Record<Exclude<ServiceCaseActionType, (typeof IN_SCOPE_ACTIONS)[number]>, string>> = {
  SCHEDULE: "scheduling stays closed (owner 1.3a P1: 1.3d / separate decision) — M1 adds the case ↔ appointment link, not the command",
  RESCHEDULE: "scheduling stays closed (owner 1.3a P1) — like SCHEDULE",
  SEND_QUOTE: "quotes — their own command (quote.service sendQuote, POST /cases/[id]/quotes)",
  REVISE_QUOTE: "quotes — their own command (quote.service reviseQuote, POST /cases/[id]/quotes/revise)",
  APPROVE_QUOTE: "quotes — their own command (quote.service decideQuote, POST /cases/[id]/quotes/[version]/decision)",
  REJECT_QUOTE: "quotes — their own command (quote.service decideQuote, POST /cases/[id]/quotes/[version]/decision)",
  SEND_TO_EXTERNAL: "external work — its own commands (external-work.service), closed until 1.3b",
  RETURN_FROM_EXTERNAL: "external work — its own commands (external-work.service), closed until 1.3b",
};

/** The write-once time stamps a decision sets (the database guard keeps cancelledAt / abandonedAt write-once). */
export function stampsFor(d: Extract<ServiceTransitionDecision, { ok: true }>) {
  return {
    checkedIn: d.statusChanged && d.to === "CHECKED_IN",
    ready: d.statusChanged && d.to === "READY",
    // A cancel is stamped when it is decided — also when a held item goes to READY to be handed back, and when it is
    // only requested while the item is at a supplier (CHECK ServiceCase_cancel_stamp: a requested cancel carries cancelledAt).
    cancelled: d.action === "CANCEL" && (d.outcome === "CANCELLED" || d.cancellationRequestedAfter === true),
    abandoned: d.statusChanged && d.to === "ABANDONED",
    closed: d.statusChanged && d.to === "CLOSED",
  };
}

export const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
export const isNonNegativeInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

// ── Requests: key, digest, the journal as the ledger ────────────────────────────────────────────────────────

export type Prepared = { key: string; now: Date; keys: ReturnType<typeof digestKeysFromEnv>; ident: RequestIdentity; digest: { value: string; keyId: string } };

export function prepare(p: ServiceDeskPrincipal, req: WriteRequest, route: string, body: unknown): Prepared {
  const now = req.now ?? new Date();
  const key = req.idempotencyKey;
  const verdict = checkIdempotencyKey(key, now);
  if (!verdict.ok && verdict.code === "IDEMPOTENCY_KEY_INVALID") throw new ServiceDeskError("IDEMPOTENCY_KEY_INVALID");
  const keys = digestKeysFromEnv();
  const ident: RequestIdentity = { route, businessId: p.businessId, userId: p.userId, body };
  return { key, now, keys, ident, digest: { value: requestDigest(keys.current, ident), keyId: keys.current.id } };
}

export type Prior = { caseId: number; seq: number };

async function findPrior(tx: Tx, businessId: number, p: Prepared): Promise<Prior | null> {
  const rows = await tx.$queryRaw<{ caseId: number; seq: number; d: string | null; k: string | null }[]>`
    SELECT "caseId", seq, "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceCaseEvent"
     WHERE "businessId" = ${businessId}::int AND "idempotencyKey" = ${p.key}::text`;
  const origin = rows[0];
  if (!origin) return null;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(p.keys, origin.k, p.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { caseId: Number(origin.caseId), seq: Number(origin.seq) };
}

export const isUniqueViolation = (e: unknown) => {
  const code = (e as { code?: string; meta?: { code?: string } })?.meta?.code ?? (e as { code?: string })?.code;
  return code === "P2002" || code === "23505" || /23505|unique constraint/i.test(e instanceof Error ? e.message : "");
};

/** A database guard of the module refused the write (DZS…/DZU… codes): a refusal, never a 500. */
export function guardRefusal(e: unknown): ServiceDeskError | null {
  const text = e instanceof Error ? e.message : String(e);
  if (/SERVICE_UI_BUSINESS_DELETING|DZU02/.test(text)) return new ServiceDeskError("BUSINESS_DELETING");
  const m = /(SERVICE_[A-Z_]+):/.exec(text);
  if (m) return new ServiceDeskError("REFUSED", { guard: m[1] });
  // A table CHECK the service did not anticipate: a refusal naming the constraint, never a 500.
  const c = /violates check constraint "([A-Za-z0-9_]+)"/.exec(text);
  return c ? new ServiceDeskError("REFUSED", { constraint: c[1] }) : null;
}

/**
 * lock → earlier answer? → key young enough? → work. The lock comes FIRST, so a request that waited behind another
 * one with the same key sees that one's committed event and is answered from it (never a version conflict, never a
 * consumed case number).
 */
export async function journaled<T, L>(
  p: ServiceDeskPrincipal,
  prepared: Prepared,
  lock: (tx: Tx) => Promise<L>,
  run: (tx: Tx, locked: L) => Promise<T>,
  replay: (tx: Tx, prior: Prior) => Promise<T>,
): Promise<T> {
  const attempt = () =>
    tenantTx(p.businessId, async (tx) => {
      const locked = await lock(tx);
      const prior = await findPrior(tx, p.businessId, prepared);
      if (prior) return replay(tx, prior);
      const verdict = checkIdempotencyKey(prepared.key, prepared.now);
      if (!verdict.ok) throw new ServiceDeskError(verdict.code);
      return run(tx, locked);
    }, { timeoutMs: 15_000 });
  try {
    return await attempt();
  } catch (e) {
    if (e instanceof ServiceDeskError) throw e;
    if (isUniqueViolation(e)) {
      try {
        return await attempt();
      } catch (e2) {
        if (e2 instanceof ServiceDeskError) throw e2;
        if (isUniqueViolation(e2)) throw new ServiceDeskError("CONFLICT");
        throw guardRefusal(e2) ?? e2;
      }
    }
    throw guardRefusal(e) ?? e;
  }
}

export async function appendEvent(tx: Tx, businessId: number, caseId: number, seq: number, e: ServiceJournalEventDraft, userId: number, prepared: Prepared) {
  const actor = e.actor.kind === "OWNER" ? "OWNER_USER" : e.actor.kind;
  await tx.$executeRaw`
    INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "holdReasonBefore", "holdReasonAfter",
      "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES (${businessId}::int, ${caseId}::int, ${seq}::int, ${e.type}::"ServiceEventType", ${e.action}::"ServiceCaseAction",
      ${e.fromStatus}::"ServiceCaseStatus", ${e.toStatus}::"ServiceCaseStatus", ${e.holdReasonBefore}::"ServiceHoldReason", ${e.holdReasonAfter}::"ServiceHoldReason",
      ${e.cancellationRequestedBefore}::boolean, ${e.cancellationRequestedAfter}::boolean, ${e.outcome}::"ServiceOutcome", ${actor}::"ServiceActor",
      ${e.actor.kind === "OWNER" ? userId : null}::int, ${JSON.stringify(e.payload)}::jsonb, ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
}

// ── Facts the server checks verify ──────────────────────────────────────────────────────────────────────────

export async function staffOfBusiness(tx: Tx, businessId: number, staffId: number): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "StaffMember" WHERE id = ${staffId}::int AND "businessId" = ${businessId}::int AND active AND "erasedAt" IS NULL) AS ok`;
  return r[0]?.ok === true;
}

async function verifyServerChecks(
  tx: Tx,
  businessId: number,
  checks: readonly ServiceServerCheck[],
  f: { staffMemberId: number | null; signatureKey: string | null; settlementRead?: boolean; caseId?: number; track?: TrackState; decision?: Extract<ServiceTransitionDecision, { ok: true }> },
) {
  for (const check of checks) {
    switch (check) {
      case "CREDIT_DOCUMENT_LINKED":
        // M1 T7 credit: the ACTIVE after-sale credit link, re-read here under the case lock.
        if (f.caseId === undefined || !(await creditDocumentLinked(tx, businessId, f.caseId))) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      case "DETAIL_BLOCKERS_COUNTED_UNDER_LOCK":
        // M1: lockCase counted them AFTER taking the case row FOR UPDATE; service_case_guard (a) re-checks the same rows.
        if (!f.decision || f.decision.action !== "CHANGE_DETAILS") throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      case "SUBJECT_FITS_TRACK":
        if (!f.track || !f.decision?.detailChange) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        verifyTrackFits(f.track, f.decision.detailChange.after);
        break;
      case "SETTLEMENT_READ_IN_SAME_TRANSACTION":
        // 1.3c: the balance was read by this command, in this transaction, under the case lock (settlement.ts).
        if (f.settlementRead !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      case "PART_RESERVATIONS_COUNTED_UNDER_LOCK":
        // 1.3c CLOSE: lockCase counts the open part lines AFTER taking the case row FOR UPDATE, and every part write locks
        // that row first (the parts triggers) — the count cannot move before this commits. The deferred guard
        // ServiceCase_parts_resolved_on_close re-checks it at COMMIT.
        break;
      case "STAFF_BELONGS_TO_BUSINESS":
        if (f.staffMemberId === null || !(await staffOfBusiness(tx, businessId, f.staffMemberId))) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      case "INTAKE_ARTIFACTS_STORED": {
        // The signature image must really be stored, under this business's service prefix. 1.3a writes none: the
        // signature capture is 1.3b, so an IN_SHOP check-in stays refused until then.
        const key = f.signatureKey;
        const own = typeof key === "string" && key.startsWith(`biz/${businessId}/service/`);
        if (!own || !(await getStorageService().headObject(key as string)).exists) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      }
      default:
        // APPOINTMENT_BELONGS_TO_CASE, SITE_…, QUOTE_…, SUPPLIER_…, REPLACEMENT_…, SETTLEMENT_…, PART_… — not verifiable
        // in 1.3a (out of scope): refused, never assumed.
        throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
    }
  }
}

// ── Reads (FULL and READ_ONLY) ──────────────────────────────────────────────────────────────────────────────

export type CaseSummary = {
  id: number; caseNumber: number; kind: ServiceCaseKind; status: ServiceCaseStatus; holdReason: string | null; outcome: string | null;
  version: number; customerId: number; customerName: string | null; deviceId: number | null; staffMemberId: number | null;
  openedAt: string; updatedAt: string;
};

const SUMMARY_COLUMNS = Prisma.sql`c.id, c."caseNumber", c.kind::text AS kind, c.status::text AS status, c."holdReason"::text AS "holdReason",
  c.outcome::text AS outcome, c.version, c."customerId", cu.name AS "customerName", c."deviceId", c."staffMemberId",
  to_char(c."openedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "openedAt",
  to_char(c."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

const toSummary = (r: Record<string, unknown>): CaseSummary => ({
  id: Number(r.id), caseNumber: Number(r.caseNumber), kind: r.kind as ServiceCaseKind, status: r.status as ServiceCaseStatus,
  holdReason: (r.holdReason as string) ?? null, outcome: (r.outcome as string) ?? null, version: Number(r.version),
  customerId: Number(r.customerId), customerName: (r.customerName as string) ?? null, deviceId: r.deviceId === null ? null : Number(r.deviceId),
  staffMemberId: r.staffMemberId === null ? null : Number(r.staffMemberId), openedAt: String(r.openedAt), updatedAt: String(r.updatedAt),
});

export const LIST_LIMIT_MAX = 100;

/** Newest first; keyset by id. `status` filters to one status. */
export async function listCases(businessId: number, q: { status?: unknown; beforeId?: unknown; limit?: unknown } = {}): Promise<{ cases: CaseSummary[]; nextBeforeId: number | null }> {
  const limit = q.limit === undefined ? 50 : q.limit;
  if (!isPositiveInt(limit) || limit > LIST_LIMIT_MAX) throw new ServiceDeskError("INVALID_INPUT", { field: "limit" });
  if (q.beforeId !== undefined && !isPositiveInt(q.beforeId)) throw new ServiceDeskError("INVALID_INPUT", { field: "beforeId" });
  if (q.status !== undefined && typeof q.status !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "status" });
  const status = q.status as string | undefined;
  if (status !== undefined && !/^[A-Z_]{2,20}$/.test(status)) throw new ServiceDeskError("INVALID_INPUT", { field: "status" });
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${SUMMARY_COLUMNS} FROM "ServiceCase" c LEFT JOIN "Customer" cu ON cu.id = c."customerId" AND cu."businessId" = c."businessId"
       WHERE c."businessId" = ${businessId}::int
         ${status !== undefined ? Prisma.sql`AND c.status::text = ${status}::text` : Prisma.empty}
         ${q.beforeId !== undefined ? Prisma.sql`AND c.id < ${q.beforeId as number}::int` : Prisma.empty}
       ORDER BY c.id DESC LIMIT ${limit + 1}::int`;
    const cases = rows.slice(0, limit).map(toSummary);
    return { cases, nextBeforeId: rows.length > limit ? cases[cases.length - 1].id : null };
  });
}

export type CaseCard = CaseSummary & {
  problemDescription: string | null; parentCaseId: number | null;
  coverage: { source: string; decision: string } | null; pickupRemindersSent: number; cancellationRequested: boolean;
  stamps: Record<"checkedInAt" | "readyAt" | "deliveredAt" | "closedAt" | "cancelledAt" | "abandonedAt", string | null>;
  intake: { conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean; customerSigned: boolean; updatedAt: string } | null;
};

export async function getCase(businessId: number, caseId: unknown): Promise<CaseCard> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${SUMMARY_COLUMNS}, c."problemDescription", c."parentCaseId", c."coverageSource"::text AS "coverageSource", c."coverageDecision"::text AS "coverageDecision",
             c."pickupRemindersSent", c."cancellationRequested",
             c."checkedInAt", c."readyAt", c."deliveredAt", c."closedAt", c."cancelledAt", c."abandonedAt",
             i."conditionNote", i."accessoriesNote", i."conditionRecorded", i."accessoriesRecorded", i."customerSigned",
             to_char(i."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "intakeUpdatedAt", i.id AS "intakeId"
        FROM "ServiceCase" c
        LEFT JOIN "Customer" cu ON cu.id = c."customerId" AND cu."businessId" = c."businessId"
        LEFT JOIN "ServiceCaseIntake" i ON i."caseId" = c.id AND i."businessId" = c."businessId"
       WHERE c.id = ${caseId}::int AND c."businessId" = ${businessId}::int`;
    const r = rows[0];
    if (!r) throw new ServiceDeskError("NOT_FOUND");
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
    return {
      ...toSummary(r),
      problemDescription: (r.problemDescription as string) ?? null,
      parentCaseId: r.parentCaseId === null ? null : Number(r.parentCaseId),
      coverage: r.coverageSource ? { source: String(r.coverageSource), decision: String(r.coverageDecision) } : null,
      pickupRemindersSent: Number(r.pickupRemindersSent),
      cancellationRequested: r.cancellationRequested === true,
      stamps: {
        checkedInAt: iso(r.checkedInAt), readyAt: iso(r.readyAt), deliveredAt: iso(r.deliveredAt),
        closedAt: iso(r.closedAt), cancelledAt: iso(r.cancelledAt), abandonedAt: iso(r.abandonedAt),
      },
      intake: r.intakeId === null || r.intakeId === undefined ? null : {
        conditionNote: (r.conditionNote as string) ?? null, accessoriesNote: (r.accessoriesNote as string) ?? null,
        conditionRecorded: r.conditionRecorded === true, accessoriesRecorded: r.accessoriesRecorded === true,
        customerSigned: r.customerSigned === true, updatedAt: String(r.intakeUpdatedAt),
      },
    };
  });
}

export type JournalEntry = {
  seq: number; eventType: string; action: string; fromStatus: string | null; toStatus: string; holdReasonAfter: string | null;
  outcome: string | null; actor: string; actorUserId: number | null; occurredAt: string; payload: unknown;
};

/** The case's journal, oldest first. The payload holds tokens, numbers and booleans only (decision ט-1 A). */
export async function listCaseEvents(businessId: number, caseId: unknown): Promise<JournalEntry[]> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const exists = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int) AS ok`;
    if (exists[0]?.ok !== true) throw new ServiceDeskError("NOT_FOUND");
    const rows = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT seq, "eventType"::text AS "eventType", action::text AS action, "fromStatus"::text AS "fromStatus", "toStatus"::text AS "toStatus",
             "holdReasonAfter"::text AS "holdReasonAfter", outcome::text AS outcome, actor::text AS actor, "actorUserId",
             to_char("occurredAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt", payload
        FROM "ServiceCaseEvent" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY seq`;
    return rows.map((r) => ({
      seq: Number(r.seq), eventType: String(r.eventType), action: String(r.action), fromStatus: (r.fromStatus as string) ?? null,
      toStatus: String(r.toStatus), holdReasonAfter: (r.holdReasonAfter as string) ?? null, outcome: (r.outcome as string) ?? null,
      actor: String(r.actor), actorUserId: r.actorUserId === null ? null : Number(r.actorUserId), occurredAt: String(r.occurredAt), payload: r.payload,
    }));
  });
}

// ── Opening a case ──────────────────────────────────────────────────────────────────────────────────────────

export type OpenCaseInput = {
  kind?: unknown; customerId: unknown; deviceId?: unknown; parentCaseId?: unknown; problemDescription?: unknown;
  /** M1: open on a track (T1–T7). The kind then follows the track's place; the snapshot is the business's profile now (D14). */
  track?: unknown; serviceLocation?: unknown; siteAddress?: unknown; siteNotes?: unknown; returnReason?: unknown; originalSaleRef?: unknown; subject?: unknown;
  /**
   * QA track defaults (migration 20261130100000): absent → the track's default QA list (if any, active, QA not OFF); null →
   * explicitly no list; a list id → that ACTIVE list of the business. The list's CURRENT version is pinned on the case.
   */
  qaListId?: unknown;
};
export type CommandResult = { case: CaseSummary; event: { seq: number }; replayed: boolean; repeat?: RepeatCaseDecision | null };
/** What the opening named as the case's QA list, and why (a skipped default is reported, never silent). Null on a replay. */
export type OpeningQaList = { list: { listId: number; listVersion: number } | null; reason: OpeningQaReason };

/** The database requires a problem description on every case (CHECK ServiceCase_problem_described, ≤ 4000). */
const PROBLEM_MAX = 4000;

export async function summaryOf(tx: Tx, businessId: number, caseId: number): Promise<CaseSummary> {
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT ${SUMMARY_COLUMNS} FROM "ServiceCase" c LEFT JOIN "Customer" cu ON cu.id = c."customerId" AND cu."businessId" = c."businessId"
     WHERE c.id = ${caseId}::int AND c."businessId" = ${businessId}::int`;
  if (!rows[0]) throw new ServiceDeskError("NOT_FOUND");
  return toSummary(rows[0]);
}

/** The repeat-warranty decision for a parent of this business (ש4): its LOCKED offer's end date, or none. */
async function repeatDecision(tx: Tx, businessId: number, parentCaseId: number, now: Date): Promise<RepeatCaseDecision> {
  const p = (await tx.$queryRaw<{ status: string; outcome: string | null; deliveredAt: Date | null }[]>`
    SELECT status::text AS status, outcome::text AS outcome, "deliveredAt" FROM "ServiceCase" WHERE id = ${parentCaseId}::int AND "businessId" = ${businessId}::int`)[0];
  if (!p) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "PARENT_CASE_BELONGS_TO_BUSINESS" });
  const w = await tx.$queryRaw<{ endsOn: string }[]>`
    SELECT to_char("endsOn", 'YYYY-MM-DD') AS "endsOn" FROM "ServiceWarrantyOffer"
     WHERE "businessId" = ${businessId}::int AND "caseId" = ${parentCaseId}::int AND state = 'LOCKED' AND "endsOn" IS NOT NULL`;
  if (w.length > 1) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "ONE_LOCKED_WARRANTY" });
  return evaluateRepeatCase({
    parent: { status: p.status as ServiceCaseStatus, outcome: p.outcome as never, deliveredOn: p.deliveredAt ? jerusalemDayKey(p.deliveredAt) : null },
    openedOn: jerusalemDayKey(now),
    parentWarrantyEndsOn: w[0]?.endsOn ?? null,
  });
}

export async function openCase(p: ServiceDeskPrincipal, input: OpenCaseInput, req: WriteRequest): Promise<CommandResult & { qaList?: OpeningQaList | null }> {
  const problem = input.problemDescription;
  if (typeof problem !== "string" || problem.trim().length === 0 || [...problem.trim()].length > PROBLEM_MAX) {
    throw new ServiceDeskError("INVALID_INPUT", { field: "problemDescription" });
  }
  // M1: with a track the kind follows the track's place (planTrackOpening, pure); a kind sent with it must agree.
  const withTrack = input.track !== undefined && input.track !== null;
  const trackInput = { track: input.track, serviceLocation: input.serviceLocation, siteAddress: input.siteAddress, siteNotes: input.siteNotes, returnReason: input.returnReason, originalSaleRef: input.originalSaleRef, subject: input.subject };
  let kind = input.kind;
  if (withTrack) {
    const plan = planTrackOpening(trackInput);
    if (!plan.ok) {
      if (plan.code === "INVALID_INPUT") throw new ServiceDeskError("INVALID_INPUT", { field: plan.field });
      throw new ServiceDeskError("REFUSED", { violations: [plan.code], field: plan.field });
    }
    if (kind !== undefined && kind !== null && kind !== plan.opening.kind) throw new ServiceDeskError("INVALID_INPUT", { field: "kind" });
    if (plan.opening.subject && input.deviceId !== undefined && input.deviceId !== null) throw new ServiceDeskError("INVALID_INPUT", { field: "subject" });
    kind = plan.opening.kind;
  } else {
    for (const f of ["serviceLocation", "siteAddress", "siteNotes", "returnReason", "originalSaleRef", "subject"] as const) {
      if (input[f] !== undefined && input[f] !== null) throw new ServiceDeskError("INVALID_INPUT", { field: f });
    }
  }
  const core = openServiceCase(
    { kind: kind as ServiceCaseKind, customerId: input.customerId as number, deviceId: (input.deviceId ?? null) as number | null, parentCaseId: (input.parentCaseId ?? null) as number | null, track: withTrack ? (input.track as never) : null },
    { kind: "OWNER", userId: p.userId },
  );
  if (!core.ok) throw refused(core.violations);
  if (!SERVICE_CASE_KINDS.includes(kind as ServiceCaseKind)) throw new ServiceDeskError("INVALID_INPUT", { field: "kind" });
  const qaRequest = parseOpeningQaList(input.qaListId);
  if (!qaRequest.ok) throw new ServiceDeskError("INVALID_INPUT", { field: qaRequest.field });
  const body = {
    kind, customerId: input.customerId, deviceId: input.deviceId ?? null, parentCaseId: input.parentCaseId ?? null, problemDescription: problem,
    ...(withTrack ? { trackOpening: trackInput } : {}),
    // only when sent: a request without it keeps the digest it always had
    ...(input.qaListId !== undefined ? { qaListId: input.qaListId } : {}),
  };
  const prepared = prepare(p, req, "service-desk/cases:open", body);
  const b = p.businessId;

  const lockOpenings = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53444f50}::int, ${b}::int)`; // 'SDOP'
  return journaled<CommandResult & { qaList?: OpeningQaList | null }, unknown>(p, prepared, lockOpenings, async (tx) => {
    // Openings are serialised per business by the lock above; the counter then hands out the next number.
    const n = Number((await tx.$queryRaw<{ n: number }[]>`
      INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue", "updatedAt") VALUES (${b}::int, 2, now())
      ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1, "updatedAt" = now()
      RETURNING "nextValue" - 1 AS n`)[0].n);
    for (const check of core.serverChecks) {
      if (check === "CUSTOMER_BELONGS_TO_BUSINESS") {
        const ok = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "Customer" WHERE id = ${input.customerId as number}::int AND "businessId" = ${b}::int) AS ok`;
        if (ok[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
      } else if (check === "DEVICE_BELONGS_TO_CUSTOMER") {
        const ok = await tx.$queryRaw<{ ok: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM "ServiceDevice" WHERE id = ${input.deviceId as number}::int AND "businessId" = ${b}::int AND "customerId" = ${input.customerId as number}::int AND "erasedAt" IS NULL) AS ok`;
        if (ok[0]?.ok !== true) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
      } else if (check !== "PARENT_CASE_BELONGS_TO_BUSINESS") {
        throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
      }
    }
    const repeat = core.serverChecks.includes("PARENT_CASE_BELONGS_TO_BUSINESS") ? await repeatDecision(tx, b, input.parentCaseId as number, prepared.now) : null;
    if (repeat && !repeat.ok) throw refused(repeat.violations);
    // Default technician (מ2 as decided for 1.3a): the settings' existing staff member, if it is still active here;
    // otherwise none — the owner handles the case. Nothing is created in the staff model.
    const settings = await tx.$queryRaw<{ s: number | null }[]>`SELECT "defaultStaffMemberId" AS s FROM "ServiceSettings" WHERE "businessId" = ${b}::int`;
    const preferred = settings[0]?.s ?? null;
    const staffMemberId = preferred !== null && (await staffOfBusiness(tx, b, Number(preferred))) ? Number(preferred) : null;
    // M1: the business's profile snapshot NOW (D14), the track enabled by it, the subject fitting the track (T2: a vehicle).
    let deviceId = (input.deviceId ?? null) as number | null;
    const planned = withTrack ? await planOpening(tx, b, trackInput) : null;
    if (planned) {
      const subjectKind = await subjectKindOf(tx, b, input.customerId as number, deviceId, planned.opening);
      if (!subjectFitsTrack(planned.opening.track, subjectKind)) throw new ServiceDeskError("REFUSED", { violations: ["SUBJECT_DOES_NOT_FIT_TRACK"], track: planned.opening.track });
      if (planned.opening.subject) deviceId = await createSubject(tx, b, input.customerId as number, planned.opening.subject);
    }
    const o = planned?.opening ?? null;
    const id = Number((await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "parentCaseId", "staffMemberId", "problemDescription", "updatedAt",
                                 "workType", "serviceLocation", "siteAddress", "siteNotes", "returnReason", "originalSaleRef", "profileKey", "profileSnapshot")
      VALUES (${b}::int, ${n}::int, ${kind as string}::"ServiceCaseKind", ${input.customerId as number}::int, ${deviceId}::int,
              ${(input.parentCaseId ?? null) as number | null}::int, ${staffMemberId}::int, ${problem.trim()}::text, now(),
              ${o?.workType ?? null}::"ServiceWorkType", ${o?.serviceLocation ?? null}::"ServiceLocationKind", ${o?.siteAddress ?? null}::text,
              ${o?.siteNotes ?? null}::text, ${o?.returnReason ?? null}::"ServiceReturnReason", ${o?.originalSaleRef ?? null}::text,
              ${planned?.profileKey ?? null}::text, ${planned ? JSON.stringify(planned.snapshot) : null}::jsonb)
      RETURNING id`)[0].id);
    const payload = { ...core.event.payload, staffAssigned: staffMemberId !== null, ...(planned ? { deviceId, subjectCreated: planned.opening.subject !== null, profileKey: planned.profileKey } : {}) };
    await appendEvent(tx, b, id, core.seq, { ...core.event, payload }, p.userId, prepared);
    const qaList = await openingQaList(tx, b, id, qaRequest.value, p.userId, prepared);
    return { case: await summaryOf(tx, b, id), event: { seq: core.seq }, replayed: false, repeat, qaList };
  }, async (tx, prior) => ({ case: await summaryOf(tx, b, prior.caseId), event: { seq: prior.seq }, replayed: true, repeat: null, qaList: null }));
}

/**
 * QA track defaults (migration 20261130100000) — the QA list a case names from its opening, in the opening's transaction.
 * The case row is INSERTed without a list (#1124's guard: SERVICE_CASE_QA_LIST_AT_OPENING), then — when a list is named —
 * the SAME journaled choice as PUT /cases/[id]/qa/list: status-preserving, version 1 → 2, a CHOOSE_QA_LIST event at seq 2
 * keyed deriveIdempotencyKey(request key, 2) (keys are unique per event; a replay is answered from the opening event), the list's
 * CURRENT version pinned. The mode is the case's own (lockCase: its snapshot's track row; without a track, its kind's).
 */
async function openingQaList(tx: Tx, b: number, caseId: number, request: OpeningQaRequest, userId: number, prepared: Prepared): Promise<OpeningQaList> {
  const lists = await qaListsSchemaReady(tx);
  if (request.kind === "LIST" && !lists) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_MIGRATION");
  if (request.kind === "NONE") return { list: null, reason: "EXPLICIT_NONE" };
  const defaults = lists && (await qaTrackDefaultsSchemaReady(tx));
  if (request.kind === "DEFAULT" && !defaults) return { list: null, reason: "NOT_AVAILABLE" };
  const { context } = await lockCase(tx, b, caseId);
  const track = context.track?.track ?? null;
  const explicitList = request.kind === "LIST" ? await readListState(tx, b, request.listId, { share: true }) : null;
  let defaultList = null;
  if (request.kind === "DEFAULT" && track !== null) {
    const row = (await readTrackDefaults(tx, b, track))[0];
    if (row?.listId != null) defaultList = await readListState(tx, b, row.listId, { share: true });
  }
  const r = resolveOpeningQaList({ request, mode: caseQaMode(context.kind, context.track ?? null), track, explicitList, defaultList, available: { lists, defaults } });
  if (!r.ok) throw new ServiceDeskError("REFUSED", { violations: r.violations });
  if (r.to === null) return { list: null, reason: r.reason };
  const n = await tx.$executeRaw`
    UPDATE "ServiceCase" SET "qaListId" = ${r.to.listId}::int, "qaListVersion" = ${r.to.listVersion}::int, "qaCompletedAt" = NULL,
           version = ${context.version + 1}::int, "updatedAt" = now()
     WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${context.version}::int`;
  if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
  await insertRecordEvent(tx, b, caseId, context, "CHOOSE_QA_LIST", openingChoicePayload(r.to, r.reason === "DEFAULT" ? "DEFAULT" : "EXPLICIT"), userId,
    { ...prepared, key: deriveIdempotencyKey(prepared.key, 2) });
  return { list: r.to, reason: r.reason };
}

// ── Transitions ─────────────────────────────────────────────────────────────────────────────────────────────

export type Locked = { context: ServiceCaseContext; signatureKey: string | null; track: TrackState };

/**
 * The case row FOR UPDATE, then every fact the core judges it by. M1: the track facts come from the case's OWN snapshot
 * (D14); `detailBlockers` counts the D3 blockers too (CHANGE_DETAILS only — the guard re-checks them on this row).
 */
export async function lockCase(tx: Tx, businessId: number, caseId: number, opts: { detailBlockersAt?: Date } = {}): Promise<Locked> {
  const c = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT kind::text AS kind, status::text AS status, "holdReason"::text AS "holdReason", outcome::text AS outcome, version, "staffMemberId",
           "coverageSource"::text AS "coverageSource", "coverageDecision"::text AS "coverageDecision", "qaCompletedAt", "pickupRemindersSent", "cancellationRequested",
           "workType"::text AS "workType", "serviceLocation"::text AS "serviceLocation", "siteAddress", "returnReason"::text AS "returnReason",
           "afterSaleResolution"::text AS "afterSaleResolution", "profileSnapshot", "appointmentId", "deviceId"
      FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int FOR UPDATE`)[0];
  if (!c) throw new ServiceDeskError("NOT_FOUND");
  const appointmentId = c.appointmentId === null ? null : Number(c.appointmentId);
  const track = await loadTrackState(tx, businessId, caseId, {
    kind: c.kind as ServiceCaseKind, workType: (c.workType as string) ?? null, serviceLocation: (c.serviceLocation as string) ?? null,
    siteAddress: (c.siteAddress as string) ?? null, returnReason: (c.returnReason as string) ?? null,
    afterSaleResolution: (c.afterSaleResolution as string) ?? null, profileSnapshot: c.profileSnapshot ?? null,
    appointmentId, deviceId: c.deviceId === null ? null : Number(c.deviceId),
  });
  const detailBlockers = opts.detailBlockersAt ? await countDetailBlockers(tx, businessId, caseId, appointmentId, opts.detailBlockersAt) : null;
  const intake = (await tx.$queryRaw<{ cr: boolean; ar: boolean; cs: boolean; sig: string | null }[]>`
    SELECT "conditionRecorded" AS cr, "accessoriesRecorded" AS ar, "customerSigned" AS cs, "signatureKey" AS sig
      FROM "ServiceCaseIntake" WHERE "caseId" = ${caseId}::int AND "businessId" = ${businessId}::int`)[0];
  const q = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT version, "totalAgorot", "docHash", state::text AS state, "approvalMethod"::text AS "approvalMethod", "approvedVersion", "approvedTotalAgorot", "approvedDocHash"
      FROM "ServiceQuote" WHERE "caseId" = ${caseId}::int AND "businessId" = ${businessId}::int ORDER BY version DESC LIMIT 1`)[0];
  const parts = Number((await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = ${caseId}::int AND "businessId" = ${businessId}::int AND state::text = ANY(${[...OPEN_PART_STATES]}::text[])`)[0]?.n ?? 0);
  return {
    signatureKey: intake?.sig ?? null,
    track,
    context: {
      appointmentId,
      track: track.track,
      details: track.details,
      detailBlockers,
      kind: c.kind as ServiceCaseKind,
      status: c.status as ServiceCaseStatus,
      holdReason: (c.holdReason as never) ?? null,
      outcome: (c.outcome as never) ?? null,
      version: Number(c.version),
      staffMemberId: c.staffMemberId === null ? null : Number(c.staffMemberId),
      siteId: null,
      coverage: c.coverageSource ? { source: c.coverageSource as never, decision: (c.coverageDecision ?? "PENDING") as never } : null,
      currentQuote: q ? {
        version: Number(q.version), totalAgorot: Number(q.totalAgorot), docHash: String(q.docHash), state: q.state as never,
        approval: q.approvalMethod && q.approvedVersion !== null ? { version: Number(q.approvedVersion), totalAgorot: Number(q.approvedTotalAgorot), docHash: String(q.approvedDocHash), method: q.approvalMethod as never } : null,
      } : null,
      intake: intake ? { conditionRecorded: intake.cr, accessoriesRecorded: intake.ar, customerSigned: intake.cs } : null,
      qaChecklistCompleted: c.qaCompletedAt !== null,
      openPartReservations: parts,
      openLoaner: false,
      cancellationRequested: c.cancellationRequested === true,
      pickupRemindersSent: Number(c.pickupRemindersSent),
      settlement: { known: false },
    },
  };
}

function inScope(type: unknown): type is (typeof IN_SCOPE_ACTIONS)[number] {
  return typeof type === "string" && (IN_SCOPE_ACTIONS as readonly string[]).includes(type);
}

/** The action as the core expects it, built from the request's own fields only. */
function actionFrom(raw: Record<string, unknown>): ServiceCaseAction {
  const type = raw.type;
  if (!inScope(type)) {
    if (typeof type === "string" && (QUOTE_COMMAND_ACTIONS as readonly string[]).includes(type)) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { action: type, use: "quotes" });
    if (typeof type === "string" && type in OUT_OF_SCOPE_ACTIONS) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { action: type });
    throw new ServiceDeskError("INVALID_INPUT", { field: "action.type" });
  }
  switch (type) {
    case "SET_HOLD":
      if (!SERVICE_HOLD_REASONS.includes(raw.reason as never)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return { type, reason: raw.reason as never };
    case "FINISH_REPAIR":
    case "PASS_QA":
      // REPLACED needs a replacement device link (LINK_REPLACEMENT_DEVICE) — not in 1.3a.
      if (raw.outcome === "REPLACED" || raw.replacementDeviceId !== undefined) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { action: `${type}:REPLACED` });
      // M1: COMPLETED for work that is not a repair (the core refuses it on a repair or a case without a track).
      if (raw.outcome !== undefined && raw.outcome !== "REPAIRED" && raw.outcome !== "COMPLETED") throw new ServiceDeskError("INVALID_INPUT", { field: "action.outcome" });
      if (type === "PASS_QA") {
        if (raw.outcome === undefined) throw new ServiceDeskError("INVALID_INPUT", { field: "action.outcome" });
        return { type, outcome: raw.outcome as "REPAIRED" | "COMPLETED" };
      }
      // M1: qa: true sends a track with OPTIONAL QA through QA.
      if (raw.qa !== undefined && typeof raw.qa !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "action.qa" });
      return {
        type,
        ...(raw.outcome === undefined ? {} : { outcome: raw.outcome as "REPAIRED" | "COMPLETED" }),
        ...(raw.qa === undefined ? {} : { qa: raw.qa as boolean }),
      };
    case "COMPLETE": {
      // M1: the owner confirms the work is done — no customer signature; the confirmer's name and a note are optional.
      const c = raw.completion as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.completionType !== "string" || typeof c.ownerConfirmed !== "boolean") {
        throw new ServiceDeskError("INVALID_INPUT", { field: "action.completion" });
      }
      for (const f of ["confirmedByName", "note"] as const) {
        if (c[f] !== undefined && c[f] !== null && typeof c[f] !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: `action.completion.${f}` });
      }
      const debt = raw.debtOverride;
      if (debt !== undefined && debt !== null && (typeof debt !== "object" || Array.isArray(debt) || typeof (debt as Record<string, unknown>).reason !== "string")) {
        throw new ServiceDeskError("INVALID_INPUT", { field: "action.debtOverride" });
      }
      return {
        type,
        completion: {
          completionType: c.completionType as never,
          ownerConfirmed: c.ownerConfirmed,
          confirmedByName: (c.confirmedByName as string | null | undefined) ?? null,
          note: (c.note as string | null | undefined) ?? null,
        },
        ...(debt ? { debtOverride: { reason: (debt as Record<string, unknown>).reason as string } } : {}),
      };
    }
    case "CHANGE_DETAILS": {
      // M1 D3: the full next details (the core compares them field by field with the locked case).
      const n = raw.next as Record<string, unknown> | undefined;
      if (!n || typeof n !== "object" || Array.isArray(n)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.next" });
      const known = new Set(["kind", "workType", "serviceLocation", "siteAddress", "returnReason"]);
      for (const k of Object.keys(n)) if (!known.has(k)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.next" });
      for (const k of known) if (n[k] !== null && n[k] !== undefined && typeof n[k] !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: `action.next.${k}` });
      if (raw.reason !== undefined && raw.reason !== null && typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      if (raw.appointmentImpact !== undefined && raw.appointmentImpact !== null && raw.appointmentImpact !== "KEEP_TIME" && raw.appointmentImpact !== "UNSCHEDULE") {
        throw new ServiceDeskError("INVALID_INPUT", { field: "action.appointmentImpact" });
      }
      return {
        type,
        next: {
          kind: n.kind as never,
          workType: (n.workType ?? null) as never,
          serviceLocation: (n.serviceLocation ?? null) as never,
          siteAddress: (n.siteAddress ?? null) as string | null,
          returnReason: (n.returnReason ?? null) as never,
        },
        reason: (raw.reason ?? null) as string | null,
        ...(raw.appointmentImpact ? { appointmentImpact: raw.appointmentImpact as "KEEP_TIME" | "UNSCHEDULE" } : {}),
      };
    }
    case "CANCEL":
      if (raw.reason !== undefined && typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return raw.reason === undefined ? { type } : { type, reason: raw.reason as string };
    case "ABANDON":
      if (typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return { type, reason: raw.reason };
    case "DELIVER": {
      // 1.3c: the owner confirms the handover; the receiver's name is optional; overrides carry a reason (decision ש4).
      const r = raw.receipt as Record<string, unknown> | undefined;
      if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.handoverConfirmed !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "action.receipt" });
      if (r.receivedByName !== undefined && r.receivedByName !== null && typeof r.receivedByName !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.receipt.receivedByName" });
      const override = (o: unknown, field: string) => {
        if (o === undefined || o === null) return undefined;
        if (typeof o !== "object" || Array.isArray(o) || typeof (o as Record<string, unknown>).reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field });
        return { reason: (o as Record<string, unknown>).reason as string };
      };
      const debtOverride = override(raw.debtOverride, "action.debtOverride");
      const loanerOverride = override(raw.loanerOverride, "action.loanerOverride");
      return {
        type, receipt: { handoverConfirmed: r.handoverConfirmed, receivedByName: typeof r.receivedByName === "string" ? r.receivedByName.trim() || null : null },
        ...(debtOverride ? { debtOverride } : {}), ...(loanerOverride ? { loanerOverride } : {}),
      } as ServiceCaseAction;
    }
    case "CHECK_IN":
      if (raw.intakeConfirmed !== undefined && typeof raw.intakeConfirmed !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "action.intakeConfirmed" });
      return raw.intakeConfirmed === true ? { type, intakeConfirmed: true } : { type };
    default:
      return { type } as ServiceCaseAction;
  }
}

/** What a command prepared outside the case transaction for an effect (1.3c: the next quote version of a revision). */
export type EffectExtras = { nextQuote?: FrozenQuote };

/**
 * The decision's effects, in the command's transaction, BEFORE the case row and its event are written (the case lock is
 * held; the effects read the case as it stood when the core decided):
 *   RELEASE_PART_RESERVATIONS — every RESERVED part line → NEEDED, each with its RELEASED event (part-release.ts);
 *   WITHDRAW_OPEN_QUOTE       — the SENT version the core named → WITHDRAWN (quote-rows.ts);
 *   SUPERSEDE_OPEN_QUOTE      — N → SUPERSEDED and the prepared N+1 inserted as the one SENT version (revise command only);
 *   ATTEMPT_AUTO_CLOSE        — no-op: an auto-close is the SYSTEM actor's (contracts: "SYSTEM is the future sweep /
 *                               auto-close"), never the owner's handover command; the case stays DELIVERED (a valid state)
 *                               and the owner closes it with CLOSE (in scope since 1.3c) — or the future sweep does;
 *   LINK_REPLACEMENT_DEVICE   — still refused (no replacement device link yet).
 */
async function applyEffects(tx: Tx, b: number, caseId: number, context: ServiceCaseContext, d: Extract<ServiceTransitionDecision, { ok: true }>, userId: number, prepared: Prepared, extras: EffectExtras = {}) {
  // LINK_APPOINTMENT belongs to RESCHEDULE, which stays out of scope with SCHEDULE (owner 1.3a P1).
  const refusedEffects = d.effects.filter((e) => e === "LINK_REPLACEMENT_DEVICE" || e === "LINK_APPOINTMENT");
  if (refusedEffects.length > 0) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { effects: [...refusedEffects] });
  for (const effect of d.effects) {
    switch (effect) {
      case "RELEASE_PART_RESERVATIONS":
        await releaseCaseReservations(tx, b, caseId, context, userId, prepared);
        break;
      case "WITHDRAW_OPEN_QUOTE":
        if (!d.withdrawQuote) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "OPEN_QUOTE_PRESENT" });
        await withdrawOpenQuote(tx, b, caseId, d.withdrawQuote, userId);
        break;
      case "SUPERSEDE_OPEN_QUOTE":
        if (!d.supersedeQuote) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "OPEN_QUOTE_PRESENT" });
        await supersedeOpenQuote(tx, b, caseId, d.supersedeQuote.superseded, d.supersedeQuote.next, extras.nextQuote, userId);
        break;
      default:
        break; // ATTEMPT_AUTO_CLOSE — see above
    }
  }
}

/**
 * One judged transition, written (1.3c, for the sibling quote commands): the effects, the case row (status / hold /
 * outcome / cancel request / version / stamps / reasons, compare-and-set on the version) and its event with seq = the new
 * version — the same writes runCaseAction makes. The caller holds the case lock (journaled + lockCase), compared the
 * version, ran the core and verified every server check. Returns the new version.
 */
export async function commitTransition(tx: Tx, b: number, caseId: number, context: ServiceCaseContext, d: Extract<ServiceTransitionDecision, { ok: true }>, userId: number, prepared: Prepared, extras: EffectExtras = {}): Promise<number> {
  await applyEffects(tx, b, caseId, context, d, userId, prepared, extras);
  const next = context.version + 1;
  const st = stampsFor(d);
  // M1 — written in THIS one update (the deferred journal / completion triggers read the version it sets):
  //   RECORD_DETAIL_CHANGE  the new details (kind follows the place); UNLINK_APPOINTMENT  the case no longer names it;
  //   RECORD_COMPLETION     completionType / completedAt (write-once in the guard).
  const dc = d.effects.includes("RECORD_DETAIL_CHANGE") ? d.detailChange ?? null : null;
  if (d.effects.includes("RECORD_DETAIL_CHANGE") && !dc) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "DETAIL_CHANGE_PRESENT" });
  const done = d.effects.includes("RECORD_COMPLETION") ? d.completion ?? null : null;
  if (d.effects.includes("RECORD_COMPLETION") && !done) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "COMPLETION_PRESENT" });
  const unlink = d.effects.includes("UNLINK_APPOINTMENT");
  const updated = await tx.$executeRaw`
    UPDATE "ServiceCase" SET status = ${d.to}::"ServiceCaseStatus", "holdReason" = ${d.holdReason}::"ServiceHoldReason", outcome = ${d.outcome}::"ServiceOutcome",
           "cancellationRequested" = ${d.cancellationRequestedAfter}::boolean, version = ${next}::int, "updatedAt" = now(),
           "checkedInAt" = CASE WHEN ${st.checkedIn}::boolean THEN now() ELSE "checkedInAt" END,
           "readyAt" = CASE WHEN ${st.ready}::boolean THEN now() ELSE "readyAt" END,
           "deliveredAt" = CASE WHEN ${d.statusChanged && d.to === "DELIVERED"}::boolean AND "deliveredAt" IS NULL THEN now() ELSE "deliveredAt" END,
           "closedAt" = CASE WHEN ${st.closed}::boolean AND "closedAt" IS NULL THEN now() ELSE "closedAt" END,
           "cancelledAt" = CASE WHEN ${st.cancelled}::boolean AND "cancelledAt" IS NULL THEN now() ELSE "cancelledAt" END,
           "abandonedAt" = CASE WHEN ${st.abandoned}::boolean AND "abandonedAt" IS NULL THEN now() ELSE "abandonedAt" END,
           -- a new QA round (the case enters QA again, e.g. FAIL_QA → repair → QA) needs its own complete checklist:
           -- a stamp left from an earlier round never lets PASS_QA through without a fresh check
           "qaCompletedAt" = CASE WHEN ${d.statusChanged && d.to === "QA"}::boolean THEN NULL ELSE "qaCompletedAt" END,
           "cancelReason" = COALESCE("cancelReason", ${d.texts.cancelReason}::text),
           "abandonReason" = COALESCE("abandonReason", ${d.texts.abandonReason}::text),
           kind = CASE WHEN ${dc !== null}::boolean THEN ${dc?.after.kind ?? null}::"ServiceCaseKind" ELSE kind END,
           "workType" = CASE WHEN ${dc !== null}::boolean THEN ${dc?.after.workType ?? null}::"ServiceWorkType" ELSE "workType" END,
           "serviceLocation" = CASE WHEN ${dc !== null}::boolean THEN ${dc?.after.serviceLocation ?? null}::"ServiceLocationKind" ELSE "serviceLocation" END,
           "siteAddress" = CASE WHEN ${dc !== null}::boolean THEN ${dc?.after.siteAddress ?? null}::text ELSE "siteAddress" END,
           "returnReason" = CASE WHEN ${dc !== null}::boolean THEN ${dc?.after.returnReason ?? null}::"ServiceReturnReason" ELSE "returnReason" END,
           "appointmentId" = CASE WHEN ${unlink}::boolean THEN NULL ELSE "appointmentId" END,
           "completionType" = CASE WHEN ${done !== null}::boolean THEN ${done?.completionType ?? null}::"ServiceCompletionType" ELSE "completionType" END,
           "completedAt" = CASE WHEN ${done !== null}::boolean THEN now() ELSE "completedAt" END
     WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${context.version}::int`;
  if (updated !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
  await appendEvent(tx, b, caseId, next, d.event, userId, prepared);
  if (done) {
    // One per case (UNIQUE), immutable, the acting user, no signature columns (owner decision 2026-11-11). The balance is
    // the one the core judged from the settlement read in THIS transaction (never a stand-in for an unknown one); an
    // open debt is stored with the acting owner as its approver and the transaction time as the approval time — the
    // database refuses a debt without reason / approver / time and any approval field without a debt.
    const debt = done.openBalanceAgorot > 0;
    if (debt !== done.debtApproved || (debt && !d.texts.debtOverrideReason)) {
      throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "DEBT_DECISION_PRESENT" });
    }
    await tx.$executeRaw`
      INSERT INTO "ServiceCompletion" ("businessId", "caseId", "completionType", "confirmedByName", note, "openBalanceAgorot", "overpaidAgorot",
        "debtOverrideReason", "debtApprovedByUserId", "debtApprovedAt", "actorUserId")
      VALUES (${b}::int, ${caseId}::int, ${done.completionType}::"ServiceCompletionType", ${done.confirmedByName}::text, ${done.note}::text,
              ${done.openBalanceAgorot}::int, ${done.overpaidAgorot}::int, ${debt ? d.texts.debtOverrideReason : null}::text,
              ${debt ? userId : null}::int, CASE WHEN ${debt}::boolean THEN now() END, ${userId}::int)`;
  }
  if (dc) {
    // D11: before / after at the event's seq (= the version this update set); the journal keeps field names only.
    await tx.$executeRaw`
      INSERT INTO "ServiceCaseDetailChange" ("businessId", "caseId", "caseVersion", "changedFields", "kindBefore", "kindAfter",
        "workTypeBefore", "workTypeAfter", "serviceLocationBefore", "serviceLocationAfter", "returnReasonBefore", "returnReasonAfter",
        "siteAddressBefore", "siteAddressAfter", reason, "actorUserId")
      VALUES (${b}::int, ${caseId}::int, ${next}::int, ${[...dc.changedFields]}::text[], ${dc.before.kind}::"ServiceCaseKind", ${dc.after.kind}::"ServiceCaseKind",
        ${dc.before.workType}::"ServiceWorkType", ${dc.after.workType}::"ServiceWorkType",
        ${dc.before.serviceLocation}::"ServiceLocationKind", ${dc.after.serviceLocation}::"ServiceLocationKind",
        ${dc.before.returnReason}::"ServiceReturnReason", ${dc.after.returnReason}::"ServiceReturnReason",
        ${dc.before.siteAddress}::text, ${dc.after.siteAddress}::text, ${dc.reason}::text, ${userId}::int)`;
  }
  return next;
}

export async function runCaseAction(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { action?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
  deps: { settlement?: SettlementReader } = {},
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new ServiceDeskError("INVALID_INPUT", { field: "action" });
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const action = actionFrom(body.action as Record<string, unknown>);
  const prepared = prepare(p, req, "service-desk/cases:action", { caseId, action, expectedVersion: body.expectedVersion });
  const b = p.businessId;

  const lockOpts = action.type === "CHANGE_DETAILS" ? { detailBlockersAt: prepared.now } : {};
  return journaled<CommandResult, Locked>(p, prepared, (tx) => lockCase(tx, b, caseId, lockOpts), async (tx, { context: locked, signatureKey, track }) => {
    // 1.3c: a handover reads the balance HERE — same transaction, under the case lock. Unknown stays unknown (blocked).
    // The default reader is the real one (case charge + billing links + billing facts); without migration 20261126090000
    // it answers UNKNOWN / NOT_LINKED, as before. M1: the owner-confirmed COMPLETE is judged by the same balance rule.
    const readsBalance = action.type === "DELIVER" || action.type === "COMPLETE";
    const settlement = readsBalance ? await (deps.settlement ?? readCaseSettlement)(tx, b, caseId) : null;
    const context = settlement ? { ...locked, settlement: settlementForCore(settlement) } : locked;
    const envelope = checkCommandEnvelope(context, { caseId, action, expectedVersion: body.expectedVersion as number, idempotencyKey: prepared.key });
    if (!envelope.ok) throw refused(envelope.violations);
    const d = evaluateTransition(context, action, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw refused(d.violations);
    await verifyServerChecks(tx, b, d.serverChecks, { staffMemberId: context.staffMemberId, signatureKey, settlementRead: settlement !== null, caseId, track, decision: d });
    const next = await commitTransition(tx, b, caseId, context, d, p.userId, prepared);
    if (action.type === "DELIVER" && d.statusChanged && d.to === "DELIVERED") {
      // the core admitted the handover only on a known balance; an unknown one is never recorded as 0
      if (settlement === null || settlement.openBalanceAgorot === null) throw new ServiceDeskError("BALANCE_UNKNOWN");
      // The handover record: one per case (UNIQUE), immutable, the acting user, no signature (owner decision 2026-11-11).
      const receipt = (action as { receipt: { receivedByName?: string | null } }).receipt;
      const texts = d.texts as { debtOverrideReason?: string | null; loanerOverrideReason?: string | null };
      await tx.$executeRaw`
        INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot", "debtOverrideReason", "loanerOverrideReason", "actorUserId")
        VALUES (${b}::int, ${caseId}::int, ${receipt.receivedByName ?? null}::text, false, ${settlement.openBalanceAgorot}::int,
                ${texts.debtOverrideReason ?? null}::text, ${texts.loanerOverrideReason ?? null}::text, ${p.userId}::int)`;
      // A presented warranty offer locks at the handover: starts on the delivery day, ends one duration later (guard rules).
      await tx.$executeRaw`
        UPDATE "ServiceWarrantyOffer" o SET state = 'LOCKED', "lockedAt" = now(), "startsOn" = h."deliveredAt"::date,
               "endsOn" = public.service_warranty_end(h."deliveredAt"::date, o."durationValue", o."durationUnit"), "updatedAt" = now()
          FROM "ServiceHandover" h
         WHERE o."businessId" = ${b}::int AND o."caseId" = ${caseId}::int AND o.state = 'PRESENTED'
           AND h."businessId" = o."businessId" AND h."caseId" = o."caseId"`;
    }
    return { case: await summaryOf(tx, b, caseId), event: { seq: next }, replayed: false };
  }, async (tx, prior) => {
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), event: { seq: prior.seq }, replayed: true };
  });
}

// ── P4: status-preserving records (journaled, versioned, idempotent) ────────────────────────────────────────

/**
 * The audit journal of migration 20261122090000 is present: its event types and its settings table. Fail closed —
 * without it, the three record writes answer NOT_AVAILABLE_UNTIL_AUDIT before anything is written (owner rule).
 */
async function auditJournalReady(tx: Tx): Promise<boolean> {
  const r = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceEventType' AND e.enumlabel = 'qa.recorded')
        AND to_regclass('public."ServiceSettingsEvent"') IS NOT NULL) AS ok`;
  return r[0]?.ok === true;
}

async function requireAuditJournal(tx: Tx) {
  if (!(await auditJournalReady(tx))) throw new ServiceDeskError("NOT_AVAILABLE_UNTIL_AUDIT");
}

export type RecordAction = "ASSIGN_TECHNICIAN" | "RECORD_INTAKE" | "RECORD_QA" | "RECORD_CHARGE" | "LINK_BILLING_DOCUMENT" | "UNLINK_BILLING_DOCUMENT" | "CHOOSE_QA_LIST";
const RECORD_EVENT: Record<RecordAction, string> = {
  ASSIGN_TECHNICIAN: "case.technician_assigned",
  RECORD_INTAKE: "intake.recorded",
  RECORD_QA: "qa.recorded",
  // migration 20261126090000 (CHECK ServiceCaseEvent_charge_in_place): the case charge and its billing links
  RECORD_CHARGE: "charge.recorded",
  LINK_BILLING_DOCUMENT: "billing.linked",
  UNLINK_BILLING_DOCUMENT: "billing.unlinked",
  // migration 20261129090000 (CHECK ServiceCaseEvent_qa_list_in_place): the case names a QA list version (or none)
  CHOOSE_QA_LIST: "qa.list_chosen",
};

/** Bump the case version (status, hold, cancel request, outcome untouched) and append the record with seq = version. */
export async function appendRecord(tx: Tx, b: number, caseId: number, c: ServiceCaseContext, action: RecordAction, payload: Record<string, string | number | boolean | null>, userId: number, prepared: Prepared): Promise<number> {
  const next = c.version + 1;
  const n = await tx.$executeRaw`UPDATE "ServiceCase" SET version = ${next}::int, "updatedAt" = now() WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND version = ${c.version}::int`;
  if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
  return insertRecordEvent(tx, b, caseId, c, action, payload, userId, prepared);
}

/**
 * The record event alone, with seq = c.version + 1 — for a command that bumps the case version in its OWN update (a QA list
 * choice: the list columns and the version in one statement, as its guard demands). Returns the new version.
 */
export async function insertRecordEvent(tx: Tx, b: number, caseId: number, c: ServiceCaseContext, action: RecordAction, payload: Record<string, string | number | boolean | null>, userId: number, prepared: Prepared): Promise<number> {
  const next = c.version + 1;
  await tx.$executeRaw`
    INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "holdReasonBefore", "holdReasonAfter",
      "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES (${b}::int, ${caseId}::int, ${next}::int, ${RECORD_EVENT[action]}::"ServiceEventType", ${action}::"ServiceCaseAction",
      ${c.status}::"ServiceCaseStatus", ${c.status}::"ServiceCaseStatus", ${c.holdReason}::"ServiceHoldReason", ${c.holdReason}::"ServiceHoldReason",
      ${c.cancellationRequested}::boolean, ${c.cancellationRequested}::boolean, ${c.outcome}::"ServiceOutcome", 'OWNER_USER'::"ServiceActor", ${userId}::int,
      ${JSON.stringify(payload)}::jsonb, ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
  return next;
}

const isTerminalStatus = (s: ServiceCaseStatus) => s === "CLOSED" || s === "CANCELLED";

/** A case record command: lock the case → the journal present? → an earlier answer? → expectedVersion → work. */
export async function recordCommand(
  p: ServiceDeskPrincipal,
  caseId: number,
  expectedVersion: unknown,
  prepared: Prepared,
  work: (tx: Tx, locked: Locked) => Promise<void>,
): Promise<CommandResult> {
  if (!isNonNegativeInt(expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const b = p.businessId;
  return journaled<CommandResult, Locked>(p, prepared, async (tx) => {
    const locked = await lockCase(tx, b, caseId);
    await requireAuditJournal(tx);
    return locked;
  }, async (tx, locked) => {
    if (locked.context.version !== expectedVersion) throw new ServiceDeskError("VERSION_CONFLICT");
    await work(tx, locked);
    const s = await summaryOf(tx, b, caseId);
    return { case: s, event: { seq: s.version }, replayed: false };
  }, async (tx, prior) => {
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), event: { seq: prior.seq }, replayed: true };
  });
}

/** Assign an existing active staff member of the business, or none (the owner handles it). Journaled (P4). */
export async function assignTechnician(p: ServiceDeskPrincipal, caseId: unknown, body: { staffMemberId?: unknown; expectedVersion?: unknown }, req: WriteRequest): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const to = body.staffMemberId ?? null;
  if (to !== null && !isPositiveInt(to)) throw new ServiceDeskError("INVALID_INPUT", { field: "staffMemberId" });
  const prepared = prepare(p, req, "service-desk/cases:technician", { caseId, staffMemberId: to, expectedVersion: body.expectedVersion });
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    if (isTerminalStatus(context.status)) throw new ServiceDeskError("REFUSED", { violations: ["TERMINAL_STATUS"] });
    if (context.staffMemberId === to) throw new ServiceDeskError("REFUSED", { violations: ["NO_CHANGE"] });
    if (to !== null && !(await staffOfBusiness(tx, p.businessId, to as number))) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "STAFF_BELONGS_TO_BUSINESS" });
    await tx.$executeRaw`UPDATE "ServiceCase" SET "staffMemberId" = ${to as number | null}::int WHERE id = ${caseId}::int AND "businessId" = ${p.businessId}::int`;
    await appendRecord(tx, p.businessId, caseId, context, "ASSIGN_TECHNICIAN", { fromStaffMemberId: context.staffMemberId, toStaffMemberId: to as number | null }, p.userId, prepared);
  });
}

const NOTE_MAX = 2000;

/** The intake data of an IN_SHOP case before check-in (no signature, no PDF). Journaled (P4): which fields changed, never the text. */
export async function recordIntake(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { conditionNote?: unknown; accessoriesNote?: unknown; conditionRecorded?: unknown; accessoriesRecorded?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const note = (v: unknown, field: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || [...v].length > NOTE_MAX) throw new ServiceDeskError("INVALID_INPUT", { field });
    return v.trim() === "" ? null : v.trim();
  };
  const conditionNote = note(body.conditionNote, "conditionNote");
  const accessoriesNote = note(body.accessoriesNote, "accessoriesNote");
  if (typeof body.conditionRecorded !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "conditionRecorded" });
  if (typeof body.accessoriesRecorded !== "boolean") throw new ServiceDeskError("INVALID_INPUT", { field: "accessoriesRecorded" });
  const cr = body.conditionRecorded, ar = body.accessoriesRecorded;
  const prepared = prepare(p, req, "service-desk/cases:intake", { caseId, conditionNote, accessoriesNote, conditionRecorded: cr, accessoriesRecorded: ar, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    if (context.kind !== "IN_SHOP") throw new ServiceDeskError("REFUSED", { violations: ["INTAKE_ONLY_IN_SHOP"] });
    if (!["OPEN", "SCHEDULED"].includes(context.status)) throw new ServiceDeskError("REFUSED", { violations: ["INTAKE_ONLY_BEFORE_CHECK_IN"] });
    const cur = (await tx.$queryRaw<{ cn: string | null; an: string | null; cr: boolean; ar: boolean; signed: boolean }[]>`
      SELECT "conditionNote" AS cn, "accessoriesNote" AS an, "conditionRecorded" AS cr, "accessoriesRecorded" AS ar, "signedAt" IS NOT NULL AS signed
        FROM "ServiceCaseIntake" WHERE "caseId" = ${caseId}::int AND "businessId" = ${b}::int`)[0];
    if (cur?.signed) throw new ServiceDeskError("REFUSED", { violations: ["INTAKE_SIGNED"] });
    const changed = {
      created: !cur,
      conditionNoteChanged: (cur?.cn ?? null) !== conditionNote,
      accessoriesNoteChanged: (cur?.an ?? null) !== accessoriesNote,
      conditionRecordedChanged: (cur?.cr ?? false) !== cr,
      accessoriesRecordedChanged: (cur?.ar ?? false) !== ar,
    };
    if (cur && !changed.conditionNoteChanged && !changed.accessoriesNoteChanged && !changed.conditionRecordedChanged && !changed.accessoriesRecordedChanged) {
      throw new ServiceDeskError("REFUSED", { violations: ["NO_CHANGE"] });
    }
    if (!cur) {
      await tx.$executeRaw`
        INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "conditionNote", "accessoriesNote", "conditionRecorded", "accessoriesRecorded", "updatedAt")
        VALUES (${b}::int, ${caseId}::int, ${conditionNote}::text, ${accessoriesNote}::text, ${cr}::boolean, ${ar}::boolean, now())`;
    } else {
      await tx.$executeRaw`
        UPDATE "ServiceCaseIntake" SET "conditionNote" = ${conditionNote}::text, "accessoriesNote" = ${accessoriesNote}::text,
               "conditionRecorded" = ${cr}::boolean, "accessoriesRecorded" = ${ar}::boolean, "updatedAt" = now()
         WHERE "caseId" = ${caseId}::int AND "businessId" = ${b}::int`;
    }
    await appendRecord(tx, b, caseId, context, "RECORD_INTAKE", { ...changed, conditionRecorded: cr, accessoriesRecorded: ar }, p.userId, prepared);
  });
}

/**
 * QA results, while the case is in QA (P3 / P4; per-business lists since migration 20261129090000). The checklist is the
 * one the case names: its chosen QA list VERSION, or — without one — its track's (snapshot) / kind's built-in template,
 * exactly as before. The case counts as "QA completed" (qaCompletedAt) only when every REQUIRED check is PASS; otherwise
 * it is cleared and the case machine keeps refusing PASS_QA. Stored on the case (qaChecklist: tokens only) and journaled
 * (P4); with the migration also one ServiceCaseQaRecord at the event's seq and one row per check (result, the check's
 * REQUIRED flag as it is in that version, an optional note) — the case's QA history, never rewritten by a later edit of
 * the list. Without the migration: today's behaviour, and a note is refused.
 */
export async function recordQa(p: ServiceDeskPrincipal, caseId: unknown, body: { results?: unknown; expectedVersion?: unknown }, req: WriteRequest): Promise<CommandResult & { qa?: { completed: boolean; template: string; list: { listId: number; listVersion: number } | null } }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const prepared = prepare(p, req, "service-desk/cases:qa", { caseId, results: body.results ?? null, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  let qa: { completed: boolean; template: string; list: { listId: number; listVersion: number } | null } | undefined;
  const r = await recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, { context }) => {
    if (context.status !== "QA") throw new ServiceDeskError("REFUSED", { violations: ["QA_ONLY_IN_QA"] });
    // M1: a track case is checked against its own snapshot (QA OFF on its track: nothing to record).
    if (context.track && context.track.requirements.qa.mode === "OFF") throw new ServiceDeskError("REFUSED", { violations: ["QA_NOT_FOR_KIND"] });
    const lists = await qaListsSchemaReady(tx);
    const chosen = lists ? await caseQaChoice(tx, b, caseId) : null;
    let items: readonly { key: string; required: boolean }[];
    let token: string;
    if (chosen) {
      const v = await readVersion(tx, b, chosen.listId, chosen.listVersion);
      if (!v) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "QA_LIST_VERSION_PRESENT" });
      items = v.items;
      token = listChecklistToken(chosen.listId, chosen.listVersion);
    } else {
      const trackTemplate = context.track?.requirements.qa.template ?? null;
      const t = qaTemplateFor(context.kind, trackTemplate);
      if (!t) throw new ServiceDeskError("INVALID_INPUT", { field: trackTemplate ? "template" : "kind" });
      items = t.items;
      token = t.id;
    }
    const e = evaluateChecklist(items, body.results, { notes: lists });
    if (!e.ok) throw new ServiceDeskError("INVALID_INPUT", { field: e.field });
    const checklist = { template: token, results: Object.fromEntries(e.results.map((x) => [x.key, x.result])) };
    await tx.$executeRaw`
      UPDATE "ServiceCase" SET "qaChecklist" = ${JSON.stringify(checklist)}::jsonb,
             "qaCompletedAt" = CASE WHEN ${e.completed}::boolean THEN now() ELSE NULL END
       WHERE id = ${caseId}::int AND "businessId" = ${b}::int`;
    qa = { completed: e.completed, template: token, list: chosen };
    const next = await appendRecord(tx, b, caseId, context, "RECORD_QA",
      { template: token, completed: e.completed, ...e.counts, ...(chosen ? { listId: chosen.listId, listVersion: chosen.listVersion } : {}) }, p.userId, prepared);
    if (lists) {
      await insertQaRecord(tx, b, caseId, next, {
        list: chosen, templateId: chosen ? null : token, itemCount: items.length, results: e.results, counts: e.counts, completed: e.completed, userId: p.userId,
      });
    }
  });
  return { ...r, qa };
}

// ── Settings (default technician, warranty template) — journaled in ServiceSettingsEvent (P4) ──────────────

export type ServiceSettingsView = {
  version: number | null; defaultStaffMemberId: number | null;
  warrantyTemplate: { value: number; unit: "DAYS" | "MONTHS"; scope: string; exclusions: string | null } | null;
  activeTermsVersionId: number | null; activeStatutoryNoticeVersionId: number | null;
};

async function readSettings(tx: Tx, businessId: number): Promise<ServiceSettingsView> {
  const s = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT version, "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit"::text AS unit, "warrantyTemplateScope", "warrantyTemplateExclusions",
           "activeTermsVersionId", "activeStatutoryNoticeVersionId" FROM "ServiceSettings" WHERE "businessId" = ${businessId}::int`)[0];
  if (!s) return { version: null, defaultStaffMemberId: null, warrantyTemplate: null, activeTermsVersionId: null, activeStatutoryNoticeVersionId: null };
  return {
    version: Number(s.version),
    defaultStaffMemberId: s.defaultStaffMemberId === null ? null : Number(s.defaultStaffMemberId),
    warrantyTemplate: s.warrantyTemplateValue === null ? null : {
      value: Number(s.warrantyTemplateValue), unit: s.unit as "DAYS" | "MONTHS", scope: String(s.warrantyTemplateScope),
      exclusions: (s.warrantyTemplateExclusions as string) ?? null,
    },
    activeTermsVersionId: s.activeTermsVersionId === null ? null : Number(s.activeTermsVersionId),
    activeStatutoryNoticeVersionId: s.activeStatutoryNoticeVersionId === null ? null : Number(s.activeStatutoryNoticeVersionId),
  };
}

export async function getSettings(businessId: number): Promise<ServiceSettingsView> {
  return tenantTx(businessId, (tx) => readSettings(tx, businessId));
}

export type ServiceStaffMember = { id: number; displayName: string };

/**
 * UI 1.3a: the staff members a case or the settings may name — this business's active, not erased staff, in the business's
 * own order. The same rows `staffOfBusiness` accepts, so a pick from this list passes the server check. Read only; under the
 * Service Desk gate (not the appointments flag), so the settings screen does not depend on another module being open.
 */
export async function listActiveStaff(businessId: number): Promise<{ staff: ServiceStaffMember[] }> {
  const rows = await tenantTx(businessId, (tx) => tx.$queryRaw<{ id: number; displayName: string }[]>`
    SELECT id, "displayName" FROM "StaffMember"
     WHERE "businessId" = ${businessId}::int AND active AND "erasedAt" IS NULL
     ORDER BY "sortOrder", id`);
  return { staff: rows.map((r) => ({ id: Number(r.id), displayName: String(r.displayName) })) };
}

/** The settings journal is its own ledger: same key + same request → the stored answer (the current settings). */
async function findPriorSettings(tx: Tx, businessId: number, p: Prepared): Promise<boolean> {
  const rows = await tx.$queryRaw<{ d: string | null; k: string | null }[]>`
    SELECT "requestDigest" AS d, "digestKeyId" AS k FROM "ServiceSettingsEvent" WHERE "businessId" = ${businessId}::int AND "idempotencyKey" = ${p.key}::text`;
  const origin = rows[0];
  if (!origin) return false;
  if (!origin.d || !origin.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(p.keys, origin.k, p.ident);
  if (!expected || !sameDigest(expected, origin.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return true;
}

/**
 * Replace the default technician and the warranty template. `expectedVersion` is null for the first save. The change and
 * its ServiceSettingsEvent (the field names that changed) are ONE transaction; the database refuses an event that does
 * not name the version just written. The active terms / statutory notice are not set here (1.3b).
 */
export async function updateSettings(p: ServiceDeskPrincipal, body: { expectedVersion?: unknown; defaultStaffMemberId?: unknown; warrantyTemplate?: unknown }, req: WriteRequest): Promise<ServiceSettingsView & { replayed: boolean }> {
  const b = p.businessId;
  const staff = body.defaultStaffMemberId ?? null;
  if (staff !== null && !isPositiveInt(staff)) throw new ServiceDeskError("INVALID_INPUT", { field: "defaultStaffMemberId" });
  if (body.expectedVersion !== null && body.expectedVersion !== undefined && !isPositiveInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  let w: ServiceSettingsView["warrantyTemplate"] = null;
  if (body.warrantyTemplate !== null && body.warrantyTemplate !== undefined) {
    const t = body.warrantyTemplate as Record<string, unknown>;
    const ok = typeof t === "object" && isPositiveInt(t.value) && (t.unit === "DAYS" || t.unit === "MONTHS")
      && typeof t.scope === "string" && t.scope.trim().length > 0 && [...t.scope].length <= 2000
      && (t.exclusions === null || t.exclusions === undefined || (typeof t.exclusions === "string" && t.exclusions.trim().length > 0 && [...t.exclusions].length <= 2000))
      && ((t.unit === "DAYS" && (t.value as number) <= 3650) || (t.unit === "MONTHS" && (t.value as number) <= 120));
    if (!ok) throw new ServiceDeskError("INVALID_INPUT", { field: "warrantyTemplate" });
    w = { value: t.value as number, unit: t.unit as "DAYS" | "MONTHS", scope: (t.scope as string).trim(), exclusions: t.exclusions ? (t.exclusions as string).trim() : null };
  }
  const expected = (body.expectedVersion ?? null) as number | null;
  const prepared = prepare(p, req, "service-desk/settings", { expectedVersion: expected, defaultStaffMemberId: staff, warrantyTemplate: w });
  const attempt = () => tenantTx(b, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53445354}::int, ${b}::int)`; // 'SDST' — one settings writer per business
    await requireAuditJournal(tx);
    if (await findPriorSettings(tx, b, prepared)) return { ...(await readSettings(tx, b)), replayed: true };
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const cur = await readSettings(tx, b);
    if (cur.version !== expected) throw new ServiceDeskError("VERSION_CONFLICT");
    const changedFields = [
      ...(cur.defaultStaffMemberId !== staff ? ["defaultStaffMemberId"] : []),
      ...(JSON.stringify(cur.warrantyTemplate) !== JSON.stringify(w) ? ["warrantyTemplate"] : []),
    ];
    if (changedFields.length === 0) throw new ServiceDeskError("REFUSED", { violations: ["NO_CHANGE"] });
    if (staff !== null && !(await staffOfBusiness(tx, b, staff as number))) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "STAFF_BELONGS_TO_BUSINESS" });
    if (cur.version === null) {
      await tx.$executeRaw`
        INSERT INTO "ServiceSettings" ("businessId", "defaultStaffMemberId", "warrantyTemplateValue", "warrantyTemplateUnit", "warrantyTemplateScope", "warrantyTemplateExclusions", "updatedAt")
        VALUES (${b}::int, ${staff as number | null}::int, ${w?.value ?? null}::int, ${w?.unit ?? null}::"ServiceDurationUnit", ${w?.scope ?? null}::text, ${w?.exclusions ?? null}::text, now())`;
    } else {
      await tx.$executeRaw`
        UPDATE "ServiceSettings" SET "defaultStaffMemberId" = ${staff as number | null}::int, "warrantyTemplateValue" = ${w?.value ?? null}::int,
               "warrantyTemplateUnit" = ${w?.unit ?? null}::"ServiceDurationUnit", "warrantyTemplateScope" = ${w?.scope ?? null}::text,
               "warrantyTemplateExclusions" = ${w?.exclusions ?? null}::text, version = version + 1, "updatedAt" = now()
         WHERE "businessId" = ${b}::int AND version = ${cur.version}::int`;
    }
    const after = await readSettings(tx, b);
    await tx.$executeRaw`
      INSERT INTO "ServiceSettingsEvent" ("businessId", "settingsVersion", "changedFields", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${after.version as number}::int, ${changedFields}::text[], 'OWNER_USER'::"ServiceActor", ${p.userId}::int,
              ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    return { ...after, replayed: false };
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

// ── M1 T7: choosing the after-sale resolution (section כח) ───────────────────────────────────────────────────

/**
 * POST /cases/[id]/after-sale { resolution, expectedVersion } — how a T7 case ends, chosen once, after inspection
 * (DIAGNOSING) or during the repair (IN_REPAIR). The choice is recorded on the case and journaled by the EXISTING
 * transitions it runs (decideAfterSale), each judged by the case machine with the resolution's own requirement row from
 * the case's snapshot, all in ONE transaction (a refused step rolls everything back):
 *   REPAIR → START_REPAIR · RETURN_ORIGINAL → MARK_NOT_REPAIRABLE (→ READY, handover) · CREDIT → [START_REPAIR] +
 *   FINISH_REPAIR COMPLETED (→ WORK_DONE; COMPLETE then needs the linked credit note). EXCHANGE is refused before anything
 * is written (EXCHANGE_NEEDS_INVENTORY). The first step's event names the resolution (a token); a second step's event
 * carries the request key with "#2" (the key is unique per event; a replay is answered from the first).
 */
export async function chooseAfterSaleResolution(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { resolution?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  if (typeof body.resolution !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "resolution" });
  const prepared = prepare(p, req, "service-desk/cases:after-sale", { caseId, resolution: body.resolution, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return journaled<CommandResult, Locked>(p, prepared, (tx) => lockCase(tx, b, caseId), async (tx, locked) => {
    const c = locked.context;
    if (c.version !== body.expectedVersion) throw new ServiceDeskError("VERSION_CONFLICT");
    const choice = decideAfterSale({ track: c.track?.track ?? null, status: c.status, current: c.track?.afterSaleResolution ?? null, resolution: body.resolution });
    if (!choice.ok) {
      if (choice.code === "INVALID_INPUT") throw new ServiceDeskError("INVALID_INPUT", { field: "resolution" });
      throw new ServiceDeskError("REFUSED", { violations: [choice.code] });
    }
    if (!locked.track.snapshot) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "PROFILE_SNAPSHOT_VALID" });
    const n = await tx.$executeRaw`
      UPDATE "ServiceCase" SET "afterSaleResolution" = ${choice.resolution}::"ServiceAfterSaleResolution"
       WHERE id = ${caseId}::int AND "businessId" = ${b}::int AND "afterSaleResolution" IS NULL AND version = ${c.version}::int`;
    if (n !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    // The facts with the chosen row (D14: still the case's own snapshot).
    let ctx: ServiceCaseContext = {
      ...c,
      track: buildTrackFacts({
        snapshot: locked.track.snapshot, kind: c.kind, workType: locked.track.details.workType, serviceLocation: locked.track.details.serviceLocation,
        subjectKind: locked.track.subjectKind, afterSaleResolution: choice.resolution, siteAddressSet: locked.track.details.siteAddress !== null,
        moneyCommitment: c.track?.moneyCommitment ?? false, creditDocumentLinked: c.track?.creditDocumentLinked ?? false,
      }),
    };
    let seq = c.version;
    for (const [i, step] of choice.steps.entries()) {
      const judged = evaluateTransition(ctx, step, { kind: "OWNER", userId: p.userId });
      if (!judged.ok) throw refused(judged.violations);
      // the first step's event names the resolution (a token; the payload object is the core's fresh copy)
      const d = i === 0 ? { ...judged, event: { ...judged.event, payload: { ...judged.event.payload, afterSaleResolution: choice.resolution } } } : judged;
      await verifyServerChecks(tx, b, d.serverChecks, { staffMemberId: ctx.staffMemberId, signatureKey: locked.signatureKey, caseId, track: locked.track, decision: d });
      const stepPrepared = i === 0 ? prepared : { ...prepared, key: deriveIdempotencyKey(prepared.key, i + 1) };
      seq = await commitTransition(tx, b, caseId, ctx, d, p.userId, stepPrepared);
      ctx = { ...ctx, status: d.to, holdReason: d.holdReason, outcome: d.outcome, cancellationRequested: d.cancellationRequestedAfter, version: seq };
    }
    return { case: await summaryOf(tx, b, caseId), event: { seq }, replayed: false };
  }, async (tx, prior) => {
    if (prior.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
    return { case: await summaryOf(tx, b, caseId), event: { seq: prior.seq }, replayed: true };
  });
}
