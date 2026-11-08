import { NextRequest, NextResponse } from "next/server";

import { sweepAccountStorageErasures } from "@/lib/services/account/account-storage-erasure";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Account deletion — resumes the post-commit object stage (lib/services/account/account-storage-erasure.ts) for every
 * business being or already deleted: stored objects whose durable erasure jobs are still open (a storage outage
 * during the deletion itself, a crash between commit and the object stage) are deleted here, until each job is done.
 *
 * Called by the scheduler only — Vercel Cron (GET, hourly — vercel.json) — with the CRON_SECRET bearer through the
 * same dual-accept decision the other cron routes use. Never a user session, never a tenant supplied by the caller.
 * The answer is counts only — no business id, no key.
 *
 * Inert until switched on: unless ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED is exactly "true" the route answers 200
 * without touching the database or storage. Safe at any cadence and concurrently (every module's stage is idempotent).
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
  if (process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED?.trim() !== "true") {
    return NextResponse.json({ ok: true, enabled: false }, { status: 200 });
  }
  try {
    const summary = await sweepAccountStorageErasures({ budgetMs: 45_000 });
    // Open jobs are expected while storage is down; the sweep goes red only when a module failed outright.
    return NextResponse.json({ ok: summary.errors === 0, enabled: true, summary }, { status: summary.errors === 0 ? 200 : 500 });
  } catch (error) {
    console.error("[account-storage-erasure] sweep failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET; a manual or GitHub-scheduled call may POST. Same handler.
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
