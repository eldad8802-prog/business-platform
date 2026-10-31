import { NextRequest, NextResponse } from "next/server";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { runAccountantSweep } from "@/lib/accountant/sweep";
import { finishRun, runSourceOf, startRun } from "@/lib/accountant/ops/runs";

/**
 * The monthly accountant sweep (D1). Called by the scheduler — an hourly Vercel cron (and, optionally, the GitHub
 * Actions backstop) — authenticated by CRON_SECRET, never by a user session and never with a tenant
 * supplied by the caller: every business is resolved and entered server-side (lib/accountant/sweep.ts).
 *
 * Inert until owner gate G2: unless ACCOUNTANT_SWEEP_ENABLED is exactly "true" the route answers 200
 * without touching the database. The response carries counts only.
 *
 * Every enabled run is recorded in the run log (G5 milestone 1: "AccountantOpsRun", counts only) so the monitor can
 * see a run that failed, never finished, or never happened — only while the monitor is switched on
 * (ACCOUNTANT_MONITOR_ENABLED = "true"), so the monitor's own switch decides whether anything is written. Recording is
 * best-effort: a failure to record is logged and changes nothing about the sweep or its answer.
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
  const recordRuns = process.env.ACCOUNTANT_MONITOR_ENABLED?.trim() === "true";
  const runId = !recordRuns ? null : await startRun("SWEEP", runSourceOf(req.method), new Date()).catch((e: unknown) => {
    console.error("[accountant-sweep] run log start failed", { error: e instanceof Error ? e.name : "unknown" });
    return null;
  });
  const record = (outcome: "OK" | "FAILED", counts: unknown, errorCode: string | null) =>
    runId === null
      ? Promise.resolve()
      : finishRun(runId, outcome, counts, errorCode, new Date()).catch((e: unknown) => {
          console.error("[accountant-sweep] run log finish failed", { error: e instanceof Error ? e.name : "unknown" });
        });
  try {
    const summary = await runAccountantSweep();
    await record(summary.businessErrors === 0 ? "OK" : "FAILED", summary, summary.businessErrors === 0 ? null : "business_errors");
    return NextResponse.json({ ok: summary.businessErrors === 0, enabled: true, summary }, { status: summary.businessErrors === 0 ? 200 : 500 });
  } catch (error) {
    console.error("[accountant-sweep] run failed", { error: error instanceof Error ? error.name : "unknown" });
    await record("FAILED", {}, "sweep_failed");
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
