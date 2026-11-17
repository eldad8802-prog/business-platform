import { NextRequest, NextResponse } from "next/server";

import { runDailyDigest } from "@/lib/notifications/engine/digest";
import { DIGEST_CADENCE_MS } from "@/lib/notifications/engine/schedule";
import { runPushWorker } from "@/lib/notifications/engine/push-worker";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * The daily digest (notifications track PR 3): per business where notifications_engine is ON, per user whose local
 * digest minute (default 08:00 business time) has come — once a day (the dedupe key), never empty, never repeating
 * what was already pushed. Then one push worker pass sends the digests it wrote.
 *
 * Authority: CRON_SECRET through decideCronAuth. Counts only in the answer and the log.
 * Scheduled by vercel.json every 15 min (notify/10-schedule — the ONE branch that activates scheduling;
 * docs/notifications/scheduling.md): each pass decides per business / user whether the local digest minute has come
 * and no digest exists yet that local day (the unique dedupe key — overlapping passes write one digest). Each pass is
 * the stateless rotation over the live businesses under a 40 s budget: a business not reached at 08:00 is reached by a
 * later pass that morning (due = the local clock has REACHED the minute).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop starting businesses after 40 s: the digests written still get their worker pass inside maxDuration. */
const BUDGET_MS = 40_000;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "digest_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const now = new Date();
    const digest = await runDailyDigest(now, { budgetMs: BUDGET_MS, rotation: { cadenceMs: DIGEST_CADENCE_MS } });
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
