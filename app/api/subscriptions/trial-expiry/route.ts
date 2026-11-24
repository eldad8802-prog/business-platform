import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";
import { trialConfig } from "@/lib/services/subscriptions/trial/trial-claims";

/**
 * Subscriptions stage C — the trial-expiry RECORDER. The state itself is already computed from trialEndsAt (a TRIALING
 * record whose trial ended reads as FREE_LIMITED everywhere — resolve-entitlement.ts, usage_quota_context); this run
 * only writes the transition and its log row (subscription_expire_due_trials, migration 20261228090000), so the admin
 * console and the history show it.
 *
 * Authority: CRON_SECRET through decideCronAuth — never a user session, never a business from the caller. The
 * database function can move ONLY TRIALING customer records whose trial already ended; it takes no business id.
 * Off (404) unless trials are switched on (SUBSCRIPTION_TRIALS_ENABLED): with trials off there is nothing to expire.
 * Bounded: at most 200 per call, 5 passes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "sweep_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!trialConfig()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    let expired = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      const rows = await prisma.$queryRaw<{ n: number }[]>`SELECT public.subscription_expire_due_trials(200) AS n`;
      const n = Number(rows[0]?.n ?? 0);
      expired += n;
      if (n < 200) break;
    }
    console.info(JSON.stringify({ event: "subscription_trials_expired", expired }));
    return NextResponse.json({ ok: true, expired }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[subscriptions] trial expiry failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "sweep_failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
