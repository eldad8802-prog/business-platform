import { NextRequest, NextResponse } from "next/server";

import { runTransactionalEmailSweep } from "@/lib/email/transactional/sweep";
import { purgeExpiredTicketsOnAuthPlane } from "@/lib/auth/oauth-ticket";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Transactional email sweep — retries due rows and settles expired ones
 * (lib/email/transactional/sweep.ts).
 *
 * Who may call it, both with the CRON_SECRET bearer through the same dual-accept decision the other
 * cron routes use: Vercel Cron (GET, every 10 minutes — vercel.json; the primary tick) and the GitHub
 * scheduled workflow (POST — a backstop: GitHub drops most of its every-10-minute runs, observed 4–8 a day).
 * Never a user session, never a tenant supplied by the caller. The answer is counts only — no
 * address, no content. Safe at any cadence and concurrently (one conditional claim per row, one
 * provider idempotency key per row).
 *
 * TRANSACTIONAL_EMAIL_ENABLED off → 200 { enabled: false } without touching the database.
 * On but misconfigured, or the auth plane not active → 500, so the scheduler goes red.
 *
 * The same tick removes expired "Continue with Google" signup tickets (auth_oauth_ticket_purge, migration
 * 20261030090000): a ticket lives at most 30 minutes and holds a prospective owner's address and name, so it
 * is not kept beyond the next sweep. Isolated: its result is reported beside the email report and its
 * failure is logged — it never changes the email sweep's answer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function purgeOAuthTickets(): Promise<{ purged: number } | { skipped: string } | { failed: true }> {
  try {
    return await purgeExpiredTicketsOnAuthPlane();
  } catch (error) {
    console.error("[oauth-ticket] purge_failed", { error: error instanceof Error ? error.name : "unknown" });
    return { failed: true };
  }
}

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const oauthTickets = await purgeOAuthTickets();

  try {
    const report = await runTransactionalEmailSweep();
    if (!report.enabled) return NextResponse.json({ ok: true, report, oauthTickets });
    if (!report.configured) {
      console.error("[transactional-email] sweep_not_configured", { missing: report.missing.join(",") });
      return NextResponse.json({ ok: false, report, oauthTickets }, { status: 500 });
    }
    if (!report.authPlane) {
      console.error("[transactional-email] sweep_auth_plane_inactive");
      return NextResponse.json({ ok: false, report, oauthTickets }, { status: 500 });
    }
    return NextResponse.json({ ok: true, report, oauthTickets });
  } catch (error) {
    console.error("[transactional-email] sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "sweep_failed", oauthTickets }, { status: 500 });
  }
}

/** Vercel Cron (vercel.json, every 10 minutes) — GET with the CRON_SECRET bearer, no body. */
export async function GET(req: NextRequest) {
  return handle(req);
}

/** The GitHub scheduled workflow (backstop) and manual dispatch, with the CRON_SECRET bearer. */
export async function POST(req: NextRequest) {
  return handle(req);
}
