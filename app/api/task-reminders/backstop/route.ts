import { NextRequest, NextResponse } from "next/server";

import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { BACKSTOP_LAG_MINUTES, dispatchDueReminders } from "@/lib/services/tasks/task-reminders.service";

/**
 * Reminder backstop — the independent second path for personal-task reminders, for when QStash (the per-reminder
 * messages and the 5-minute schedule that call /api/task-reminders/dispatch) is late or down.
 *
 * Authority: CRON_SECRET through decideCronAuth (Vercel cron / a watchdog) — never a user session, never a tenant
 * from the caller. It runs the SAME dispatcher with a lag (BACKSTOP_LAG_MINUTES): only reminders already that late
 * are picked up, so while QStash is healthy it finds nothing; when both paths do run, each reminder's claim has one
 * winner, so nothing is sent twice. Counts only in the answer and the log.
 *
 * NOT scheduled in vercel.json: scheduling it is a separate owner decision.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "backstop_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const out = await dispatchDueReminders(new Date(), { minLagMinutes: BACKSTOP_LAG_MINUTES });
    if (out.due > 0) console.warn("[tasks] reminder backstop picked up late reminders", { due: out.due, sent: out.sent });
    return NextResponse.json({ ok: true, via: "backstop", ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[tasks] reminder backstop failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "backstop_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
