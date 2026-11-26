import { NextRequest, NextResponse } from "next/server";

import { answerAppointmentsHealth } from "@/lib/services/appointment/appointments-health";
import { collectAppointmentsHealth } from "@/lib/services/appointment/appointments-health.service";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Appointments health (G4) — READ-ONLY. Called by the GitHub watchdog (.github/workflows/appointments-health.yml)
 * with the CRON_SECRET bearer — never a user session, never a tenant from the caller. Writes nothing.
 * Answers counts and fixed check names only (no business id, no name, no phone): 200 healthy, 500 with the failing
 * checks (lib/services/appointment/appointments-health.ts), so the watchdog run turns red.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const a = await answerAppointmentsHealth(decideCronAuth(req.headers.get("authorization")), () => collectAppointmentsHealth());
  if (a.status === 500) console.error("[appointments-health] unhealthy", { failing: a.body.failing ?? a.body.error });
  return NextResponse.json(a.body, { status: a.status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
