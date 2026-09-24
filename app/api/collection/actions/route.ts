import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import {
  isCollectionActionChannel,
  isCollectionActionType,
  recordCollectionAction,
} from "@/lib/services/collection/collection-action.service";

/**
 * M5 — the first write endpoint the collection feature has ever had for a reminder.
 *
 * Until now `/api/collection/**` was read-only apart from a settlement retry, because sharing a
 * reminder never left the browser. This gives that action somewhere to land.
 *
 * The tenant and the actor come from the session. The body supplies only WHAT was done, THROUGH what,
 * and about WHICH subject — and every subject id is verified against this tenant before anything is
 * written, because these columns are deliberately not foreign keys.
 *
 * FIRE AND FORGET, BY DESIGN. The caller records the action and carries on; a failure here must never
 * stop an owner from chasing their money. That is also why the response says nothing useful: there is
 * nothing for the UI to do with it.
 */
function optionalId(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  if (!isCollectionActionType(body.actionType)) {
    return NextResponse.json({ error: "unknown actionType" }, { status: 400 });
  }
  if (!isCollectionActionChannel(body.channel)) {
    return NextResponse.json({ error: "unknown channel" }, { status: 400 });
  }

  const customerId = optionalId(body.customerId);
  const paymentRequestId = optionalId(body.paymentRequestId);
  const billingDocumentId = optionalId(body.billingDocumentId);
  if (customerId === undefined || paymentRequestId === undefined || billingDocumentId === undefined) {
    return NextResponse.json({ error: "subject ids must be positive integers" }, { status: 400 });
  }

  try {
    const result = await recordCollectionAction({
      businessId: user.businessId,
      actorUserId: user.id,
      actionType: body.actionType,
      channel: body.channel,
      customerId,
      paymentRequestId,
      billingDocumentId,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error(
      "POST /api/collection/actions error:",
      error instanceof Error ? error.name : "unknown"
    );
    return NextResponse.json({ error: "Failed to record action" }, { status: 500 });
  }
}
