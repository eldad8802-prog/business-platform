import { NextRequest, NextResponse } from "next/server";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { runIntakeSweep } from "@/lib/intake/intake-sweeper";

/**
 * Business Intake sweeper — retries intake receipts that did not finish when
 * they arrived (failures on their backoff, deferred documents, expired leases)
 * and applies payload retention.
 *
 * Authenticated by CRON_SECRET (constant-time, the same check settlement
 * recovery uses), never by a user session, and never with a tenant supplied by
 * the caller: every tenant is resolved and entered server-side. The response is
 * counts only.
 *
 * Scheduled every 10 minutes by .github/workflows/intake-sweep.yml (POST), with
 * a daily Vercel cron backstop (GET, vercel.json) should that schedule ever be
 * suspended. Concurrent runs are safe: receipts are claimed under a lease.
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
  try {
    const report = await runIntakeSweep();
    // "The sweep ran" is not "the receipts were processed": a business that could not be swept, or
    // any receipt that failed again (retryable) or went to dead letter during this run, makes the run
    // unhealthy — the scheduler goes red. Counts only; no content.
    const reasons = [
      ...(report.businessErrors > 0 ? ["business_errors"] : []),
      ...(report.events.failed > 0 ? ["failed_receipts"] : []),
    ];
    const unhealthy = reasons.length > 0;
    if (unhealthy) console.error("[intake-sweep] unhealthy", { reasons, businessErrors: report.businessErrors, failed: report.events.failed });
    return NextResponse.json({ ok: !unhealthy, ...(unhealthy ? { reasons } : {}), report }, { status: unhealthy ? 500 : 200 });
  } catch (error) {
    console.error("[intake-sweep] run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

/** Vercel Cron invokes GET with the CRON_SECRET bearer — the daily backstop. */
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
