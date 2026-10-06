/**
 * M7-A · the Call destination (R9_CALL), run by the core.
 *
 * ONE tenant transaction, all-or-nothing and retry-safe:
 *
 *   1. idempotency  this receipt is already the first/last event of a CallActivity → return it
 *   2. lock         the call key (parallel deliveries about one call serialise)
 *   3. identity     READ ONLY (M4): who is on the other end, if Dubiz already knows them
 *   4. the caller   hidden id            → callerState hidden: no hash, no Customer
 *                   resolved             → known: that Customer (+ that Customer's open lead, as an
 *                                          evidence pointer — the lead is NOT touched)
 *                   unresolved           → unknown: a per-business hash of the number groups repeat
 *                                          calls; NO Customer is created (D8 — caller id is not proof)
 *                   conflict             → unknown + an owner proposal that would attach THIS call
 *                                          only (it proposes no identifier link); nothing merged
 *   5. the call     create, or apply a correction only if the provider says it is newer
 *   6. callback     an OUTBOUND call closes the same caller's earlier unreturned inbound calls
 *   7. evidence     identity state / rule / result refs on the normalized record, same transaction
 *
 * NEVER: a Lead, a lifecycle step, a Customer, an IdentityLink, a stage move, a recording.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { OPEN_LEAD_STATUSES } from "@/lib/services/crm/lead-core";
import { recordSensor } from "@/lib/sensors/record-sensor";
import {
  IntakeTerminalError,
  type ClaimedIntakeEvent,
  type IntakeRouteContext,
  type NormalizedIntake,
  type RouteResult,
} from "@/lib/intake/core/contract";
import { identifiersFromHints } from "@/lib/intake/identity/identifiers";
import { resolveIdentity } from "@/lib/intake/identity/resolve";
import { openProposals } from "@/lib/intake/identity/proposals";
import { callerHash, durationBucket, isCall, isTelephonySourceKey, UNRETURNED_OUTCOMES } from "@/lib/intake/calls/canonical";
import type { RoutingDecision } from "./rules";

/** Advisory-lock namespace for one call key ('CA'). */
export const CALL_LOCK_NAMESPACE = 0x43_41;

function callLockKey(businessId: number, sourceKey: string, callId: string): number {
  return createHash("sha256").update(`${businessId}:${sourceKey}:${callId}`).digest().readInt32BE(0);
}

/** Coarse, non-identifying latency category for a returned call. */
export function latencyBucket(ms: number): "<15m" | "15m-1h" | "1-4h" | "4-24h" | "1d+" {
  const m = ms / 60_000;
  if (m < 15) return "<15m";
  if (m < 60) return "15m-1h";
  if (m < 240) return "1-4h";
  if (m < 1440) return "4-24h";
  return "1d+";
}

async function connectionIdFor(tx: TenantTx, sourceKey: string, accountRef: string | null): Promise<number | null> {
  if (!accountRef) return null;
  const row = await tx.acquisitionConnection.findFirst({
    where: { sourceKey, publicId: accountRef, status: { not: "REVOKED" } },
    select: { id: true },
    orderBy: { id: "desc" },
  });
  return row?.id ?? null;
}

async function openLeadOf(tx: TenantTx, businessId: number, customerId: number): Promise<number | null> {
  const lead = await tx.lead.findFirst({
    where: { businessId, customerId, status: { in: [...OPEN_LEAD_STATUSES] } },
    select: { id: true },
    orderBy: { id: "desc" },
  });
  return lead?.id ?? null;
}

