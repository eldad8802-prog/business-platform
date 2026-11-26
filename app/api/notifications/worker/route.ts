import { NextRequest, NextResponse } from "next/server";

import { cutoverDryRun } from "@/lib/notifications/engine/cutover-dry-run";
import { runPushWorker, workerHealth } from "@/lib/notifications/engine/push-worker";
import { platformConfig } from "@/lib/notifications/customer/platform-transport";
import { purgeCustomerPhones } from "@/lib/notifications/customer/retention";
import { runWhatsAppWorker } from "@/lib/notifications/customer/whatsapp-worker";
import { decideCronAuth } from "@/lib/services/billing/settlement/settlement-recovery-auth";

/**
 * The notification engine's push worker (notifications track PR 3) — the CRON_SECRET path behind the
 * after()-response trigger.
 *
 * Authority: CRON_SECRET through decideCronAuth — never a user session, never a tenant from the caller. Sends the
 * owed pushes notification_push_due() lists, each claimed under a lease in its own business's tenant transaction,
 * only where notifications_engine is ON (and, for the Android app, the FCM configuration exists). Idempotent: a
 * racing pass loses the claim. Counts only in the answer and the log (with a `health` block: the unhealthy signal,
 * expired and pre_cutover counts). GET ?dryRun=cutover answers the READ-ONLY clean-start dry run instead.
 *
 * Scheduled in vercel.json since the engine opened for every business (owner decision 2026-11-23).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runCustomerLane(now: Date) {
  try {
    const lane = await runWhatsAppWorker(now);
    const phonesErased = await purgeCustomerPhones(now);
    return { ...lane, phonesErased, mode: platformConfig().mode };
  } catch (error) {
    console.error("[notifications] whatsapp lane failed", { error: error instanceof Error ? error.name : "unknown" });
    return { error: "whatsapp_lane_failed" };
  }
}

async function handle(req: NextRequest) {
  const decision = decideCronAuth(req.headers.get("authorization"));
  if (decision === "NOT_CONFIGURED") return NextResponse.json({ error: "worker_not_configured" }, { status: 503 });
  if (decision !== "AUTHORIZED") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // READ-ONLY clean-start dry run (GET ?dryRun=cutover): per business, counts of the owed pushes an activation
    // would close ('pre_cutover' / 'expired') vs let proceed. Nothing is claimed, leased or written.
    if (req.method === "GET" && req.nextUrl.searchParams.get("dryRun") === "cutover") {
      const dry = await cutoverDryRun(new Date());
      return NextResponse.json({ ok: true, dryRun: "cutover", ...dry }, { headers: { "Cache-Control": "no-store" } });
    }
    const out = await runPushWorker(new Date());
    // G1 — the WHATSAPP lane (customer messages; simulated unless WHATSAPP_PLATFORM_SEND_MODE=live + credentials) and
    // the customer-phone retention sweep. AFTER the push lane and isolated from it: a lane failure never changes the
    // push answer above (`whatsapp: { error }` instead).
    const whatsapp = await runCustomerLane(new Date());
    return NextResponse.json({ ok: true, ...out, health: workerHealth(out), whatsapp }, { headers: { "Cache-Control": "no-store" } });
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
