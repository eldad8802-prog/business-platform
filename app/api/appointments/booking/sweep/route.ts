import { NextRequest, NextResponse } from "next/server";

import { runBookingSweep } from "@/lib/services/booking/booking-sweep.service";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Public booking sweeper (Milestone C, D3): expires lapsed requests (their time is released) and sends the owner's
 * two-hourly reminders for requests still waiting. Called by Vercel Cron (GET) with the CRON_SECRET bearer — never a
 * user session, never a tenant from the caller (lib/services/booking/booking-sweep.service.ts). Counts only.
 * A business that could not be swept turns the run red.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const report = await runBookingSweep();
    const ok = report.errors === 0;
    if (!ok) console.error("[booking-sweep] unhealthy", { errors: report.errors });
    return NextResponse.json({ ok, report }, { status: ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[booking-sweep] run failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
