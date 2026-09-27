import { NextRequest, NextResponse } from "next/server";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { paymentReconciliationDeps } from "@/lib/services/payments/payments.deps";
import { runPaymentReconciliation } from "@/lib/services/payments/payment-reconciliation.service";

/**
 * M1 — scheduled inbound reconciliation: ask the provider's authority about
 * every request not yet known to be paid, so a payment whose webhook was lost,
 * early or unverifiable is still recorded — once, through the canonical path.
 *
 * Called by the scheduler (GitHub Actions; a daily Vercel cron as a backstop),
 * authenticated by CRON_SECRET exactly like settlement recovery, never by a
 * user session and never with a tenant supplied by the caller.
 *
 * OBSERVABLE BY STATUS CODE. A run that failed, could not reach the provider,
 * or met an anomalous answer responds 500 with its report, so the scheduler's
 * job goes red instead of looking like a quiet night. The response carries
 * counts only — no business, request or payment identifier.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideRecoveryAuth(req.headers.get("authorization"), process.env.CRON_SECRET);
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "reconciliation_not_configured" }, { status: 503 });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runPaymentReconciliation(paymentReconciliationDeps());
    console.info("[payment-reconciliation] run", report);
    return NextResponse.json(
      report.healthy ? { ok: true, report } : { ok: false, error: "reconciliation_degraded", report },
      { status: report.healthy ? 200 : 500 }
    );
  } catch (error) {
    console.error("[payment-reconciliation] run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "reconciliation_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET; the GitHub Actions scheduler POSTs. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
