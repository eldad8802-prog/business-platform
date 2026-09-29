import { NextResponse } from "next/server";
// Value import (not `import type`): P2002 detection needs the runtime class.
import { Prisma } from "@prisma/client";
import { applyMessageEvent } from "@/lib/conversation-state/conversation-state.service";
import { recordConversationActivity } from "@/lib/conversation-state/conversation-activity";
import {
  recordConversationEvidence,
  type ConversationEvidenceInput,
} from "@/lib/services/conversation/conversation-evidence.service";
import { getCurrentUser } from "@/lib/auth";
import { enforceCostLimit } from "@/lib/security/cost-limits";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { syncInboxWaitingNotifications } from "@/lib/notifications/inbox-waiting-notifications";
import { sendWhatsAppTextForBusiness } from "@/lib/services/integrations/whatsapp/outbound-send.service";
import { logRouteError } from "@/lib/security/route-error";

/**
 * Conversation messages.
 *
 * GET  — the conversation's messages and the suggestions for its latest
 *        customer message.
 * POST — a message the BUSINESS writes (and, on WhatsApp, sends).
 *
 * M2 — TRUST BOUNDARY. This route used to take `direction` and `senderType`
 * from the request body, defaulting to INBOUND / CUSTOMER. Any signed-in user
 * could therefore manufacture a "customer" message in their own business, and
 * the route ran a second, drifted copy of the inbound pipeline for it (analysis,
 * lead auto-capture, bot drafts, learning outcomes, notifications) — evidence
 * that no customer ever produced.
 *
 * A customer message is now a PROVIDER fact: it enters only through the
 * Business Intake path (provider-authenticated webhook → IntakeEvent →
 * ingestInboundCustomerMessage → runInboundMessagePipeline). This route writes
 * business messages only:
 *   - direction is always OUTBOUND and senderType always BUSINESS_USER, decided
 *     here from the session — a body that asserts anything else is refused (400);
 *   - the channel is the conversation's own, never the body's.
 */

const INBOUND_REFUSED =
  "This route writes business messages only. Customer messages arrive through the provider intake.";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const conversationIdParam = searchParams.get("conversationId");

    if (!conversationIdParam) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }

    const conversationId = Number(conversationIdParam);

    if (!conversationId || Number.isNaN(conversationId)) {
      return NextResponse.json(
        { error: "Invalid conversationId" },
        { status: 400 }
      );
    }

    const { conversation, messages, suggestions } = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const conversation = await tx.conversation.findFirst({
            where: {
              id: conversationId,
              businessId: user.businessId,
            },
          });

          if (!conversation) {
            return { conversation: null, messages: [], suggestions: [] };
          }

          const messages = await tx.message.findMany({
            where: { conversationId, businessId: user.businessId },
            orderBy: { createdAt: "asc" },
          });

          const lastInboundCustomerMessage = [...messages]
            .reverse()
            .find(
              (m) => m.direction === "INBOUND" && m.senderType === "CUSTOMER"
            );

          let suggestions: any[] = [];

          if (lastInboundCustomerMessage) {
            suggestions = await tx.replySuggestion.findMany({
              where: {
                businessId: user.businessId,
                conversationId,
                messageId: lastInboundCustomerMessage.id,
              },
              orderBy: { createdAt: "desc" },
            });
          }
          return { conversation, messages, suggestions };
        })
    );

    if (!conversation) {
      return NextResponse.json(
        {
          messages: [],
          suggestions: [],
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        messages: messages || [],
        suggestions: suggestions || [],
      },
      { status: 200 }
    );
  } catch (error: any) {
    logRouteError("GET /api/message", error);

    return NextResponse.json(
      {
        error: "Failed to fetch messages",
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }
    const costLimited = await enforceCostLimit("COST_MESSAGE_SEND", user, req);
    if (costLimited) return costLimited;

    const body = await req.json();
    const conversationId = Number(body.conversationId);

    if (!conversationId || Number.isNaN(conversationId)) {
      return NextResponse.json(
        { error: "conversationId is required" },
        { status: 400 }
      );
    }

    // The body may restate what the server decides; it may not contradict it.
    // Refused before any database work, so a forged "customer" message leaves
    // no trace and triggers nothing.
    if (
      (body.direction !== undefined && body.direction !== "OUTBOUND") ||
      (body.senderType !== undefined && body.senderType !== "BUSINESS_USER")
    ) {
      return NextResponse.json({ error: INBOUND_REFUSED }, { status: 400 });
    }

    // D2/P7-W4B: the whole handler body runs under the session tenant context;
    // every DB group below is a SHORT tenant transaction, and the external
    // WhatsApp send stays outside any transaction.
    return await runWithTenantContext({ businessId: user.businessId }, () =>
      handleBusinessMessage(user, body, conversationId)
    );
  } catch (error: any) {
    logRouteError("POST /api/message", error);

    return NextResponse.json(
      {
        error: "Failed to create message",
      },
      { status: 500 }
    );
  }
}

