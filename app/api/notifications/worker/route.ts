import { NextRequest, NextResponse } from "next/server";

import { runPushWorker } from "@/lib/notifications/engine/push-worker";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * The notification engine's push worker (notifications track PR 3) — the CRON_SECRET path behind the
 * after()-response trigger.
 *
 * Authority: CRON_SECRET through decideCronAuth — never a user session, never a tenant from the caller. Sends the
 * owed pushes notification_push_due() lists, each claimed under a lease in its own business's tenant transaction,
 * only where notifications_engine is ON (and, for the Android app, the FCM configuration exists). Idempotent: a
 * racing pass loses the claim. Counts only in the answer and the log.
 *
 * NOT scheduled in vercel.json: scheduling it is a separate owner decision.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "worker_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const out = await runPushWorker(new Date());
    return NextResponse.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[notifications] worker failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "worker_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
