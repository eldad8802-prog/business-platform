/**
 * Service Desk 1d-B (stage 1, owner-approved 2026-11-10) — spare parts on a case WITHOUT any stock movement: the data
 * service over the existing core (parts.core.ts) and the existing tables of migration 20261115090000. SERVER-ONLY.
 *
 * In scope — none of these moves stock (parts.contracts: "states are not movements"):
 *   - add a part line (STOCK item or NON_STOCK description) → NEEDED, with its ADDED event;
 *   - RESERVE / RELEASE a STOCK line (the SOFT reservation of M1: it reads the item and the other reservations, never
 *     writes the inventory — the authoritative stock check stays the inventory writer's, at issue, after M0);
 *   - SET_PRICE (the price to the customer); CANCEL a line that never left the stock.
 * Out of scope, refused as ACTION_NOT_IN_SCOPE: ISSUE, RETURN, SEND_WITH_EXTERNAL, RESOLVE_FROM_EXTERNAL (stock or a
 * supplier movement — after M0 / with the supplier flow); MARK_ON_ORDER, UPDATE_ORDER (purchase orders — owner
 * decision: not in 1d-B); INSTALL, WRITE_OFF, CORRECT_COST (they need an issued line); RECORD_QUOTED (quotes, 1.3c).
 * Nothing here creates an inventory movement, an inventory item, a purchase order, a charge or a document.
 *
 * Each command is ONE tenant transaction with the module's rules (service-case.service.ts): lock the case (the part
 * triggers lock it too — same order, no cycle), then the part → an earlier answer in the part journal? → expectedVersion
 * → the core decides → every server check against the database → the line + its event. The database guards of
 * 20261115090000 re-check every write (one change kind per event, the event mirrors the line, no silent change).
 *
 * The reservation's "item lock" is a transaction advisory lock per inventory item, taken by this module only: it
 * serialises reservations of the same item against each other without locking the inventory's own rows (the inventory
 * module and the till are not touched or slowed). A reservation stays SOFT, as M1 decided.
 *
 * CLOSED TO USERS (owner, 2026-11-10): the routes refuse before calling this service while PARTS_API_OPEN is false —
 * until the intake confirmation path (1.3b, owner-confirmed, no customer signature) is complete and tested. The service itself is exercised by the lab.
 */
import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { checkIdempotencyKey, digestWithKeyId, sameDigest } from "@/lib/services/tasks/task-idempotency";

import type { ServiceCaseStatus, ServiceOutcome } from "./contracts";
import {
  PART_UNIT_TYPES,
  type PartAction,
  type PartActionType,
  type PartCaseFacts,
  type PartDecision,
  type PartServerCheck,
  type PartUnitType,
  type ServicePartSnapshot,
  type StockFacts,
} from "./parts.contracts";
import { addPart, checkPartEnvelope, evaluatePartAction } from "./parts.core";
import {
  guardRefusal,
  isNonNegativeInt,
  isPositiveInt,
  isUniqueViolation,
  prepare,
  type Prepared,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";
import { ServiceDeskError } from "./service-desk-errors";

/**
 * Owner decision 2026-11-10: users cannot reach these actions before the intake confirmation path (1.3b, owner-confirmed, no customer signature) is done.
 * A code constant, not a flag: opening it is a reviewed change in a later PR. Every parts route checks it first.
 *
 * BINDING BLOCKER (owner, 2026-11-10) — do not open before BOTH are done and tested:
 *   1. 1.3b intake confirmation path (owner-confirmed, no customer signature) complete and tested.
 *   2. Case CANCEL with open part reservations — IMPLEMENTED (1.3c, branch feat/service-desk-quotes-close): the core's
 *      RELEASE_PART_RESERVATIONS effect is applied by runCaseAction inside the cancel's transaction (part-release.ts: each
 *      RESERVED line → NEEDED with its RELEASED event, the parts.core RELEASE decision); proven AS the runtime role by
 *      .sdquote/battery.ts X2 ("cancel with RESERVED parts → released in the same transaction"). The lock stays false
 *      until a reviewed PR opens it (condition 1 and the owner's decision).
 */
export const PARTS_API_OPEN = false;

export function assertPartsApiOpen(): void {
  if (!PARTS_API_OPEN) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { capability: "parts", until: "intake_confirmation_1_3b" });
}