/**
 * W3 evidence for a business message that was just persisted: record the
 * conversation transitions the writer reported (they are snapshots on the row
 * and would otherwise be overwritten unrecorded). Best effort: never breaks the
 * message it describes, and never changes what the writer decided.
 */
async function recordBusinessMessageEvidence(input: {
  businessId: number;
  conversation: { id: number; leadId: number | null; channel: string; businessId: number };
  message: {
    id: number;
    direction: string;
    senderType: string;
    createdAt: Date;
  };
  state: {
    stageBefore: string | null;
    stageAfter: string;
    temperatureBefore: number | null;
    temperatureAfter: number;
  } | null;
  attribution: Pick<ConversationEvidenceInput, "actor" | "source">;
}) {
  try {
    await withTenantTransaction((tx) =>
      recordConversationEvidence(
        {
          ...input.attribution,
          businessId: input.businessId,
          conversationId: input.conversation.id,
          messageId: input.message.id,
          leadId: input.conversation.leadId ?? null,
          channel: input.conversation.channel,
          direction: input.message.direction,
          senderType: input.message.senderType,
          occurredAt: input.message.createdAt ?? new Date(),
          state: input.state,
        },
        { tx }
      )
    );
  } catch (error) {
    console.warn("[api/message] evidence failed:", error);
  }
}

