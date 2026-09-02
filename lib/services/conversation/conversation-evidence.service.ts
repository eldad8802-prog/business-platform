/**
 * Durable conversation evidence — W3.
 *
 * The Conversation State Writer keeps `Conversation` current, and current is all
 * it keeps: `temperatureScore` is overwritten on every message, `currentStage`
 * is overwritten on every promotion. Both are SNAPSHOTS. So the questions a
 * business will want answered later —
 *
 *   "how fast do I actually answer people?"
 *   "when did this thread turn hot?"
 *   "how long does a lead sit at QUOTED before it moves?"
 *
 * — are unanswerable today and, worse, unanswerable RETROACTIVELY: the numbers
 * that would have supported them were overwritten as they happened. Every day
 * without this file is a day of history that cannot be reconstructed.
 *
 * ── Taxonomy ────────────────────────────────────────────────────────────────
 *
 * These are CONVERSATION events, not lead events, and they say so:
 * `entityType: "CONVERSATION"`, `entityId: conversation.id`. A customer sending
 * a message is a fact about the thread — it happens whether or not anybody ever
 * turned that thread into a lead, and it must still be recorded when nobody
 * did. When a lead IS linked, its id rides along in the payload as a
 * CORRELATION. Filing thread facts under `entityType: "LEAD"` would be a
 * convenient lie that quietly discards every conversation that never converted.
 *
 * ── The boundary ────────────────────────────────────────────────────────────
 *
 * Nothing here mutates a Lead, and nothing here reads CRM policy. The writer
 * stays a pure state function; this observes what it reported and records it.
 * Evidence flows one way:
 *
 *     message → conversation transition → durable evidence → (maybe) lead
 *
 * never the other way round.
 *
 * ── Idempotency, and why it needs no new constraint ─────────────────────────
 *
 * `LearningEvent` has no unique index, so replay safety cannot be delegated to
 * the database. It does not need to be, because of where these calls sit:
 *
 *   1. They fire once per MESSAGE ROW CREATED. A duplicate never gets that far —
 *      the WhatsApp path rejects a repeated `wamid` before creating anything,
 *      and `/api/message` short-circuits a repeated `clientRequestId` and
 *      returns before the writer runs at all (W2.5).
 *   2. The two transition events additionally require a real transition,
 *      computed from PERSISTED pre-state. A second pass over the same message
 *      would see the new state as its "before" and emit nothing.
 *
 * So the guarantee is structural rather than enforced, which is worth stating
 * plainly: if a future caller ever invokes this outside those two guarded
 * paths, it becomes that caller's job to be idempotent — or this file's job to
 * grow a real constraint.
 */

import type { Prisma } from "@prisma/client";
import { logAuditEvent } from "@/lib/services/audit.service";
import { bucketTemperature } from "@/lib/inbox-view/temperature-bucket";

export const CONVERSATION_EVIDENCE_EVENTS = {
  INBOUND_RECEIVED: "CONVERSATION_INBOUND_RECEIVED",
  BUSINESS_RESPONDED: "CONVERSATION_BUSINESS_RESPONDED",
  BECAME_HOT: "CONVERSATION_BECAME_HOT",
  STAGE_ADVANCED: "CONVERSATION_STAGE_ADVANCED",
} as const;

const ENTITY_TYPE = "CONVERSATION";

export type ConversationEvidenceInput = {
  businessId: number;
  conversationId: number;
  messageId: number;
  /** Correlation only — absent when the thread is not a lead. */
  leadId?: number | null;
  channel?: string | null;
  direction: string;
  senderType: string;
  occurredAt: Date;
  /** What the writer reported it wrote. Absent when the writer did not run. */
  state?: {
    stageBefore: string | null;
    stageAfter: string;
    temperatureBefore: number | null;
    temperatureAfter: number;
  } | null;
};

export type ConversationEvidenceResult = {
  emitted: string[];
};

/**
 * Record what just happened on a conversation.
 *
 * Best-effort by design: evidence must never break the message it describes, so
 * a failure here is logged and swallowed. The caller already wraps the writer
 * the same way.
 */
export async function recordConversationEvidence(
  input: ConversationEvidenceInput,
  options?: { tx?: Prisma.TransactionClient }
): Promise<ConversationEvidenceResult> {
  const emitted: string[] = [];

  const base = {
    conversationId: input.conversationId,
    messageId: input.messageId,
    ...(input.leadId != null ? { leadId: input.leadId } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    occurredAt: input.occurredAt.toISOString(),
  };

  const isCustomerInbound =
    input.direction === "INBOUND" && input.senderType === "CUSTOMER";
  const isOutbound = input.direction === "OUTBOUND";

  const write = async (eventType: string, payload: Record<string, unknown>) => {
    await logAuditEvent(
      {
        businessId: input.businessId,
        eventType,
        entityType: ENTITY_TYPE,
        entityId: input.conversationId,
        // Ids and timestamps only. The message body already lives on `Message`
        // and copying it here would create a second, unmanaged copy of customer
        // text with its own retention story.
        payload,
      },
      options
    );
    emitted.push(eventType);
  };

  try {
    if (isCustomerInbound) {
      await write(CONVERSATION_EVIDENCE_EVENTS.INBOUND_RECEIVED, base);
    } else if (isOutbound) {
      // The pair (inbound at T0, response at T1) is what makes a real response
      // time computable later — neither half is useful alone.
      await write(CONVERSATION_EVIDENCE_EVENTS.BUSINESS_RESPONDED, base);
    }

    const state = input.state;
    if (state) {
      // A transition, not a level: only the crossing is worth a row. A thread
      // that is already hot and gets another message has not "become hot".
      const wasHot = bucketTemperature(state.temperatureBefore) === "hot";
      const isHot = bucketTemperature(state.temperatureAfter) === "hot";
      if (!wasHot && isHot) {
        await write(CONVERSATION_EVIDENCE_EVENTS.BECAME_HOT, {
          ...base,
          temperatureBefore: state.temperatureBefore,
          temperatureAfter: state.temperatureAfter,
        });
      }

      if (state.stageBefore !== state.stageAfter) {
        await write(CONVERSATION_EVIDENCE_EVENTS.STAGE_ADVANCED, {
          ...base,
          stageBefore: state.stageBefore,
          stageAfter: state.stageAfter,
        });
      }
    }
  } catch (error) {
    console.warn(
      `[conversation-evidence] failed conversationId=${input.conversationId} messageId=${input.messageId}:`,
      error instanceof Error ? error.message : error
    );
  }

  return { emitted };
}