/** The actions this PR carries. Every other part action is refused, with the reason the gap report reads. */
export const IN_SCOPE_PART_ACTIONS = ["RESERVE", "RELEASE", "SET_PRICE", "CANCEL"] as const satisfies readonly PartActionType[];
export const OUT_OF_SCOPE_PART_ACTIONS: Readonly<Record<Exclude<PartActionType, (typeof IN_SCOPE_PART_ACTIONS)[number]>, string>> = {
  ISSUE: "a stock movement — after M0 (inventory session)",
  RETURN: "a stock movement — after M0 (inventory session)",
  SEND_WITH_EXTERNAL: "a part leaving with the supplier — with the stock movement, after M0",
  RESOLVE_FROM_EXTERNAL: "a part back from the supplier — may move stock, after M0",
  MARK_ON_ORDER: "purchase orders — owner decision: not in 1d-B",
  UPDATE_ORDER: "purchase orders — owner decision: not in 1d-B",
  INSTALL: "needs an issued line (issue is after M0)",
  WRITE_OFF: "needs an issued line (issue is after M0)",
  CORRECT_COST: "needs the cost captured at issue (after M0)",
  RECORD_QUOTED: "quotes — 1.3c",
};

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PartView = {
  id: number; caseId: number; source: string; state: string; inventoryItemId: number | null; name: string; sku: string | null;
  unitType: string | null; quantity: number; customerUnitPriceAgorot: number | null; version: number; lastEventKind: string;
  reason: string | null; createdAt: string; closedAt: string | null;
};
export type PartEventView = {
  seq: number; kind: string; stateBefore: string | null; stateAfter: string; quantity: number; amountAgorot: number | null;
  previousAmountAgorot: number | null; actor: string; actorUserId: number | null; occurredAt: string; payload: unknown;
};

const ISO = (col: string) => Prisma.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const PART_COLUMNS = Prisma.sql`id, "caseId", source::text AS source, state::text AS state, "inventoryItemId", "nameSnapshot", "skuSnapshot",
  "unitType"::text AS "unitType", quantity, "customerUnitPriceAgorot", version, "lastEventKind"::text AS "lastEventKind", reason,
  ${ISO('"createdAt"')} AS "createdAt", ${ISO('"closedAt"')} AS "closedAt"`;
const toPart = (r: Record<string, unknown>): PartView => ({
  id: Number(r.id), caseId: Number(r.caseId), source: String(r.source), state: String(r.state), inventoryItemId: num(r.inventoryItemId),
  name: String(r.nameSnapshot), sku: (r.skuSnapshot as string) ?? null, unitType: (r.unitType as string) ?? null, quantity: Number(r.quantity),
  customerUnitPriceAgorot: num(r.customerUnitPriceAgorot), version: Number(r.version), lastEventKind: String(r.lastEventKind),
  reason: (r.reason as string) ?? null, createdAt: String(r.createdAt), closedAt: (r.closedAt as string) ?? null,
});

