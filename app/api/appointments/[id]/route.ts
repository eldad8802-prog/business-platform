import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  cancel,
  complete,
  confirm,
  markNoShow,
} from "@/lib/services/appointment/appointment.service";
import type { AppointmentResult } from "@/lib/services/appointment/appointment.types";

/**
 * Thin web adapter for Appointment lifecycle transitions (Inbox owner).
 * No business logic: auth + business scoping + a single call to the matching
 * appointment.service function (which is the ONLY place transitions happen, via
 * assertTransition) + reason -> HTTP. No reschedule, no scheduling here.
 */

type Action = "confirm" | "complete" | "no_show" | "cancel";

function parseAction(value: unknown): Action | null {
  if (
    value === "confirm" ||
    value === "complete" ||
    value === "no_show" ||
    value === "cancel"
  ) {
    return value;
  }
  return null;
}

function parseId(raw: string | undefined): number | null {
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
    const appointmentId = parseId(id);
    if (appointmentId === null) {
      return NextResponse.json(
        { error: "Invalid appointment id" },
        { status: 400 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const action = parseAction(body.action);
    if (!action) {
      return NextResponse.json(
        { error: "action must be confirm | complete | no_show | cancel" },
        { status: 400 }
      );
    }

    const base = {
      appointmentId,
      businessId: user.businessId,
      actor: { actor: "OWNER" as const, userId: user.id, sourceChannel: "INBOX_WEB" as const },
    };

    let result: AppointmentResult;
    switch (action) {
      case "confirm":
        result = await confirm(base);
        break;
      case "complete":
        result = await complete(base);
        break;
      case "no_show":
        result = await markNoShow(base);
        break;
      case "cancel":
        result = await cancel({
          ...base,
          reason: typeof body.reason === "string" ? body.reason : null,
        });
        break;
    }

    if (result.ok) {
      return NextResponse.json({ success: true, appointment: result.appointment });
    }

    switch (result.reason) {
      case "appointment_not_found":
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 }
        );
      case "invalid_transition":
        return NextResponse.json(
          { error: "invalid_transition" },
          { status: 409 }
        );
      default:
        return NextResponse.json({ error: result.reason }, { status: 400 });
    }
  } catch (error) {
    console.error("POST /api/appointments/[id] error:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
