import { NextRequest, NextResponse } from "next/server";

import { runFxRateFetch } from "@/lib/fx/fx-rates-run";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * Bank of Israel representative rates — fetch the last 10 days of USD/ILS and EUR/ILS and append what is new
 * to "FxRate" (lib/fx/fx-rates-run.ts). Storage only: nothing in the application converts money with these
 * rates yet.
 *
 * NOT SCHEDULED. No vercel.json cron entry exists for it; activation is an owner decision
 * (docs/i18n-multicurrency/FX-ACTIVATION-RUNBOOK.md).
 *
 * Who may call it: a scheduler holding CRON_SECRET (the same dual-accept decision as every cron route). Never a
 * user session; no input is read from the request.
 *   - CRON_SECRET not configured → 503; wrong / missing bearer → 401 (before anything else is revealed);
 *   - FX_RATES_FETCH_ENABLED !== "true" → 404 { error: "not_found" }: no fetch, no database access;
 *   - writer credential (FX_RATE_WRITER_DATABASE_URL) absent → 503: no fetch, nothing written;
 *   - otherwise the run summary (counts per pair); 500 when a pair failed (the scheduler goes red).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.FX_RATES_FETCH_ENABLED !== "true") return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const summary = await runFxRateFetch();
    if (!("pairs" in summary)) {
      return NextResponse.json({ ok: false, error: summary.error === "WRITER_NOT_CONFIGURED" ? "fx_rate_writer_not_configured" : "fx_rate_writer_misconfigured" }, { status: 503 });
    }
    return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
  } catch (error) {
    console.error("[fx-rates] run_failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ ok: false, error: "fx_rates_run_failed" }, { status: 500 });
  }
}

/** Vercel Cron invokes GET with the CRON_SECRET bearer. */
export async function GET(req: NextRequest) {
  return handle(req);
}

/** A manual / GitHub-dispatched run, same bearer. */
export async function POST(req: NextRequest) {
  return handle(req);
}
