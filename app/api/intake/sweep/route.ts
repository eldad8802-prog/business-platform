import { NextRequest, NextResponse } from "next/server";
import { authorizeSweep } from "@/lib/intake/sweep-auth";
import { runIntakeSweep } from "@/lib/intake/intake-sweeper";

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
    // "The sweep ran" is not "the receipts were processed": a business that could not be swept, or
    // any receipt that failed again (retryable) or went to dead letter during this run, makes the run
    // unhealthy — the scheduler goes red (QStash: a failed delivery, retried, then dead-lettered).
    // Counts only; no content.
    const reasons = [
      ...(report.businessErrors > 0 ? ["business_errors"] : []),
      ...(report.events.failed > 0 ? ["failed_receipts"] : []),
    ];
    const unhealthy = reasons.length > 0;
    if (unhealthy) console.error("[intake-sweep] unhealthy", { via: auth.via, reasons, businessErrors: report.businessErrors, failed: report.events.failed });
    return NextResponse.json({ ok: !unhealthy, via: auth.via, ...(unhealthy ? { reasons } : {}), report }, { status: unhealthy ? 500 : 200 });
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
