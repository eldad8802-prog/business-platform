/**
 * Service Desk 1.3c — the CANCEL effect RELEASE_PART_RESERVATIONS: every still-RESERVED part line of the case is released
 * (RESERVED → NEEDED) INSIDE the cancel's transaction, each with its own RELEASED event — the same decision (parts.core
 * evaluatePartAction RELEASE), the same row update and the same journal row as a RELEASE through the parts service.
 * SERVER-ONLY. It does not open the parts API (PARTS_API_OPEN stays false) and never moves stock (a reservation is soft).
 *
 * Kept apart from parts.service (which only the two closed parts routes import — parts-lock.test P4). The case row is
 * already locked FOR UPDATE by the caller, which is the parts triggers' lock order (case first, then the line).
 *
 * Each part event needs its own idempotency key (UNIQUE per business): deriveIdempotencyKey(the cancel's key, "rel" + the part id), with the
 * cancel's request digest. A replay of the cancel is answered from the case journal before this runs, so it never repeats.
 */
import type { ServiceCaseContext } from "./contracts";
import type { PartUnitType, ServicePartSnapshot } from "./parts.contracts";
import { evaluatePartAction } from "./parts.core";
import { deriveIdempotencyKey } from "./idempotency-key";
import { ServiceDeskError } from "./service-desk-errors";
import type { Prepared, Tx } from "./service-case.service";

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** The part event key of a release done by the case command `caseKey` (deriveIdempotencyKey: ≤ 200, the ServicePartEvent_tokens alphabet). */
export const releaseEventKey = (caseKey: string, partId: number) => deriveIdempotencyKey(caseKey, `rel${partId}`);

export async function releaseCaseReservations(tx: Tx, b: number, caseId: number, context: ServiceCaseContext, userId: number, prepared: Prepared): Promise<number[]> {
  const approved = (await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "ServiceQuote" WHERE "caseId" = ${caseId}::int AND "businessId" = ${b}::int AND state = 'APPROVED') AS ok`)[0]?.ok === true;
  // The case as it stands BEFORE the cancel is written (the release is decided first, then the case moves).
  const facts = { status: context.status, outcome: context.outcome, cancellationRequested: context.cancellationRequested, quoteApprovedOrCovered: approved || context.coverage?.decision === "APPROVED" };
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT id, state::text AS state, source::text AS source, "inventoryItemId", quantity, "unitType"::text AS "unitType", version,
           "issueMovementId", "returnMovementId", "unitCostAgorot", "costSource"::text AS "costSource", "customerUnitPriceAgorot", "quotedInVersion",
           "costIncludedInExternal", "externalWorkId", "purchaseOrderId", "purchaseOrderLineId", to_char("expectedOn", 'YYYY-MM-DD') AS "expectedOn",
           "writeOffReason"::text AS "writeOffReason", "splitFromPartId"
      FROM "ServicePart" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND state = 'RESERVED' ORDER BY id FOR UPDATE`;
  const released: number[] = [];
  for (const r of rows) {
    const partId = Number(r.id);
    const snapshot: ServicePartSnapshot = {
      state: r.state as ServicePartSnapshot["state"], source: r.source as ServicePartSnapshot["source"], inventoryItemId: num(r.inventoryItemId),
      quantity: Number(r.quantity), unitType: (r.unitType as PartUnitType) ?? null, version: Number(r.version),
      issueMovementLinked: r.issueMovementId !== null, returnMovementLinked: r.returnMovementId !== null,
      unitCostAgorot: num(r.unitCostAgorot), costSource: (r.costSource as ServicePartSnapshot["costSource"]) ?? null,
      customerUnitPriceAgorot: num(r.customerUnitPriceAgorot), quotedInVersion: num(r.quotedInVersion), costIncludedInExternal: r.costIncludedInExternal === true,
      externalWorkId: num(r.externalWorkId), purchaseOrderId: num(r.purchaseOrderId), purchaseOrderLineId: num(r.purchaseOrderLineId),
      expectedOn: (r.expectedOn as string) ?? null, writeOffReason: (r.writeOffReason as ServicePartSnapshot["writeOffReason"]) ?? null,
      splitFromParent: r.splitFromPartId !== null,
    };
    const d = evaluatePartAction(snapshot, { type: "RELEASE" }, { case: facts }, { kind: "OWNER", userId });
    if (!d.ok) throw new ServiceDeskError("REFUSED", { violations: [...new Set(d.violations.map((x) => x.code))], effect: "RELEASE_PART_RESERVATIONS" });
    if (d.inventory !== null || d.split !== null) throw new ServiceDeskError("ACTION_NOT_IN_SCOPE", { movement: "never on a release" });
    const n = d.part;
    const u = await tx.$executeRaw`
      UPDATE "ServicePart" SET state = ${n.state}::"ServicePartState", version = ${n.version}::int, "lastEventKind" = ${d.event.kind}::"ServicePartEventKind", "updatedAt" = now()
       WHERE id = ${partId}::int AND "businessId" = ${b}::int AND version = ${snapshot.version}::int AND state = 'RESERVED'`;
    if (u !== 1) throw new ServiceDeskError("VERSION_CONFLICT");
    const payload = { ...d.event.payload, byCaseCancel: true };
    await tx.$executeRaw`
      INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "amountAgorot", "previousAmountAgorot",
        reason, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES (${b}::int, ${partId}::int, ${caseId}::int, ${d.event.seq}::int, ${d.event.kind}::"ServicePartEventKind", ${d.event.stateBefore}::"ServicePartState",
        ${d.event.stateAfter}::"ServicePartState", ${d.event.quantity}::float8, ${d.event.amountAgorot}::int, ${d.event.previousAmountAgorot}::int,
        ${null}::text, 'OWNER_USER'::"ServiceActor", ${userId}::int, ${JSON.stringify(payload)}::jsonb,
        ${releaseEventKey(prepared.key, partId)}::text, ${prepared.digest.value}::text, ${prepared.digest.keyId}::text)`;
    released.push(partId);
  }
  return released;
}
