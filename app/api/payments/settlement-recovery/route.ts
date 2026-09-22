import { NextRequest, NextResponse } from "next/server";
import { decideRecoveryAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { runSettlementRecovery } from "@/lib/services/billing/settlement/payment-settlement-recovery.service";

/**
 * C3 — scheduled local recovery of verified payments whose accounting did not
 * finish. Called by the scheduler (GitHub Actions every 10 minutes; a daily
 * Vercel cron as a backstop), authenticated by CRON_SECRET, never by a user
 * session and never with a tenant supplied by the caller: every tenant is
 * resolved and entered server-side (see runSettlementRecovery).
 *
 * The response carries counts only — no identifier of any business, payment
 * or document — so a leaked response reveals nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideRecoveryAuth(
    req.headers.get("authorization"),
    process.env.CRON_SECRET
  );
  if (decision === "NOT_CONFIGURED") {
    return NextResponse.json({ error: "recovery_not_configured" }, { status: 503 });
  }
  if (decision !== "AUTHORIZED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runSettlementRecovery();
    return NextResponse.json({ ok: true, report }, { status: 200 });
  } catch (error) {
    console.error("[settlement-recovery] run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json({ ok: false, error: "recovery_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET; the GitHub Actions scheduler POSTs. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