async function partOf(tx: Tx, b: number, partId: number): Promise<PartView> {
  const r = (await tx.$queryRaw<Record<string, unknown>[]>`SELECT ${PART_COLUMNS} FROM "ServicePart" WHERE id = ${partId}::int AND "businessId" = ${b}::int`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return toPart(r);
}

/** The case's part lines, oldest first, each with its journal. FULL and READ_ONLY. */
export async function listParts(businessId: number, caseId: unknown): Promise<{ parts: (PartView & { events: PartEventView[] })[] }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const exists = await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int) AS ok`;
    if (exists[0]?.ok !== true) throw new ServiceDeskError("NOT_FOUND");
    const parts = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT ${PART_COLUMNS} FROM "ServicePart" WHERE "caseId" = ${caseId}::int AND "businessId" = ${businessId}::int ORDER BY id`).map(toPart);
    const events = parts.length === 0 ? [] : await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT "partId", seq, kind::text AS kind, "stateBefore"::text AS "stateBefore", "stateAfter"::text AS "stateAfter", quantity, "amountAgorot",
             "previousAmountAgorot", actor::text AS actor, "actorUserId", ${ISO('"occurredAt"')} AS "occurredAt", payload
        FROM "ServicePartEvent" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int ORDER BY "partId", seq`;
    return {
      parts: parts.map((p) => ({
        ...p,
        events: events.filter((e) => Number(e.partId) === p.id).map((e) => ({
          seq: Number(e.seq), kind: String(e.kind), stateBefore: (e.stateBefore as string) ?? null, stateAfter: String(e.stateAfter),
          quantity: Number(e.quantity), amountAgorot: num(e.amountAgorot), previousAmountAgorot: num(e.previousAmountAgorot),
          actor: String(e.actor), actorUserId: num(e.actorUserId), occurredAt: String(e.occurredAt), payload: e.payload,
        })),
      })),
    };
  });
}

// ── Facts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The case under its row lock (the part triggers take the same lock — FOR UPDATE, never FOR SHARE). */
async function lockCaseFacts(tx: Tx, b: number, caseId: number): Promise<PartCaseFacts> {
  const c = (await tx.$queryRaw<{ status: string; outcome: string | null; cr: boolean; cov: string | null }[]>`
    SELECT status::text AS status, outcome::text AS outcome, "cancellationRequested" AS cr, "coverageDecision"::text AS cov
      FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
  if (!c) throw new ServiceDeskError("NOT_FOUND");
  const q = (await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "ServiceQuote" WHERE "caseId" = ${caseId}::int AND "businessId" = ${b}::int AND state = 'APPROVED') AS ok`)[0];
  return { status: c.status as ServiceCaseStatus, outcome: (c.outcome as ServiceOutcome) ?? null, cancellationRequested: c.cr === true, quoteApprovedOrCovered: c.cov === "APPROVED" || q?.ok === true };
}

/**
 * The item and the other SOFT reservations, read after this module's advisory lock on the item (reservations of the
 * same item are serialised; the inventory rows themselves are only read). `excludePartId` = the line being decided.
 */
async function stockFacts(tx: Tx, b: number, itemId: number, excludePartId: number | null, lock: boolean): Promise<StockFacts | null> {
  if (lock) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${0x53445256}::int, ${itemId}::int)`; // 'SDRV'
  const i = (await tx.$queryRaw<{ active: boolean; unit: string; qty: number }[]>`
    SELECT "isActive" AS active, "unitType"::text AS unit, "currentQuantity" AS qty FROM "InventoryItem" WHERE id = ${itemId}::int AND "businessId" = ${b}::int`)[0];
  if (!i) return null;
  const reserved = Number((await tx.$queryRaw<{ n: number }[]>`
    SELECT COALESCE(sum(quantity), 0)::float8 AS n FROM "ServicePart"
     WHERE "businessId" = ${b}::int AND "inventoryItemId" = ${itemId}::int AND state = 'RESERVED'
       ${excludePartId === null ? Prisma.empty : Prisma.sql`AND id <> ${excludePartId}::int`}`)[0]?.n ?? 0);
  return { itemActive: i.active === true, itemUnitType: i.unit as PartUnitType, onHandQuantity: Number(i.qty), reservedByOtherParts: reserved };
}

/** The checks the core lists, each established above (item of this business under the lock) or refused. */
function verifyPartChecks(checks: readonly PartServerCheck[], f: { itemFound: boolean; locked: boolean }) {
  for (const check of checks) {
    switch (check) {
      case "ITEM_BELONGS_TO_BUSINESS":
      case "ITEM_ACTIVE": // the core already refused an inactive item; the row was read in this transaction
        if (!f.itemFound) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      case "STOCK_READ_UNDER_ITEM_LOCK":
      case "RESERVATIONS_SUMMED_UNDER_ITEM_LOCK":
        if (!f.itemFound || !f.locked) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
        break;
      default:
        // movements, purchase orders, supplier work, quotes — not part of this PR: refused, never assumed.
        throw new ServiceDeskError("SERVER_CHECK_FAILED", { check });
    }
  }
}

function violationsError(violations: readonly { code: string }[]): ServiceDeskError {
  const codes = [...new Set(violations.map((x) => x.code))];
  if (codes.length === 1 && codes[0] === "VERSION_CONFLICT") return new ServiceDeskError("VERSION_CONFLICT");
  return new ServiceDeskError("REFUSED", { violations: codes });
}

