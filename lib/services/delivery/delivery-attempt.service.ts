/**
 * DeliveryAttempt — the single source of truth AND attempt history for
 * delivering a document to a recipient over a channel.
 *
 * There is no queue / retry engine / routing engine yet, so there is
 * deliberately NO separate DeliveryIntent layer: one row per
 * (documentType, documentId, channel, recipient), enforced by a DB-level unique,
 * holds the latest status + attemptCount + timestamps. When a real sender /
 * Outbox is built later, it processes PENDING rows (and an Intent layer can be
 * added on top without breaking this model).
 */

import { prisma } from "@/lib/prisma";
import { DeliveryChannel, DeliveryStatus } from "@prisma/client";

export interface RecordPendingDeliveryInput {
  businessId: number;
  documentType: string;
  documentId: number;
  channel: DeliveryChannel;
  recipient: string;
}

/**
 * Record that a document should be delivered to a recipient. Idempotent on
 * (documentType, documentId, channel, recipient): re-recording never duplicates
 * and never resets an existing row (a prior SENT/FAILED is left untouched).
 *
 * No sender exists yet, so a freshly recorded delivery is PENDING — it captures
 * the intent-to-deliver as durable state for a future sender to act on.
 *
 * Best-effort: returns the row id, or null on empty recipient / any failure.
 * The caller must treat a null as "delivery not recorded" and continue.
 */
export async function recordPendingDelivery(
  input: RecordPendingDeliveryInput
): Promise<number | null> {
  const recipient = input.recipient.trim();
  if (!recipient) return null;

  try {
    const row = await prisma.deliveryAttempt.upsert({
      where: {
        documentType_documentId_channel_recipient: {
          documentType: input.documentType,
          documentId: input.documentId,
          channel: input.channel,
          recipient,
        },
      },
      create: {
        businessId: input.businessId,
        documentType: input.documentType,
        documentId: input.documentId,
        channel: input.channel,
        recipient,
        status: DeliveryStatus.PENDING,
      },
      // Idempotent: an existing delivery record is the source of truth — do not
      // overwrite its status/attempt history when re-recording.
      update: {},
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("recordPendingDelivery error:", err);
    return null;
  }
}
