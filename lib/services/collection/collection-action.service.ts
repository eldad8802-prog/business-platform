/**
 * M5 · Recording that a reminder was initiated.
 *
 * THE GAP THIS CLOSES. Collection lets an owner share or copy a payment reminder. Both were pure
 * browser actions — `navigator.share`, `clipboard.writeText`, a `wa.me` link — and neither made a
 * single network call. So a reminder could go out thirty times and the database was byte-identical
 * afterwards, which made "have we chased this customer?", "through what?" and "did payment follow?"
 * not difficult questions but unanswerable ones.
 *
 * THE DISCIPLINE. This records what Dubiz knows and stops there:
 *
 *   KNOWN     the owner pressed share or copy, at this moment, about this request, in this app
 *   NOT KNOWN whether a message was ever sent — the browser hands off and reports nothing back
 *   NOT KNOWN whether it was delivered, opened, read, or ignored
 *
 * Which is why every action name says INITIATED or COPIED or OPENED. The day an outbound provider
 * exists, delivery will be a different record with its own evidence — never a quiet reinterpretation
 * of these rows, which would retroactively turn "we opened WhatsApp" into "we sent a reminder"
 * across the entire history.
 *
 * NOT A MARKETING PLATFORM. No scheduling, no templates, no sequences, no automation. One append-only
 * row per owner action.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const COLLECTION_ACTION_TYPES = [
  "SHARE_INITIATED",
  "LINK_COPIED",
  "MESSAGE_COPIED",
  "WHATSAPP_OPENED",
] as const;
export type CollectionActionType = (typeof COLLECTION_ACTION_TYPES)[number];

export const COLLECTION_ACTION_CHANNELS = [
  "WHATSAPP",
  "SYSTEM_SHARE",
  "CLIPBOARD",
  "UNKNOWN",
] as const;
export type CollectionActionChannel = (typeof COLLECTION_ACTION_CHANNELS)[number];

export type RecordCollectionActionInput = {
  readonly businessId: number;
  readonly actorUserId: number;
  readonly actionType: CollectionActionType;
  readonly channel: CollectionActionChannel;
  readonly customerId?: number | null;
  readonly paymentRequestId?: number | null;
  readonly billingDocumentId?: number | null;
};

export type RecordCollectionActionResult =
  | { ok: true; id: number }
  | { ok: false; reason: "invalid_subject" | "unknown_subject" };

export function isCollectionActionType(value: unknown): value is CollectionActionType {
  return COLLECTION_ACTION_TYPES.includes(value as CollectionActionType);
}

export function isCollectionActionChannel(value: unknown): value is CollectionActionChannel {
  return COLLECTION_ACTION_CHANNELS.includes(value as CollectionActionChannel);
}

/**
 * Record one action.
 *
 * AT LEAST ONE SUBJECT IS REQUIRED. An action with nothing attached is a row saying somebody pressed
 * a button, which is telemetry rather than evidence — and telemetry with no consumer is exactly what
 * this milestone is not supposed to produce.
 *
 * EVERY SUBJECT IS VERIFIED TO BELONG TO THIS TENANT before the row is written. The ids come from a
 * request body, and the columns are deliberately not foreign keys (an action must survive its
 * customer being deleted — the reminder still went out that Tuesday), so nothing downstream of here
 * would catch a wrong one. The check happens inside the same tenant transaction as the insert, which
 * means it happens under row-level security: another tenant's customer id simply does not exist.
 */
export async function recordCollectionAction(
  input: RecordCollectionActionInput,
): Promise<RecordCollectionActionResult> {
  const { businessId, customerId, paymentRequestId, billingDocumentId } = input;
  if (customerId == null && paymentRequestId == null && billingDocumentId == null) {
    return { ok: false, reason: "invalid_subject" };
  }

  return tenantTx(businessId, async (tx) => {
    if (customerId != null) {
      const found = await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } });
      if (!found) return { ok: false as const, reason: "unknown_subject" as const };
    }
    if (paymentRequestId != null) {
      const found = await tx.paymentRequest.findFirst({
        where: { id: paymentRequestId, businessId },
        select: { id: true },
      });
      if (!found) return { ok: false as const, reason: "unknown_subject" as const };
    }
    if (billingDocumentId != null) {
      const found = await tx.billingDocument.findFirst({
        where: { id: billingDocumentId, businessId },
        select: { id: true },
      });
      if (!found) return { ok: false as const, reason: "unknown_subject" as const };
    }

    const created = await tx.collectionAction.create({
      data: {
        businessId,
        customerId: customerId ?? null,
        paymentRequestId: paymentRequestId ?? null,
        billingDocumentId: billingDocumentId ?? null,
        actionType: input.actionType,
        channel: input.channel,
        actorUserId: input.actorUserId,
      },
      select: { id: true },
    });
    return { ok: true as const, id: created.id };
  });
}

export type CollectionActionSummary = {
  readonly id: number;
  readonly actionType: string;
  readonly channel: string;
  readonly occurredAt: Date;
  readonly customerId: number | null;
  readonly paymentRequestId: number | null;
};

/**
 * What has been tried, for one customer.
 *
 * The read that makes the write worth doing: before chasing somebody again, the owner can see that
 * they were already chased twice this month. Nothing here infers whether it worked.
 */
export async function listCollectionActionsForCustomer(
  businessId: number,
  customerId: number,
  limit = 20,
): Promise<CollectionActionSummary[]> {
  return tenantTx(businessId, (tx) =>
    tx.collectionAction.findMany({
      where: { businessId, customerId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        actionType: true,
        channel: true,
        occurredAt: true,
        customerId: true,
        paymentRequestId: true,
      },
    }),
  );
}
