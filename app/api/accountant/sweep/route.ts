import { NextRequest, NextResponse } from "next/server";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { runAccountantSweep } from "@/lib/accountant/sweep";

/**
 * The monthly accountant sweep (D1). Called by the scheduler — an hourly Vercel cron (and, optionally, the GitHub
 * Actions backstop) — authenticated by CRON_SECRET, never by a user session and never with a tenant
 * supplied by the caller: every business is resolved and entered server-side (lib/accountant/sweep.ts).
 *
 * Inert until owner gate G2: unless ACCOUNTANT_SWEEP_ENABLED is exactly "true" the route answers 200
 * without touching the database. The response carries counts only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (process.env.ACCOUNTANT_SWEEP_ENABLED?.trim() !== "true") {
    return NextResponse.json({ ok: true, enabled: false }, { status: 200 });
  }
  try {
    const summary = await runAccountantSweep();
    return NextResponse.json({ ok: summary.businessErrors === 0, enabled: true, summary }, { status: summary.businessErrors === 0 ? 200 : 500 });
  } catch (error) {
    console.error("[accountant-sweep] run failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET; the GitHub Actions scheduler POSTs. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
