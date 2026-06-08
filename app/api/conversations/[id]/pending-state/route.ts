import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  clearPendingAppointmentRequest,
  clearPendingFollowUp,
  setPendingAppointmentRequest,
  setPendingFollowUp,
} from "@/lib/services/conversation/pending-state.service";

type PendingKind = "follow_up" | "appointment";

function parseKind(value: unknown): PendingKind | null {
  if (value === "follow_up" || value === "appointment") return value;
  return null;
}

function parseConversationId(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function nullableString(raw: unknown, maxLen = 280): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLen);
}

function originMessageId(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
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

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const kind = parseKind(body.kind);
    if (!kind) {
      return NextResponse.json(
        { error: "kind must be 'follow_up' or 'appointment'" },
        { status: 400 }
      );
    }

    const msgId = originMessageId(body.originMessageId);
    if (msgId === null) {
      return NextResponse.json(
        { error: "originMessageId is required" },
        { status: 400 }
      );
    }

    if (kind === "follow_up") {
      const result = await setPendingFollowUp(conversationId, user.businessId, {
        createdByOwnerId: user.id,
        originMessageId: msgId,
        note: nullableString(body.note),
      });
      if (!result.ok && result.reason === "conversation_not_found") {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
      if (!result.ok && result.reason === "already_exists") {
        return NextResponse.json(
          { error: "already_exists", pending: result.pending },
          { status: 409 }
        );
      }
      return NextResponse.json({ success: true, pending: result.pending });
    }

    const result = await setPendingAppointmentRequest(
      conversationId,
      user.businessId,
      {
        createdByOwnerId: user.id,
        originMessageId: msgId,
        customerHint: nullableString(body.customerHint),
      }
    );
    if (!result.ok && result.reason === "conversation_not_found") {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }
    if (!result.ok && result.reason === "already_exists") {
      return NextResponse.json(
        { error: "already_exists", pending: result.pending },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, pending: result.pending });
  } catch (error) {
    console.error("POST /api/conversations/[id]/pending-state error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(
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

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const kind = parseKind(body.kind);
    if (!kind) {
      return NextResponse.json(
        { error: "kind must be 'follow_up' or 'appointment'" },
        { status: 400 }
      );
    }

    const result =
      kind === "follow_up"
        ? await clearPendingFollowUp(conversationId, user.businessId)
        : await clearPendingAppointmentRequest(conversationId, user.businessId);

    if (!result.ok) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/conversations/[id]/pending-state error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
