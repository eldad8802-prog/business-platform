import { NextRequest, NextResponse } from "next/server";

import { runTransactionalEmailSweep } from "@/lib/email/transactional/sweep";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Transactional email sweep — retries due rows and settles expired ones
 * (lib/email/transactional/sweep.ts).
 *
 * Who may call it: the GitHub scheduled workflow (POST) with the CRON_SECRET bearer, through the
 * same dual-accept decision the other cron routes use. Never a user session, never a tenant
 * supplied by the caller. The answer is counts only — no address, no content.
 *
 * TRANSACTIONAL_EMAIL_ENABLED off → 200 { enabled: false } without touching the database.
 * On but misconfigured, or the auth plane not active → 500, so the scheduler goes red.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const report = await runTransactionalEmailSweep();
    if (!report.enabled) return NextResponse.json({ ok: true, report });
    if (!report.configured) {
      console.error("[transactional-email] sweep_not_configured", { missing: report.missing.join(",") });
      return NextResponse.json({ ok: false, report }, { status: 500 });
    }
    if (!report.authPlane) {
      console.error("[transactional-email] sweep_auth_plane_inactive");
      return NextResponse.json({ ok: false, report }, { status: 500 });
    }
    return NextResponse.json({ ok: true, report });
  } catch (error) {
    console.error("[transactional-email] sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

/** The GitHub scheduled workflow, with the CRON_SECRET bearer. */
export async function POST(req: NextRequest) {
  return handle(req);
}
