/**
 * The phone VERIFICATION message (messageClass VERIFICATION) — the send API workstream G (OTP / secure self-service)
 * calls. SERVER-ONLY.
 *
 *   sendBookingVerificationCode({ businessId, challengeId, sendIndex, phone, code })
 *
 * Call it AFTER the challenge's own transaction committed (it opens its own tenant transactions; never inside
 * another one). It:
 *   1. checks the business may message customers (customer-entitlement.ts — `appointments` + `public_booking`);
 *   2. records ONE logical message — Notification `wa:verify:c<challengeId>:s<sendIndex>` + its CUSTOMER delivery
 *      (template dubiz_booking_code, expiresAt = now + 5 minutes) — and takes the row's lease at once, so the worker's
 *      lane never sends it (the code is NEVER stored: not in the row, not in the notification, not in a log);
 *      a repeat of the same (challengeId, sendIndex) sends nothing: { ok: false, reason: "duplicate" };
 *   3. sends it through the platform transport (simulated unless live + credentials) with the business's name and
 *      the code; 4. records the outcome on THE SAME ROW: SENT + providerMessageId, or FAILED (never retried by the lane —
 *      a new code is the customer's "send again", which is a new sendIndex: G's resend cooldown and caps decide).
 * Counted by usage.ts like every customer message (messageClass VERIFICATION, apart from OPERATIONAL).
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { toE164 } from "./appointment-messages";
import { customerMessagesEntitlement } from "./customer-entitlement";
import { notifyCustomer } from "./notify-customer";
import { sendPlatformTemplate, type TransportDeps, type TransportResult } from "./platform-transport";
import { WA_LEASE_MS } from "./whatsapp-worker";
import { buildTemplateParams, WHATSAPP_TEMPLATES } from "./whatsapp-templates";

export type VerificationSendInput = {
  businessId: number;
  /** BookingPhoneChallenge.id. */
  challengeId: number;
  /** 1 for the first code of the challenge, then 2, 3 … for each resend (BookingPhoneChallenge.sends after increment). */
  sendIndex: number;
  /** The customer's phone, as entered or stored (normalized here to E.164). */
  phone: string;
  /** The plain code (4–8 digits). Used for this send only; never stored or logged. */
  code: string;
  now?: Date;
};

export type VerificationSendResult =
  | { ok: true; deliveryId: number; providerMessageId: string; simulated: boolean }
  | { ok: false; reason: "invalid_input" | "not_entitled" | "duplicate" | "send_failed"; deliveryId?: number };

export const VERIFICATION_TTL_MS = 5 * 60_000;

export async function sendBookingVerificationCode(
  input: VerificationSendInput,
  deps: { transport?: TransportDeps; entitled?: (businessId: number) => Promise<boolean> } = {},
): Promise<VerificationSendResult> {
  const now = input.now ?? new Date();
  const phone = toE164(input.phone);
  if (
    !Number.isInteger(input.businessId) || input.businessId <= 0 || !Number.isInteger(input.challengeId) || input.challengeId <= 0 ||
    !Number.isInteger(input.sendIndex) || input.sendIndex < 1 || input.sendIndex > 1000 || !phone || !/^[0-9]{4,8}$/.test(input.code)
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  const entitled = deps.entitled ? await deps.entitled(input.businessId) : (await customerMessagesEntitlement(input.businessId)).allowed;
  if (!entitled) return { ok: false, reason: "not_entitled" };

  const template = WHATSAPP_TEMPLATES.booking_code;
  const lease = new Date(now.getTime() + WA_LEASE_MS);
  const prepared = await tenantTx(input.businessId, async (tx) => {
    const r = await notifyCustomer(tx, {
      businessId: input.businessId,
      category: "appointments.customer_verification",
      entity: { type: "booking_phone_challenge", id: input.challengeId },
      dedupeKey: `wa:verify:c${input.challengeId}:s${input.sendIndex}`,
      recipientPhone: phone,
      templateKey: template.name,
      appointmentId: null,
      now,
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    });
    if (r.kind !== "created") return { duplicate: true as const, deliveryId: r.deliveryId ?? undefined };
    await tx.notificationDelivery.updateMany({ where: { id: r.deliveryId, businessId: input.businessId, status: "PENDING" }, data: { leaseUntil: lease } });
    const business = await tx.business.findFirst({ where: { id: input.businessId }, select: { name: true } });
    return { duplicate: false as const, deliveryId: r.deliveryId, businessName: business?.name ?? "" };
  });
  if (prepared.duplicate) return { ok: false, reason: "duplicate", deliveryId: prepared.deliveryId };

  const params = buildTemplateParams(template, { business: prepared.businessName, code: input.code });
  const result: TransportResult = params
    ? await sendPlatformTemplate({ toPhone: phone, templateName: template.name, languageCode: template.language, bodyParams: params }, deps.transport ?? {})
        .catch((): TransportResult => ({ kind: "transient", code: "transport_threw" }))
    : { kind: "permanent", code: "template_params" };

  await tenantTx(input.businessId, async (tx) => {
    if (result.kind === "sent") {
      await tx.notificationDelivery.updateMany({
        where: { id: prepared.deliveryId, businessId: input.businessId, status: "PENDING", providerMessageId: null },
        data: { status: "SENT", providerMessageId: result.providerMessageId, attempts: 1, completedAt: now, leaseUntil: null },
      });
    } else {
      await tx.notificationDelivery.updateMany({
        where: { id: prepared.deliveryId, businessId: input.businessId, status: "PENDING", leaseUntil: lease },
        data: { status: "FAILED", attempts: 1, error: `${result.kind}:${result.code}`.slice(0, 64), completedAt: now, leaseUntil: null },
      });
    }
  });
  if (result.kind !== "sent") return { ok: false, reason: "send_failed", deliveryId: prepared.deliveryId };
  return { ok: true, deliveryId: prepared.deliveryId, providerMessageId: result.providerMessageId, simulated: result.simulated };
}