/** The part journal is the ledger: same key + same request → the stored answer; same key + other request → refused. */
async function findPriorPartEvent(tx: Tx, b: number, prepared: Prepared): Promise<{ partId: number } | null> {
  const o = (await tx.$queryRaw<{ partId: number; d: string | null; k: string | null }[]>`
    SELECT "partId", "requestDigest" AS d, "digestKeyId" AS k FROM "ServicePartEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}::text`)[0];
  if (!o) return null;
  if (!o.d || !o.k) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  const expected = digestWithKeyId(prepared.keys, o.k, prepared.ident);
  if (!expected || !sameDigest(expected, o.d)) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
  return { partId: Number(o.partId) };
}

async function appendPartEvent(tx: Tx, b: number, partId: number, caseId: number, d: Extract<PartDecision, { ok: true }>, userId: number, prepared: Prepared) {
  await tx.$executeRaw`
    INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "amountAgorot", "previousAmountAgorot",
      reason, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES (${b}::int, ${partId}::int, ${caseId}::int, ${d.event.seq}::int, ${d.event.kind}::"ServicePartEventKind", ${d.event.stateBefore}::"ServicePartState",
      ${d.event.stateAfter}::"ServicePartState", ${d.event.quantity}::float8, ${d.event.amountAgorot}::int, ${d.event.previousAmountAgorot}::int,
      ${d.event.kind === "CANCELLED" ? d.texts.reason : null}::text, 'OWNER_USER'::"ServiceActor", ${userId}::int,
      ${JSON.stringify(d.event.payload)}::jsonb, ${prepared.key}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
}

/** One attempt per transaction; a lost unique race is answered once more (from the winner), as in the case service. */
async function command<T>(b: number, run: (tx: Tx) => Promise<T>): Promise<T> {
  const attempt = () => tenantTx(b, run, { timeoutMs: 15_000 });
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

// ── Add ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type PartCommandResult = { part: PartView; replayed: boolean; warnings: string[] };

export async function addCasePart(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { source?: unknown; inventoryItemId?: unknown; name?: unknown; sku?: unknown; quantity?: unknown; unitType?: unknown; customerUnitPriceAgorot?: unknown },
  req: WriteRequest,
): Promise<PartCommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (body.source !== "STOCK" && body.source !== "NON_STOCK") throw new ServiceDeskError("INVALID_INPUT", { field: "source" });
  if (typeof body.name !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "name" });
  if (body.sku !== undefined && body.sku !== null && typeof body.sku !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "sku" });
  if (typeof body.quantity !== "number") throw new ServiceDeskError("INVALID_INPUT", { field: "quantity" });
  if (body.unitType !== undefined && body.unitType !== null && !PART_UNIT_TYPES.includes(body.unitType as PartUnitType)) throw new ServiceDeskError("INVALID_INPUT", { field: "unitType" });
  if (body.customerUnitPriceAgorot !== undefined && body.customerUnitPriceAgorot !== null && !isNonNegativeInt(body.customerUnitPriceAgorot)) throw new ServiceDeskError("INVALID_INPUT", { field: "customerUnitPriceAgorot" });
  if (body.source === "STOCK" && !isPositiveInt(body.inventoryItemId)) throw new ServiceDeskError("INVALID_INPUT", { field: "inventoryItemId" });
  const input = {
    source: body.source as "STOCK" | "NON_STOCK", inventoryItemId: (body.inventoryItemId ?? null) as number | null, name: body.name, sku: (body.sku ?? null) as string | null,
    quantity: body.quantity, unitType: (body.unitType ?? null) as PartUnitType | null, customerUnitPriceAgorot: (body.customerUnitPriceAgorot ?? null) as number | null,
  };
  const prepared = prepare(p, req, "service-desk/parts:add", { caseId, ...input });
  const b = p.businessId;
  return command(b, async (tx) => {
    const facts = await lockCaseFacts(tx, b, caseId);
    const prior = await findPriorPartEvent(tx, b, prepared);
    if (prior) {
      const part = await partOf(tx, b, prior.partId);
      if (part.caseId !== caseId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { part, replayed: true, warnings: [] };
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const stock = input.source === "STOCK" ? await stockFacts(tx, b, input.inventoryItemId as number, null, false) : null;
    if (input.source === "STOCK" && !stock) throw new ServiceDeskError("SERVER_CHECK_FAILED", { check: "ITEM_BELONGS_TO_BUSINESS" });
    const d = addPart(input, { case: facts, ...(stock ? { stock } : {}) }, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw violationsError(d.violations);
    if (d.inventory !== null) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { movement: "not in 1d-B" }); // never: adding moves nothing
    verifyPartChecks(d.serverChecks, { itemFound: stock !== null, locked: false });
    const s: ServicePartSnapshot = d.part;
    const partId = Number((await tx.$queryRaw<{ id: number }[]>`
      INSERT INTO "ServicePart" ("businessId", "caseId", source, "inventoryItemId", "nameSnapshot", "skuSnapshot", "unitType", quantity, "customerUnitPriceAgorot",
        "createdByUserId", "updatedAt")
      VALUES (${b}::int, ${caseId}::int, ${s.source}::"ServicePartSource", ${s.inventoryItemId}::int, ${d.texts.name}::text, ${d.texts.sku}::text,
        ${s.unitType}::"InventoryUnitType", ${s.quantity}::float8, ${s.customerUnitPriceAgorot}::int, ${p.userId}::int, now())
      RETURNING id`)[0].id);
    await appendPartEvent(tx, b, partId, caseId, d, p.userId, prepared);
    return { part: await partOf(tx, b, partId), replayed: false, warnings: [...d.warnings] };
  });
}

// ── Actions on a line ─────────────────────────────────────────────────────────────────────────────────────────

function partActionFrom(raw: Record<string, unknown>): PartAction {
  const type = raw.type;
  if (typeof type === "string" && type in OUT_OF_SCOPE_PART_ACTIONS) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { action: type });
  switch (type) {
    case "RESERVE":
    case "RELEASE":
      return { type };
    case "SET_PRICE":
      if (raw.customerUnitPriceAgorot !== null && !isNonNegativeInt(raw.customerUnitPriceAgorot)) throw new ServiceDeskError("INVALID_INPUT", { field: "action.customerUnitPriceAgorot" });
      return { type, customerUnitPriceAgorot: raw.customerUnitPriceAgorot as number | null };
    case "CANCEL":
      if (raw.reason !== undefined && raw.reason !== null && typeof raw.reason !== "string") throw new ServiceDeskError("INVALID_INPUT", { field: "action.reason" });
      return raw.reason === undefined || raw.reason === null ? { type } : { type, reason: raw.reason as string };
    default:
      throw new ServiceDeskError("INVALID_INPUT", { field: "action.type" });
  }
}

async function lockPart(tx: Tx, b: number, partId: number): Promise<{ caseId: number; snapshot: ServicePartSnapshot }> {
  const r = (await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT "caseId", state::text AS state, source::text AS source, "inventoryItemId", quantity, "unitType"::text AS "unitType", version,
           "issueMovementId", "returnMovementId", "unitCostAgorot", "costSource"::text AS "costSource", "customerUnitPriceAgorot", "quotedInVersion",
           "costIncludedInExternal", "externalWorkId", "purchaseOrderId", "purchaseOrderLineId", to_char("expectedOn", 'YYYY-MM-DD') AS "expectedOn",
           "writeOffReason"::text AS "writeOffReason", "splitFromPartId"
      FROM "ServicePart" WHERE id = ${partId}::int AND "businessId" = ${b}::int FOR UPDATE`)[0];
  if (!r) throw new ServiceDeskError("NOT_FOUND");
  return {
    caseId: Number(r.caseId),
    snapshot: {
      state: r.state as ServicePartSnapshot["state"], source: r.source as ServicePartSnapshot["source"], inventoryItemId: num(r.inventoryItemId),
      quantity: Number(r.quantity), unitType: (r.unitType as PartUnitType) ?? null, version: Number(r.version),
      issueMovementLinked: r.issueMovementId !== null, returnMovementLinked: r.returnMovementId !== null,
      unitCostAgorot: num(r.unitCostAgorot), costSource: (r.costSource as ServicePartSnapshot["costSource"]) ?? null,
      customerUnitPriceAgorot: num(r.customerUnitPriceAgorot), quotedInVersion: num(r.quotedInVersion), costIncludedInExternal: r.costIncludedInExternal === true,
      externalWorkId: num(r.externalWorkId), purchaseOrderId: num(r.purchaseOrderId), purchaseOrderLineId: num(r.purchaseOrderLineId),
      expectedOn: (r.expectedOn as string) ?? null, writeOffReason: (r.writeOffReason as ServicePartSnapshot["writeOffReason"]) ?? null,
      splitFromParent: r.splitFromPartId !== null,
    },
  };
}

