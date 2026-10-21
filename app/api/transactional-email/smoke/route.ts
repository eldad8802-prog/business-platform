import { NextRequest, NextResponse } from "next/server";

import { runSmokeSend, type SmokeOutcome } from "@/lib/email/transactional/smoke";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * TEMPORARY — the one-shot Resend smoke send (lib/email/transactional/smoke.ts).
 *
 * Who may call it: the manual transactional-email-smoke.yml workflow (POST) with the CRON_SECRET
 * bearer, through the same dual-accept decision the cron routes use. Never a user session. The
 * request carries nothing the send uses — recipient, subject and body are constants.
 * The answer is the outcome, a machine code and the provider message id — no address, no content.
 *
 * Remove together with the smoke module, the workflow and the TRANSACTIONAL_EMAIL_SMOKE bucket.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STATUS: Record<SmokeOutcome, number> = {
  sent: 200,
  expired: 410,
  already_used: 409,
  disabled: 409,
  latch_unavailable: 503,
  not_configured: 500,
  retryable: 502,
  permanent: 502,
};

/** The manual workflow, with the CRON_SECRET bearer. */
export async function POST(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "smoke_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const r = await runSmokeSend();
    return NextResponse.json(r, { status: STATUS[r.outcome], headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[transactional-email] smoke_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ outcome: "error" }, { status: 500 });
  }
}
