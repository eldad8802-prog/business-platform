import { NextRequest, NextResponse } from "next/server";

import { runStatusSweep } from "@/lib/notifications/producers/status-sweep";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * The notification status sweep (notifications track, coverage) — state-based notifications for facts that have a
 * policy rule but no producer (billing PDF failures / review, lead follow-ups, supplier purchases), plus a catch-up
 * of the inventory and documents-queue reconcilers. lib/notifications/producers/status-sweep.ts.
 *
 * Authority: CRON_SECRET through decideCronAuth — never a user session, never a tenant from the caller. Only
 * businesses where notifications_engine is ON, each in its own tenant context; reads derived state and writes
 * Notification rows through the existing writer only. Bounded: a time budget under maxDuration; when it ends the
 * pass the answer carries `nextAfter` — call again with ?after=<nextAfter>. Counts only in the answer and the log.
 *
 * NOT scheduled in vercel.json: scheduling it is a separate owner decision.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 45_000;

function parseAfter(raw: string | null): number | null {
  if (raw === null || raw === "") return 0;
  if (!/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : null;
}

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const after = parseAfter(req.nextUrl.searchParams.get("after"));
  if (after === null) return NextResponse.json({ error: "invalid_after" }, { status: 400 });
  try {
    const out = await runStatusSweep(new Date(), { after, budgetMs: BUDGET_MS });
    return NextResponse.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[notifications] status sweep failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
