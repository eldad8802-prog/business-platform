import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { ingestInboundCustomerMessage } from "@/lib/services/conversation/inbound-customer-message.service";
import { runInboundMessagePipeline } from "@/lib/services/conversation/inbound-message-pipeline.service";
import { syncInboxWaitingNotifications } from "@/lib/notifications/inbox-waiting-notifications";

export const runtime = "nodejs";

/**
 * LOCAL-DEVELOPMENT customer-message simulator.
 *
 * Replaces the old behaviour of `/api/message`, which accepted a client-asserted
 * INBOUND / CUSTOMER message in every environment (M2 closed that). Refused
 * outright in any production build — which on Vercel includes Preview — so it
 * cannot be used to manufacture customer evidence where customers are real.
 *
 * It goes through the SAME canonical path a provider-authenticated message
 * does (ingestInboundCustomerMessage → runInboundMessagePipeline →
 * notifications), so what developers see is what production does. It carries
 * no provider message id, so the evidence it produces is attributed UNKNOWN,
 * never INTEGRATION — a simulation is not a provider fact.
 *
 * Two gates, both required: not a production build, AND the canonical
 * platform-admin guard every /api/dev route carries (admin-boundary CI-3).
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const gate = await requirePlatformAdminOrResponse(req);
  if (gate instanceof NextResponse) return gate;

  // The admin guard proves who is asking; the session names the business.
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const conversationId = Number(body.conversationId);
  const text = typeof body.contentText === "string" ? body.contentText.trim() : "";
  if (!Number.isInteger(conversationId) || conversationId <= 0 || !text) {
    return NextResponse.json({ error: "conversationId and contentText are required" }, { status: 400 });
  }

  return runWithTenantContext({ businessId: user.businessId }, async () => {
    const conversation = await withTenantTransaction((tx) =>
      tx.conversation.findFirst({
        where: { id: conversationId, businessId: user.businessId },
        select: { id: true, channel: true, customer: { select: { phone: true } } },
      })
    );
    const phone = conversation?.customer?.phone ?? null;
    if (!conversation || conversation.channel !== "WHATSAPP" || !phone) {
      return NextResponse.json(
        { error: "Simulation needs a WhatsApp conversation whose customer has a phone" },
        { status: 404 }
      );
    }

    const ingested = await ingestInboundCustomerMessage({
      businessId: user.businessId,
      channel: "WHATSAPP",
      senderPhone: phone,
      providerMessageId: null,
      clientRequestId:
        typeof body.clientRequestId === "string" && body.clientRequestId.trim()
          ? `devsim:${body.clientRequestId.trim().slice(0, 90)}`
          : `devsim:${randomUUID()}`,
      text,
      messageType: "text",
      occurredAt: null,
      profileName: null,
    });
    if (ingested.status !== "ingested") {
      return NextResponse.json({ error: "Invalid sender" }, { status: 400 });
    }

    const pipeline = await runInboundMessagePipeline({
      conversation: ingested.conversation,
      message: ingested.message,
      businessId: user.businessId,
      source: "http",
      resume: ingested.alreadyExisted,
    });
    await syncInboxWaitingNotifications(user.businessId, ingested.conversation.id, new Date());

    return NextResponse.json(
      {
        message: ingested.message,
        analysis: pipeline.analysis,
        mode: pipeline.mode,
        shouldGenerate: pipeline.shouldGenerate,
        suggestions: pipeline.suggestions,
        updatedOutcomeSuggestion: pipeline.updatedOutcomeSuggestion,
      },
      { status: 201 }
    );
  });
}
