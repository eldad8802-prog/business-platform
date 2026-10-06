/**
 * M7-A · the Commerce destination (R5_COMMERCE), run by the core.
 *
 * ONE tenant transaction, so every effect is all-or-nothing and retry-safe:
 *
 *   1. idempotency  this receipt already has its CommerceOrderEvent → return it (a replay or a
 *                   retry after commit can never write twice)
 *   2. locks        the order key (parallel deliveries about one order serialise), then every
 *                   identifier of the buyer (phone shares M2's WhatsApp sender lock)
 *   3. identity     resolved under the locks (M4) — who bought it
 *   4. contact      only when the order has none yet:
 *                     resolved          → that Customer (+ deterministic links nobody else holds)
 *                     unresolved+phone  → a NEW Customer, as the lead destination does (D8)
 *                     unresolved, no phone (email only / nothing) → no Customer is invented
 *                     candidate / ambiguous / conflict → no contact + owner proposals; nothing merged
 *                   An order's Customer is never replaced by a later delivery.
 *   5. order        create, or apply the change ONLY if the provider says it is newer
 *                   (sequence, else modification time). An older delivery (out of order) is
 *                   recorded in the history as not applied — status never moves backwards.
 *   6. lines        a newer snapshot that carries lines upserts them; a line it no longer
 *                   carries is marked not present (never deleted)
 *   7. history      one append-only CommerceOrderEvent per receipt (the idempotency anchor)
 *   8. evidence     identity state / rule / result refs on the normalized record, same transaction
 *
 * NEVER: a Lead, a lifecycle step, a Deal, an IdentityLink from an uncertain buyer, booked money
 * (FinancialEvent / BillingDocument / payment), a stock movement (D7).
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { customerService } from "@/lib/services/crm/customer.service";
import { recordSensor } from "@/lib/sensors/record-sensor";
import {
  IntakeTerminalError,
  type ClaimedIntakeEvent,
  type IntakeRouteContext,
  type NormalizedIntake,
  type RouteResult,
} from "@/lib/intake/core/contract";
import { identifiersFromHints } from "@/lib/intake/identity/identifiers";
import { lockIdentifiers } from "@/lib/intake/identity/locks";
import { resolveIdentity } from "@/lib/intake/identity/resolve";
import { ensureLinks, unheldIdentifiers } from "@/lib/intake/identity/links";
import { openProposals } from "@/lib/intake/identity/proposals";
import { isCommerceOrder, isCommerceSourceKey, type CommerceOrderV1, type OrderStatus } from "@/lib/intake/commerce/canonical";
import type { RoutingDecision } from "./rules";

/** Advisory-lock namespace for one order key ('CO'). */
export const COMMERCE_ORDER_LOCK_NAMESPACE = 0x43_4f;

function orderLockKey(businessId: number, sourceKey: string, orderId: string): number {
  return createHash("sha256").update(`${businessId}:${sourceKey}:${orderId}`).digest().readInt32BE(0);
}

/** Coarse, non-identifying total category in MAJOR units (learning signals). */
export function totalBucket(minor: number): "0" | "<100" | "100-499" | "500-1999" | "2000+" {
  const major = minor / 100;
  if (major <= 0) return "0";
  if (major < 100) return "<100";
  if (major < 500) return "100-499";
  if (major < 2000) return "500-1999";
  return "2000+";
}

/** Is `next` a newer state of the order than what it reflects now? */
export function isNewerOrderState(
  current: { providerUpdatedAt: Date; providerSequence: number | null },
  next: { providerUpdatedAt: Date; providerSequence: number | null }
): boolean {
  if (current.providerSequence !== null && next.providerSequence !== null) return next.providerSequence > current.providerSequence;
  return next.providerUpdatedAt.getTime() > current.providerUpdatedAt.getTime();
}

/** The live connection a receipt was accepted through (by endpoint publicId; Wix by its instance id). */
async function connectionIdFor(tx: TenantTx, sourceKey: string, accountRef: string | null): Promise<number | null> {
  if (!accountRef) return null;
  const where = sourceKey === "commerce.wix" ? { externalResourceId: accountRef } : { publicId: accountRef };
  const row = await tx.acquisitionConnection.findFirst({
    where: { sourceKey, status: { not: "REVOKED" }, ...where },
    select: { id: true },
    orderBy: { id: "desc" },
  });
  return row?.id ?? null;
}

