import { NextRequest, NextResponse } from "next/server";

import { runDailyDigest } from "@/lib/notifications/engine/digest";
import { runPushWorker } from "@/lib/notifications/engine/push-worker";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * The daily digest (notifications track PR 3): per business where notifications_engine is ON, per user whose local
 * digest minute (default 08:00 business time) has come — once a day (the dedupe key), never empty, never repeating
 * what was already pushed. Then one push worker pass sends the digests it wrote.
 *
 * Authority: CRON_SECRET through decideCronAuth. Counts only in the answer and the log.
 * NOT scheduled in vercel.json: scheduling it is a separate owner decision.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "digest_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const now = new Date();
    const digest = await runDailyDigest(now);
    const worker = digest.digests > 0 ? await runPushWorker(now) : null;
    return NextResponse.json({ ok: true, digest, worker }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[notifications] digest failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "digest_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
