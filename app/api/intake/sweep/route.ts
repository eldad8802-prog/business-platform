import { NextRequest, NextResponse } from "next/server";
import { authorizeSweep } from "@/lib/intake/sweep-auth";
import { runIntakeSweep, sweepHealth } from "@/lib/intake/intake-sweeper";

/**
 * Business Intake sweeper — retries intake receipts that did not finish when
 * they arrived (failures on their backoff, deferred documents, expired leases)
 * and applies payload retention.
 *
 * Who may call it (lib/intake/sweep-auth.ts):
 *   - QStash, the primary ~10-minute scheduler: POST with an `Upstash-Signature`
 *     verified by the official SDK Receiver for THIS exact Production URL and the
 *     raw body (QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY);
 *   - the backstops, with the CRON_SECRET bearer: the GitHub scheduled workflow
 *     (POST) and the daily Vercel cron (GET).
 * Never a user session, and never a tenant supplied by the caller: every tenant
 * is resolved and entered server-side. The response is counts only. Concurrent
 * runs are safe: receipts are claimed under a lease. A non-2xx answer makes the
 * scheduler record the run as failed (QStash retries it, then dead-letters it).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest, body: string) {
  const auth = await authorizeSweep({
    authorization: req.headers.get("authorization"),
    signature: req.headers.get("upstash-signature"),
    body,
  });
  if (!auth.ok) {
    if (auth.error === "invalid_signature" || auth.error === "qstash_not_configured") {
      console.warn("[intake-sweep] refused", { reason: auth.error });
    }
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  try {
    const report = await runIntakeSweep();
    // "The sweep ran" is not "the receipts were processed" (Leads L1 · G-07): a business that could not
    // be swept (JOB), or a receipt that failed in this run, a dead letter no sweep had reported yet (also
    // webhook-time ones), or a store reconciliation failure (EVENTS) makes the run unhealthy — the
    // scheduler goes red (QStash: a failed delivery, retried, then dead-lettered). The body names which
    // kind. Counts only; no content.
    const health = sweepHealth(report);
    const reasons = [...health.job, ...health.events];
    if (!health.ok) {
      console.error("[intake-sweep] unhealthy", {
        via: auth.via,
        job: health.job,
        events: health.events,
        businessErrors: report.businessErrors,
        failed: report.events.failed,
        deadLettersNew: report.backlog.deadLettersNew,
        commerceFailures: report.commerce.failures,
      });
    }
    return NextResponse.json(
      { ok: health.ok, via: auth.via, ...(health.ok ? {} : { reasons, health: { job: health.job, events: health.events } }), report },
      { status: health.ok ? 200 : 500 }
    );
  } catch (error) {
    console.error("[intake-sweep] run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

/** Vercel Cron invokes GET with the CRON_SECRET bearer — the daily backstop. No body. */
export async function GET(req: NextRequest) {
  return handle(req, "");
}

/** QStash (signed) and the GitHub backstop (bearer). The raw body is part of the signature. */
export async function POST(req: NextRequest) {
  return handle(req, await req.text());
}