async function upsertLines(tx: TenantTx, businessId: number, orderId: number, lines: NonNullable<CommerceOrderV1["lines"]>): Promise<void> {
  const keys: string[] = [];
  for (const l of lines) {
    keys.push(l.lineKey);
    const data = {
      externalProductId: l.externalProductId ?? null,
      sku: l.sku ?? null,
      title: l.title ?? null,
      quantity: l.quantity,
      unitMinor: l.unitMinor,
      totalMinor: l.totalMinor,
      present: true,
    };
    await tx.commerceOrderLine.upsert({
      where: { businessId_orderId_lineKey: { businessId, orderId, lineKey: l.lineKey } },
      create: { businessId, orderId, lineKey: l.lineKey, ...data },
      update: data,
    });
  }
  await tx.commerceOrderLine.updateMany({
    where: { businessId, orderId, present: true, lineKey: { notIn: keys } },
    data: { present: false },
  });
}

export async function routeToCommerce(
  ctx: IntakeRouteContext & { decision: RoutingDecision },
  normalized: NormalizedIntake,
  event: ClaimedIntakeEvent
): Promise<RouteResult> {
  const { businessId } = ctx;
  const order = event.payload;
  if (!isCommerceOrder(order)) throw new IntakeTerminalError("malformed_payload");
  if (!isCommerceSourceKey(event.sourceKey)) throw new IntakeTerminalError("not_a_commerce_source");
  const sourceKey = event.sourceKey;
  const identifiers = identifiersFromHints(normalized.contactHints, { sourceKey, accountRef: event.providerAccountRef });
  const updatedAt = new Date(order.providerUpdatedAt);
  const sequence = order.providerSequence ?? null;

  const out = await withTenantTransaction(async (tx) => {
    // 1. idempotency anchor
    const prior = await tx.commerceOrderEvent.findFirst({
      where: { businessId, intakeEventId: event.id },
      select: { orderId: true, order: { select: { customerId: true } } },
    });
    if (prior) {
      return {
        kind: "routed" as const,
        refs: { orderId: prior.orderId, ...(prior.order.customerId ? { customerId: prior.order.customerId } : {}) },
        alreadyExisted: true,
      };
    }

    const connectionId = await connectionIdFor(tx, sourceKey, event.providerAccountRef);
    if (connectionId === null) return { kind: "ignored" as const, code: "connection_revoked" };

    // 2. locks: the order first, then the buyer's identifiers (each in a fixed global order).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COMMERCE_ORDER_LOCK_NAMESPACE}::int, ${orderLockKey(businessId, sourceKey, order.providerOrderId)}::int)`;
    await lockIdentifiers(tx, businessId, identifiers);

    // 3. identity, authoritatively, under the locks
    const identity = await resolveIdentity(tx, businessId, identifiers);
    const existing = await tx.commerceOrder.findFirst({
      where: { businessId, sourceKey, externalOrderId: order.providerOrderId },
      select: { id: true, customerId: true, status: true, providerUpdatedAt: true, providerSequence: true },
    });

    // 4. contact — only for an order that has none
    let customerId: number | null = existing?.customerId ?? null;
    let created = false;
    let proposalIds: number[] = [];
    const phone = identifiers.find((i) => i.kind === "phone")?.value ?? null;
    if (customerId === null) {
      if (identity.state === "resolved") {
        customerId = identity.customerId;
      } else if (identity.state === "unresolved" && phone) {
        const hints = normalized.contactHints ?? {};
        const c = await customerService.createCustomer(
          {
            businessId,
            name: (hints.displayName || hints.companyName || hints.email || phone).slice(0, 120),
            phone,
            email: identifiers.find((i) => i.kind === "email")?.value ?? null,
          },
          { tx }
        );
        customerId = c.id;
        created = true;
      } else if (identity.state === "candidate" || identity.state === "ambiguous" || identity.state === "conflict") {
        proposalIds = await openProposals(tx, {
          businessId,
          intakeEventId: event.id,
          leadId: null,
          identity,
          links: await unheldIdentifiers(tx, businessId, identifiers),
        });
      }
      // Deterministic links only for a buyer M4 is certain of (never from an uncertain match).
      if (customerId !== null) {
        await ensureLinks(tx, { businessId, customerId, identifiers, method: "deterministic", sourceIntakeEventId: event.id });
      }
    }

    // 5. the order
    const attribution = normalized.attribution ? (normalized.attribution as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
    let orderId: number;
    let applied: boolean;
    let previousStatus: string | null = null;
    if (!existing) {
      const row = await tx.commerceOrder.create({
        data: {
          businessId,
          connectionId,
          sourceKey,
          externalOrderId: order.providerOrderId,
          orderNumber: order.orderNumber ?? null,
          customerId,
          status: order.status,
          currency: order.currency,
          totalMinor: order.totalMinor,
          refundedMinor: order.refundedMinor,
          lineCount: order.lines?.length ?? 0,
          placedAt: new Date(order.placedAt),
          providerUpdatedAt: updatedAt,
          providerSequence: sequence,
          attribution,
          firstIntakeEventId: event.id,
          lastIntakeEventId: event.id,
        },
        select: { id: true },
      });
      orderId = row.id;
      applied = true;
    } else {
      orderId = existing.id;
      previousStatus = existing.status;
      applied = isNewerOrderState(existing, { providerUpdatedAt: updatedAt, providerSequence: sequence });
      if (applied) {
        await tx.commerceOrder.updateMany({
          where: { id: orderId, businessId },
          data: {
            status: order.status,
            currency: order.currency,
            totalMinor: order.totalMinor,
            refundedMinor: order.refundedMinor,
            ...(order.lines ? { lineCount: order.lines.length } : {}),
            ...(order.orderNumber ? { orderNumber: order.orderNumber } : {}),
            providerUpdatedAt: updatedAt,
            providerSequence: sequence,
            lastIntakeEventId: event.id,
            ...(existing.customerId === null && customerId !== null ? { customerId } : {}),
          },
        });
      } else if (existing.customerId === null && customerId !== null) {
        // A late delivery can still name the buyer of an order that has none; it never changes status.
        await tx.commerceOrder.updateMany({ where: { id: orderId, businessId, customerId: null }, data: { customerId } });
      }
    }

    // 6. lines
    if (applied && order.lines) await upsertLines(tx, businessId, orderId, order.lines);

    // 7. append-only history (the idempotency anchor of step 1)
    await tx.commerceOrderEvent.create({
      data: {
        businessId,
        orderId,
        intakeEventId: event.id,
        kind: order.eventKind,
        statusAfter: applied ? order.status : (previousStatus as OrderStatus),
        applied,
        providerUpdatedAt: updatedAt,
      },
    });

    // 8. evidence on the normalized record, same transaction
    const refs: { orderId: number; customerId?: number } = { orderId, ...(customerId ? { customerId } : {}) };
    await tx.intakeNormalizedEvent.updateMany({
      where: { businessId, intakeEventId: event.id },
      data: {
        identityState: identity.state,
        identityPolicyVersion: identity.policyVersion,
        identityCustomerId: identity.state === "resolved" || created ? customerId : null,
        identityEvidence: {
          ...identity.evidence,
          createdCustomer: created,
          orderApplied: applied,
          proposals: proposalIds.length,
        } as Prisma.InputJsonValue,
        identityCandidateCount: identity.candidates.length,
        routingRule: ctx.decision.rule,
        routingDestination: ctx.decision.destination,
        ownerReviewRequired: proposalIds.length > 0,
        resultRefs: refs as Prisma.InputJsonValue,
      },
    });

    // Learning signals: categories only (never a name, number, address, product text or amount).
    if (created && customerId !== null) {
      await recordSensor(
        {
          businessId,
          sensor: "CUSTOMER_CREATED",
          entityId: customerId,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          payload: { origin: "INTAKE" },
          idempotencyKey: `customer:${customerId}:created`,
        },
        { tx }
      );
    }
    if (!existing) {
      await recordSensor(
        {
          businessId,
          sensor: "COMMERCE_ORDER_RECORDED",
          entityId: orderId,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          occurredAt: new Date(order.placedAt),
          idempotencyKey: `commerce-order:${orderId}:recorded`,
          payload: {
            sourceKey,
            status: order.status,
            currency: order.currency,
            totalBucket: totalBucket(order.totalMinor),
            lineCount: order.lines?.length ?? 0,
            customerKind: created ? "new" : customerId !== null ? "returning" : "unknown",
            identityState: identity.state,
            attributed: normalized.attribution?.utm !== undefined || normalized.attribution?.clickId !== undefined,
          },
        },
        { tx }
      );
    } else if (applied && previousStatus !== order.status) {
      await recordSensor(
        {
          businessId,
          sensor: "COMMERCE_ORDER_STATUS_CHANGED",
          entityId: orderId,
          actor: { type: "INTEGRATION" },
          source: "INTEGRATION",
          occurredAt: updatedAt,
          idempotencyKey: `commerce-order:${orderId}:status:${event.id}`,
          payload: { sourceKey, fromStatus: previousStatus, toStatus: order.status, eventKind: order.eventKind },
        },
        { tx }
      );
    }
    return { kind: "routed" as const, refs, alreadyExisted: false };
  });

  if (out.kind === "ignored") return { kind: "ignored", code: out.code };
  return { kind: "routed", refs: out.refs, alreadyExisted: out.alreadyExisted };
}
