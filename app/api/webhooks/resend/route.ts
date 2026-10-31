import { NextResponse } from "next/server";

import { applyProviderEvent, recordProviderComplaint, type ProviderEvent } from "@/lib/accountant/delivery.service";
import { surfaceComplaintNotice, syncPeriodNotice } from "@/lib/accountant/notify";
import { verifySvix } from "@/lib/intake/acquisition/signatures";
import { prisma } from "@/lib/prisma";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { runTenantJob } from "@/lib/tenant/job";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENTS: Record<string, ProviderEvent | "complained"> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

/**
 * POST — Resend delivery events (D5). Authenticated by the Svix signature with RESEND_WEBHOOK_SECRET;
 * without the secret the endpoint refuses everything (503). `delivered` and `bounced` change the delivery's
 * state; `complained` (the recipient marked the email as spam — G5 milestone 1) is recorded as an audit event and
 * an in-app notice to the owner, and changes no status. Every other event is acknowledged and ignored. The message
 * id is mapped to a delivery by a SECURITY DEFINER lookup (ids only); the update runs under RLS in that business.
 * Messages that are not accountant deliveries (account emails, operator alerts) are acknowledged and ignored.
 *
 * Duplicates and late or out-of-order events are harmless: a status moves only along the allowed transitions
 * (ACCEPTED → DELIVERED, ACCEPTED/DELIVERED → BOUNCED) and every trail event has a per-delivery idempotency key.
 * A database failure answers 500, so Resend retries the same event.
 */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });

  const raw = await req.text();
  if (raw.length > 64 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const now = new Date();
  const verified = verifySvix(
    raw,
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    secret,
    now
  );
  if (!verified) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  let payload: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: true, ignored: "malformed" });
  }
  const event = typeof payload.type === "string" ? EVENTS[payload.type] : undefined;
  const messageId = payload.data?.email_id;
  if (!event || typeof messageId !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(messageId)) {
    return NextResponse.json({ ok: true, ignored: "event" });
  }

  const at = typeof payload.created_at === "string" && !Number.isNaN(Date.parse(payload.created_at)) ? new Date(payload.created_at) : now;
  try {
    const rows = await prisma.$queryRaw<Array<{ businessId: number; deliveryId: number }>>`
      SELECT "businessId", "deliveryId" FROM public.accountant_delivery_by_provider_message(${"resend"}, ${messageId})`;
    const hit = rows[0];
    if (!hit) return NextResponse.json({ ok: true, ignored: "unknown_message" });

    await runTenantJob({ businessId: hit.businessId }, async () => {
      if (event === "complained") {
        const r = await recordProviderComplaint(hit.businessId, hit.deliveryId, at);
        if (!r?.recorded) return;
        const period = await tenantTx(hit.businessId, (tx) =>
          tx.accountantPeriod.findFirst({ where: { id: r.periodId, businessId: hit.businessId }, select: { periodKey: true } })
        );
        if (period) await surfaceComplaintNotice({ businessId: hit.businessId, deliveryId: hit.deliveryId, periodKey: period.periodKey }, now);
        return;
      }
      const changed = await applyProviderEvent(hit.businessId, hit.deliveryId, event, at);
      if (!changed) return;
      const d = await tenantTx(hit.businessId, (tx) =>
        tx.accountantDelivery.findFirst({ where: { id: hit.deliveryId, businessId: hit.businessId }, select: { periodId: true } })
      );
      const period = d
        ? await tenantTx(hit.businessId, (tx) => tx.accountantPeriod.findFirst({ where: { id: d.periodId, businessId: hit.businessId } }))
        : null;
      if (period) await syncPeriodNotice(period, now);
    });
  } catch (e) {
    if (e instanceof BusinessQuarantinedError) return NextResponse.json({ ok: true, ignored: "quarantined" });
    console.error("[resend-webhook] apply failed", { error: e instanceof Error ? e.name : "unknown" });
    // 500 → Resend retries; every step is idempotent.
    return NextResponse.json({ error: "apply_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
