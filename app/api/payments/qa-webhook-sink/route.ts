import { NextResponse } from "next/server";
import {
  QA_WEBHOOK_SUPPRESSION_FLAG,
  QA_WEBHOOK_SUPPRESSION_VALUE,
} from "@/lib/services/payments/qa-webhook-suppression";

/**
 * M1 Production proof only — the callback that is delivered and discarded.
 *
 * The QA tenant's checkouts (and only those, while the flag is on) are issued
 * with this path as CardCom's WebHookUrl. It accepts the callback with 200, so
 * from CardCom's side delivery succeeded, and does NOTHING with it: the body
 * is never read, nothing is parsed, verified, stored or logged, no provider is
 * asked, no payment code runs. The payment can then be recorded only by inbound
 * reconciliation — which is what the proof is about.
 *
 * With the flag off it answers 404, as if it did not exist.
 *
 * It is deliberately NOT a webhook: it cannot reach processPaymentWebhook, the
 * payment store or the database (it imports none of them — pinned by
 * qa-webhook-suppression.test.ts). Normal callbacks keep using
 * /api/payments/webhook/cardcom, unchanged.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sinkOpen(): boolean {
  return (process.env[QA_WEBHOOK_SUPPRESSION_FLAG] ?? "").trim() === QA_WEBHOOK_SUPPRESSION_VALUE;
}

export async function POST() {
  if (!sinkOpen()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  console.info("[qa-webhook-sink] callback discarded");
  return NextResponse.json({}, { status: 200 });
}
