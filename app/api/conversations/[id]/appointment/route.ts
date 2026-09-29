import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const conversationId = parseConversationId(id);
    if (conversationId === null) {
      return NextResponse.json(
        { error: "Invalid conversation id" },
        { status: 400 }
      );
    }

    let businessServiceId: number | null = null;
    const rawBody = await req.text();
    if (rawBody.trim()) {
      const body = JSON.parse(rawBody) as { businessServiceId?: unknown };
      if (body.businessServiceId !== undefined && body.businessServiceId !== null) {
        const parsed = Number(body.businessServiceId);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return NextResponse.json({ error: "Invalid service id" }, { status: 400 });
        }
        businessServiceId = parsed;
      }
    }

    const result = await createFromPending({
      conversationId,
      businessId: user.businessId,
      businessServiceId,
      actor: { actor: "OWNER", userId: user.id, sourceChannel: "INBOX_WEB" },
    });

    if (result.ok) {
      return NextResponse.json({ success: true, appointment: result.appointment });
    }

    switch (result.reason) {
      case "conversation_not_found":
      case "service_not_found":
        return NextResponse.json(
          { error: result.reason },
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
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    console.error("POST /api/conversations/[id]/appointment error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