export async function routeToCall(
  ctx: IntakeRouteContext & { decision: RoutingDecision },
  normalized: NormalizedIntake,
  event: ClaimedIntakeEvent
): Promise<RouteResult> {
  const { businessId } = ctx;
  const call = event.payload;
  if (!isCall(call)) throw new IntakeTerminalError("malformed_payload");
  if (!isTelephonySourceKey(event.sourceKey)) throw new IntakeTerminalError("not_a_telephony_source");
  const sourceKey = event.sourceKey;
  const identifiers = identifiersFromHints(normalized.contactHints, { sourceKey, accountRef: event.providerAccountRef });
  const phone = identifiers.find((i) => i.kind === "phone")?.value ?? null;
  const startedAt = new Date(call.startedAt);
  const providerUpdatedAt = new Date(call.providerUpdatedAt);

  const out = await withTenantTransaction(async (tx) => {
    // 1. idempotency anchor
    const prior = await tx.callActivity.findFirst({
      where: { businessId, OR: [{ firstIntakeEventId: event.id }, { lastIntakeEventId: event.id }] },
      select: { id: true, customerId: true },
    });
    if (prior) {
      return { kind: "routed" as const, refs: { callId: prior.id, ...(prior.customerId ? { customerId: prior.customerId } : {}) }, alreadyExisted: true };
    }
    const connectionId = await connectionIdFor(tx, sourceKey, event.providerAccountRef);
    if (connectionId === null) return { kind: "ignored" as const, code: "connection_revoked" };

    // 2. lock the call key
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CALL_LOCK_NAMESPACE}::int, ${callLockKey(businessId, sourceKey, call.providerCallId)}::int)`;

    // 3. identity — read only; a call never writes identity
    const identity = await resolveIdentity(tx, businessId, identifiers);

    // 4. the caller
    let callerState: "known" | "unknown" | "hidden" = "hidden";
    let customerId: number | null = null;
    let hash: string | null = null;
    let leadId: number | null = null;
    if (!phone) {
      callerState = "hidden";
    } else if (identity.state === "resolved" && identity.customerId !== null) {
      callerState = "known";
      customerId = identity.customerId;
      leadId = await openLeadOf(tx, businessId, customerId);
    } else {
      callerState = "unknown";
      hash = callerHash(businessId, phone);
    }

    // 5. the call
    const existing = await tx.callActivity.findFirst({
      where: { businessId, sourceKey, providerCallId: call.providerCallId },
      select: { id: true, providerUpdatedAt: true, customerId: true },
    });
    let callId: number;
    let createdCall = false;
    if (!existing) {
      const row = await tx.callActivity.create({
        data: {
          businessId,
          connectionId,
          sourceKey,
          providerCallId: call.providerCallId,
          direction: call.direction,
          outcome: call.outcome,
          durationSec: call.durationSec,
          startedAt,
          endedAt: call.endedAt ? new Date(call.endedAt) : null,
          businessLine: call.businessLine ?? null,
          callerState,
          callerHash: hash,
          customerId,
          leadId,
          firstIntakeEventId: event.id,
          lastIntakeEventId: event.id,
          providerUpdatedAt,
        },
        select: { id: true },
      });
      callId = row.id;
      createdCall = true;
    } else {
      callId = existing.id;
      if (providerUpdatedAt.getTime() > existing.providerUpdatedAt.getTime()) {
        await tx.callActivity.updateMany({
          where: { id: callId, businessId },
          data: {
            outcome: call.outcome,
            durationSec: call.durationSec,
            endedAt: call.endedAt ? new Date(call.endedAt) : null,
            providerUpdatedAt,
            lastIntakeEventId: event.id,
            ...(existing.customerId === null && customerId !== null ? { customerId, leadId, callerState, callerHash: null } : {}),
          },
        });
      } else {
        await tx.callActivity.updateMany({ where: { id: callId, businessId }, data: { lastIntakeEventId: event.id } });
      }
    }

    // Conflict: ask the owner whether THIS call belongs to a candidate (no identifier link is proposed).
    let proposalIds: number[] = [];
    if (identity.state === "conflict" || identity.state === "candidate" || identity.state === "ambiguous") {
      proposalIds = await openProposals(tx, { businessId, intakeEventId: event.id, leadId: null, identity, links: [] });
    }

    // 6. callback: an outbound call returns this caller's earlier unreturned inbound calls
    const returned: Array<{ id: number; startedAt: Date }> = [];
    if (createdCall && call.direction === "outbound" && (customerId !== null || hash !== null)) {
      const waiting = await tx.callActivity.findMany({
        where: {
          businessId,
          direction: "inbound",
          outcome: { in: [...UNRETURNED_OUTCOMES] },
          returnedAt: null,
          startedAt: { lt: startedAt },
          ...(customerId !== null ? { customerId } : { callerHash: hash }),
        },
        select: { id: true, startedAt: true },
        take: 50,
      });
      for (const w of waiting) {
        const r = await tx.callActivity.updateMany({
          where: { id: w.id, businessId, returnedAt: null },
          data: { returnedAt: startedAt, returnedVia: "outbound_call" },
        });
        if (r.count === 1) returned.push(w);
      }
    }

    // 7. evidence on the normalized record, same transaction
    const refs: { callId: number; customerId?: number } = { callId, ...(customerId ? { customerId } : {}) };
    await tx.intakeNormalizedEvent.updateMany({
      where: { businessId, intakeEventId: event.id },
      data: {
        identityState: identity.state,
        identityPolicyVersion: identity.policyVersion,
        identityCustomerId: identity.state === "resolved" ? customerId : null,
        identityEvidence: { ...identity.evidence, callerState, proposals: proposalIds.length } as Prisma.InputJsonValue,
        identityCandidateCount: identity.candidates.length,
        routingRule: ctx.decision.rule,
        routingDestination: ctx.decision.destination,
        ownerReviewRequired: proposalIds.length > 0,
        resultRefs: refs as Prisma.InputJsonValue,
      },
    });

    // Learning signals: categories only (never a number, a hash, a name or content).
    if (createdCall) {
      await recordSensor(
        {
          businessId,
          sensor: "CALL_RECORDED",
          entityId: callId,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          occurredAt: startedAt,
          idempotencyKey: `call:${callId}:recorded`,
          payload: {
            sourceKey,
            direction: call.direction,
            outcome: call.outcome,
            durationBucket: durationBucket(call.durationSec),
            callerState,
            identityState: identity.state,
            onOpenLead: leadId !== null,
          },
        },
        { tx }
      );
    }
    for (const w of returned) {
      await recordSensor(
        {
          businessId,
          sensor: "MISSED_CALL_RETURNED",
          entityId: w.id,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          occurredAt: startedAt,
          idempotencyKey: `call:${w.id}:returned`,
          payload: { via: "outbound_call", latencyBucket: latencyBucket(startedAt.getTime() - w.startedAt.getTime()), callerState },
        },
        { tx }
      );
    }
    return { kind: "routed" as const, refs, alreadyExisted: !createdCall };
  });

  if (out.kind === "ignored") return { kind: "ignored", code: out.code };
  return { kind: "routed", refs: out.refs, alreadyExisted: out.alreadyExisted };
}
