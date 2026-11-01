import { NextResponse } from "next/server";
import { getAppointment } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, positiveId } from "@/lib/services/appointment/appointments-http";

/**
 * One appointment.
 *
 * GET (milestone A): the appointment and its recent history, behind the `appointments` flag.
 *
 * POST is RETIRED (owner P0-1, 2026-11-01): it was the pre-milestone-A lifecycle door (confirm / complete / no_show /
 * cancel) — ungated by the flag, without the per-business lock, Idempotency-Key or optimistic version, and it never
 * settled a public booking request, so a request could stay pending after its appointment changed. No screen called
 * it. Every status change goes through POST /api/appointments/[id]/status (changeStatus + settleRequestForStatus);
 * this answers 410 before reading the session or the database, so nothing can be written through it.
 */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return appointmentsRoute(req, async ({ principal }) => json(await getAppointment(principal, positiveId((await params).id))));
}

export async function POST() {
  return NextResponse.json(
    { error: "This endpoint was retired. Use POST /api/appointments/[id]/status.", code: "ENDPOINT_RETIRED" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
