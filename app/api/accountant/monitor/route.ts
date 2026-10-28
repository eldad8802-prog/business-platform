import { NextRequest, NextResponse } from "next/server";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { readAlertChannel, sendDigest } from "@/lib/accountant/ops/alert-email";
import type { Claim } from "@/lib/accountant/ops/alert-store";
import { runAccountantMonitor } from "@/lib/accountant/ops/monitor";
import { runSourceOf } from "@/lib/accountant/ops/runs";

/**
 * The accountant package monitor (G5 milestone 1, M2). Called by Vercel Cron (GET, hourly at :50) and by the
 * independent GitHub Actions watchdog (POST, .github/workflows/accountant-monitor.yml) — authenticated by
 * CRON_SECRET, never by a user session, never with a tenant supplied by the caller (lib/accountant/ops/monitor.ts).
 *
 * Inert until the owner's gate: unless ACCOUNTANT_MONITOR_ENABLED is exactly "true" the route answers 200 without
 * touching the database. Answers counts and finding codes only — never a business's data.
 *
 * 500 when the run failed or an alert that was due could not be sent (no ACCOUNTANT_OPS_ALERT_EMAIL, the provider
 * failed): the claims were given back for the next run, and the GitHub watchdog turns red — the channel that does
 * not depend on this endpoint.
 *
 * POST ?simulate=1 — the SAFE SIMULATION: one test message through the real alert channel (the same address, sender
 * and provider), saying it is a test; it reads and writes nothing in the database, and at most one goes out per
 * ten minutes (provider idempotency key per 10-minute window). It works with the monitor still switched off, so
 * the channel can be proven before the monitor is turned on.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SIMULATION_WINDOW_MS = 10 * 60 * 1000;

async function simulate(now: Date) {
  const channel = readAlertChannel();
  if (!channel.ok) return NextResponse.json({ ok: false, simulated: true, notification: "not_configured", reason: channel.reason }, { status: 500 });
  const window = Math.floor(now.getTime() / SIMULATION_WINDOW_MS);
  const claim: Claim = {
    scope: { kind: "platform" },
    alertId: 0,
    code: "SIMULATION",
    subjectKey: "-",
    severity: "MEDIUM",
    detail: {},
    openedAt: now,
    kind: "open",
    notifyCount: 1,
    claimedAt: now,
    previousNotifiedAt: null,
  };
  const sent = await sendDigest([claim], channel, { simulation: true, idempotencyKey: `acctops-sim:${window}` });
  if (sent.status !== "sent") {
    return NextResponse.json({ ok: false, simulated: true, notification: "failed", code: sent.status === "failed" ? sent.code : "none" }, { status: 500 });
  }
  // The provider's message id lets the operator find this very message in the provider's log.
  return NextResponse.json({ ok: true, simulated: true, notification: "sent", providerMessageId: sent.providerMessageId }, { status: 200 });
}

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "monitor_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (req.method === "POST" && new URL(req.url).searchParams.get("simulate") === "1") return simulate(new Date());

  if (process.env.ACCOUNTANT_MONITOR_ENABLED?.trim() !== "true") {
    return NextResponse.json({ ok: true, enabled: false }, { status: 200 });
  }
  try {
    const result = await runAccountantMonitor(runSourceOf(req.method));
    return NextResponse.json({ ok: result.ok, enabled: true, notification: result.notification, counts: result.counts }, { status: result.ok ? 200 : 500 });
  } catch (error) {
    console.error("[accountant-monitor] run failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "monitor_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET; the GitHub Actions watchdog POSTs. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