export async function runPartAction(
  p: ServiceDeskPrincipal,
  partId: unknown,
  body: { action?: unknown; expectedVersion?: unknown },
  req: WriteRequest,
): Promise<PartCommandResult> {
  if (!isPositiveInt(partId)) throw new ServiceDeskError("NOT_FOUND");
  if (!body.action || typeof body.action !== "object" || Array.isArray(body.action)) throw new ServiceDeskError("INVALID_INPUT", { field: "action" });
  if (!isPositiveInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const action = partActionFrom(body.action as Record<string, unknown>);
  const prepared = prepare(p, req, "service-desk/parts:action", { partId, action, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return command(b, async (tx) => {
    // Lock order = the part triggers' order: the case first, then the line.
    const owner = (await tx.$queryRaw<{ caseId: number }[]>`SELECT "caseId" FROM "ServicePart" WHERE id = ${partId}::int AND "businessId" = ${b}::int`)[0];
    if (!owner) throw new ServiceDeskError("NOT_FOUND");
    const facts = await lockCaseFacts(tx, b, Number(owner.caseId));
    const locked = await lockPart(tx, b, partId);
    const prior = await findPriorPartEvent(tx, b, prepared);
    if (prior) {
      if (prior.partId !== partId) throw new ServiceDeskError("IDEMPOTENCY_KEY_REUSED");
      return { part: await partOf(tx, b, partId), replayed: true, warnings: [] };
    }
    const verdict = checkIdempotencyKey(prepared.key, prepared.now);
    if (!verdict.ok) throw new ServiceDeskError(verdict.code);
    const env = checkPartEnvelope(locked.snapshot, { partId, expectedVersion: body.expectedVersion as number, idempotencyKey: prepared.key });
    if (!env.ok) throw violationsError(env.violations);
    const reserving = action.type === "RESERVE" && locked.snapshot.source === "STOCK" && locked.snapshot.inventoryItemId !== null;
    const stock = reserving ? await stockFacts(tx, b, locked.snapshot.inventoryItemId as number, partId, true) : null;
    const d = evaluatePartAction(locked.snapshot, action, { case: facts, ...(stock ? { stock } : {}) }, { kind: "OWNER", userId: p.userId });
    if (!d.ok) throw violationsError(d.violations);
    if (d.inventory !== null || d.split !== null) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { movement: "not in 1d-B" }); // never for these four
    verifyPartChecks(d.serverChecks, { itemFound: stock !== null, locked: reserving });
    const n = d.part;
    const u = await tx.$executeRaw`
      UPDATE "ServicePart" SET state = ${n.state}::"ServicePartState", "customerUnitPriceAgorot" = ${n.customerUnitPriceAgorot}::int,
             reason = CASE WHEN ${d.event.kind === "CANCELLED"}::boolean THEN ${d.texts.reason}::text ELSE reason END,
             "closedAt" = CASE WHEN ${n.state === "CANCELLED"}::boolean THEN now() ELSE "closedAt" END,
             version = ${n.version}::int, "lastEventKind" = ${d.event.kind}::"ServicePartEventKind", "updatedAt" = now()
       WHERE id = ${partId}::int AND "businessId" = ${b}::int AND version = ${locked.snapshot.version}::int`;
    if (u !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    await appendPartEvent(tx, b, partId, locked.caseId, d, p.userId, prepared);
    return { part: await partOf(tx, b, partId), replayed: false, warnings: [...d.warnings] };
  });
}
