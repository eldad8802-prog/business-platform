import { NextResponse } from "next/server";

import { applyProviderEvent, type ProviderEvent } from "@/lib/accountant/delivery.service";
import { syncPeriodNotice } from "@/lib/accountant/notify";
import { verifySvix } from "@/lib/intake/acquisition/signatures";
import { prisma } from "@/lib/prisma";
import { BusinessQuarantinedError } from "@/lib/tenant/business-lifecycle";
import { runTenantJob } from "@/lib/tenant/job";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENTS: Record<string, ProviderEvent> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
};

/**
 * POST — Resend delivery events (D5). Authenticated by the Svix signature with RESEND_WEBHOOK_SECRET;
 * without the secret the endpoint refuses everything (503). Only `delivered` and `bounced` change state;
 * every other event is acknowledged and ignored. The message id is mapped to a delivery by a SECURITY
 * DEFINER lookup (ids only); the update runs under RLS in that business. Messages that are not
 * accountant deliveries (account emails) are acknowledged and ignored.
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

  const rows = await prisma.$queryRaw<Array<{ businessId: number; deliveryId: number }>>`
    SELECT "businessId", "deliveryId" FROM public.accountant_delivery_by_provider_message(${"resend"}, ${messageId})`;
  const hit = rows[0];
  if (!hit) return NextResponse.json({ ok: true, ignored: "unknown_message" });

  const at = typeof payload.created_at === "string" && !Number.isNaN(Date.parse(payload.created_at)) ? new Date(payload.created_at) : now;
  try {
    await runTenantJob({ businessId: hit.businessId }, async () => {
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
    // 500 → Resend retries; the update is idempotent.
    return NextResponse.json({ error: "apply_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
