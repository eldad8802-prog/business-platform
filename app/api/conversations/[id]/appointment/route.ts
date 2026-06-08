import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { createFromPending } from "@/lib/services/appointment/appointment.service";

/**
 * Thin web adapter: Inbox owner converts a Pending Appointment Request into an
 * Appointment(PROPOSED). No business logic here — auth + business scoping +
 * a single call to appointment.service.createFromPending() + reason -> HTTP.
 */

function parseConversationId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await params;
    const conversationId = parseConversationId(id);
    if (conversationId === null) {
      return NextResponse.json(
        { error: "Invalid conversation id" },
        { status: 400 }
      );
    }

    const result = await createFromPending({
      conversationId,
      businessId: user.businessId,
      actor: { actor: "OWNER", userId: user.id, sourceChannel: "INBOX_WEB" },
    });

    if (result.ok) {
      return NextResponse.json({ success: true, appointment: result.appointment });
    }

    switch (result.reason) {
      case "conversation_not_found":
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      case "already_converted":
        return NextResponse.json(
          { error: "already_converted" },
          { status: 409 }
        );
      case "no_pending":
      case "pending_malformed":
        return NextResponse.json({ error: result.reason }, { status: 422 });
      default:
        return NextResponse.json({ error: "invalid_input" }, { status: 400 });
    }
  } catch (error) {
    console.error("POST /api/conversations/[id]/appointment error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