async function handleBusinessMessage(
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
  body: any,
  conversationId: number
) {
  const conversation = await withTenantTransaction((tx) =>
    tx.conversation.findFirst({
      where: {
        id: conversationId,
        businessId: user.businessId,
      },
    })
  );

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  // W2.5 send idempotency (opt-in). When the caller supplies a token the unique
  // index decides, and a collision returns the message that already exists
  // rather than a second one (two rows would be two real messages).
  const clientRequestId =
    typeof body.clientRequestId === "string" && body.clientRequestId.trim()
      ? body.clientRequestId.trim().slice(0, 100)
      : null;

  let createdMessage;
  try {
    const bodyCustomerId = body.customerId ?? null;
    const bodySuggestionId = body.generatedFromSuggestionId ?? null;
    createdMessage = await withTenantTransaction(async (tx) => {
      // Tenant integrity: body-supplied ids must belong to THIS business.
      // One answer for every miss, so this is not an existence oracle.
      if (
        bodyCustomerId != null &&
        !(await tx.customer.findFirst({
          where: { id: bodyCustomerId, businessId: user.businessId },
          select: { id: true },
        }))
      ) {
        return null;
      }
      if (
        bodySuggestionId != null &&
        !(await tx.replySuggestion.findFirst({
          where: { id: bodySuggestionId, businessId: user.businessId },
          select: { id: true },
        }))
      ) {
        return null;
      }
      return tx.message.create({
        data: {
          conversationId,
          businessId: user.businessId,
          customerId: bodyCustomerId,
          // The conversation's channel — a WhatsApp send is only ever attempted
          // for a WhatsApp conversation.
          channel: conversation.channel,
          messageType: body.messageType ?? "TEXT",
          // Decided here, never read from the body (see the file header).
          direction: "OUTBOUND",
          senderType: "BUSINESS_USER",
          contentText: body.contentText ?? null,
          generatedFromSuggestionId: bodySuggestionId,
          clientRequestId,
        },
      });
    });
  } catch (error) {
    const isDuplicateSend =
      clientRequestId !== null &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002";
    if (!isDuplicateSend) throw error;

    const existing = await withTenantTransaction((tx) =>
      tx.message.findFirst({
        where: { businessId: user.businessId, clientRequestId },
      })
    );
    // Nothing further to do: the message exists and its effects already ran.
    return NextResponse.json(
      { message: existing, duplicateSuppressed: true },
      { status: 200 }
    );
  }

  if (!createdMessage) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // ── WhatsApp delivery (text only) ─────────────────────────────────────────
  // The row is already persisted; here we attempt delivery and record the
  // outcome on it. Delivered / read / failed arrive later as provider receipts
  // (IntakeEvent MESSAGE_STATUS) and update this same row.
  let messageForResponse = createdMessage;
  let whatsappSend:
    | { status: "SENT" }
    | { status: "FAILED"; reason: string }
    | undefined;

  if (conversation.channel === "WHATSAPP") {
    let recipientPhone: string | null = null;
    if (conversation.customerId) {
      const customer = await withTenantTransaction((tx) =>
        tx.customer.findFirst({
          where: { id: conversation.customerId!, businessId: user.businessId },
          select: { phone: true },
        })
      );
      recipientPhone = customer?.phone ?? null;
    }

    const outcome = await sendWhatsAppTextForBusiness({
      businessId: user.businessId,
      toPhone: recipientPhone,
      text: body.contentText,
    });

    const now = new Date();
    if (outcome.ok) {
      messageForResponse = await withTenantTransaction(async (tx) => {
        await tx.message.updateMany({
          where: { id: createdMessage.id, businessId: user.businessId },
          data: {
            sendStatus: "SENT",
            providerMessageId: outcome.providerMessageId,
            sentAt: now,
            sendAttemptedAt: now,
          },
        });
        return tx.message.findFirstOrThrow({
          where: { id: createdMessage.id, businessId: user.businessId },
        });
      });
      whatsappSend = { status: "SENT" };
    } else {
      messageForResponse = await withTenantTransaction(async (tx) => {
        await tx.message.updateMany({
          where: { id: createdMessage.id, businessId: user.businessId },
          data: {
            sendStatus: "FAILED",
            sendAttemptedAt: now,
            sendErrorCode: outcome.code.slice(0, 64),
            sendErrorMessage: outcome.message.slice(0, 500),
          },
        });
        return tx.message.findFirstOrThrow({
          where: { id: createdMessage.id, businessId: user.businessId },
        });
      });
      whatsappSend = { status: "FAILED", reason: outcome.reason };
    }
  }

  // ── Conversation activity: ALWAYS (M2) ──────────────────────────────────
  // lastMessageAt / businessLastOutboundAt / the unanswered count used to be
  // written here only when CONVERSATION_STATE_WRITER_ENABLED was on. They are
  // derived and replay-safe, and now kept for every message.
  try {
    await withTenantTransaction((tx) => recordConversationActivity(tx, messageForResponse));
  } catch (error) {
    console.warn("[api/message] conversation activity failed:", error);
  }

  // ── Stage / temperature: behind its flag, unchanged ──────────────────────
  let w3State = null;
  try {
    const applied = await withTenantTransaction((tx) =>
      applyMessageEvent(
        {
          message: messageForResponse,
          conversation,
          analysis: null,
        },
        { tx }
      )
    );
    if (applied.applied) w3State = applied.state;
  } catch (error) {
    console.warn("conversation-state writer (business message) failed:", error);
  }

  // W3 — record what the writer just did before it is overwritten. The session
  // user wrote this message as themselves: the sender is no longer client-
  // asserted, so the owner attribution is exact.
  await recordBusinessMessageEvidence({
    businessId: user.businessId,
    conversation,
    message: messageForResponse,
    state: w3State,
    attribution: { actor: { type: "OWNER_USER", userId: user.id }, source: "OWNER_UI" },
  });

  // AFTER the message has committed. A business message ends the wait —
  // "waiting" is defined as the last message being inbound from a customer. The
  // sync reconciles and swallows its own errors; the tenant is the session one,
  // never a body field.
  await syncInboxWaitingNotifications(user.businessId, conversationId, new Date());

  return NextResponse.json(
    {
      message: messageForResponse,
      analysis: null,
      mode: null,
      shouldGenerate: false,
      suggestions: [],
      updatedOutcomeSuggestion: null,
      whatsappSend,
    },
    { status: 201 }
  );
}
