/**
 * The phone VERIFICATION message (messageClass VERIFICATION) — the send API workstream G (OTP / secure self-service)
 * calls. SERVER-ONLY.
 *
 *   sendBookingVerificationCode({ businessId, challengeId, sendIndex, phone, code })
 *
 * Call it AFTER the challenge's own transaction committed (it opens its own tenant transactions; never inside
 * another one). It:
 *   1. refuses when customer WhatsApp is hard-stopped (WHATSAPP_PLATFORM_SEND_MODE=off → 'send_stopped', nothing
 *      written) or the business may not message customers (customer-entitlement.ts → 'not_entitled');
 *   2. records ONE logical message — Notification `wa:verify:c<challengeId>:s<sendIndex>` + its CUSTOMER delivery
 *      (template dubiz_booking_code, AUTHENTICATION — owner decision D1: Meta's fixed text and copy-code button, the
 *      code its only parameter; the business is named on the verification screen, not in the message;
 *      expiresAt = now + 5 minutes) — and takes the row's lease and the attempt fence at once, so the worker's lane
 *      never sends it (the code is NEVER stored: not in the row, not in the notification, not in a log);
 *      a repeat of the same (challengeId, sendIndex) sends nothing: { ok: false, reason: "duplicate" };
 *   3. sends it through the platform transport (simulated unless live + credentials), aborted before the lease ends;
 *   4. records the outcome on THE SAME ROW: SENT + providerMessageId; FAILED otherwise — never retried by the lane (a
 *      new code is the customer's "send again", a new sendIndex: G's cooldown and caps decide). An UNCERTAIN send
 *      (timeout, 5xx) is FAILED 'uncertain:<token>' and answered 'send_failed'; if Meta did accept it, its status
 *      webhook later records it SENT (metering stays exact) — it is never resent by us.
 * Counted by usage.ts like every customer message (messageClass VERIFICATION, apart from OPERATIONAL).
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { toE164 } from "./appointment-messages";
import { customerMessagesEntitlement } from "./customer-entitlement";
import { notifyCustomer } from "./notify-customer";
import { platformSendStopped, sendPlatformTemplate, type TransportDeps, type TransportResult } from "./platform-transport";
import { fence, sendDeadlineMs, WA_LEASE_MS } from "./whatsapp-worker";
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
  | { ok: false; reason: "invalid_input" | "not_entitled" | "duplicate" | "send_failed" | "send_stopped"; deliveryId?: number };

export const VERIFICATION_TTL_MS = 5 * 60_000;

export async function sendBookingVerificationCode(
  input: VerificationSendInput,
  deps: { transport?: TransportDeps; entitled?: (businessId: number) => Promise<boolean>; clock?: () => number } = {},
): Promise<VerificationSendResult> {
  const now = input.now ?? new Date();
  const clock = deps.clock ?? Date.now;
  const phone = toE164(input.phone);
  if (
    !Number.isInteger(input.businessId) || input.businessId <= 0 || !Number.isInteger(input.challengeId) || input.challengeId <= 0 ||
    !Number.isInteger(input.sendIndex) || input.sendIndex < 1 || input.sendIndex > 1000 || !phone || !/^[0-9]{4,8}$/.test(input.code)
  ) {
    return { ok: false, reason: "invalid_input" };
  }
  if (platformSendStopped(deps.transport?.env ?? process.env)) return { ok: false, reason: "send_stopped" };
  const entitled = deps.entitled ? await deps.entitled(input.businessId) : (await customerMessagesEntitlement(input.businessId)).allowed;
  if (!entitled) return { ok: false, reason: "not_entitled" };

  const template = WHATSAPP_TEMPLATES.booking_code;
  const lease = new Date(now.getTime() + WA_LEASE_MS);
  const token = fence.newToken();
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
    await tx.notificationDelivery.updateMany({
      where: { id: r.deliveryId, businessId: input.businessId, status: "PENDING" },
      data: { leaseUntil: lease, error: fence.inflight(token), attemptedAt: now },
    });
    return { duplicate: false as const, deliveryId: r.deliveryId };
  });
  if (prepared.duplicate) return { ok: false, reason: "duplicate", deliveryId: prepared.deliveryId };
  const claimedAtMs = clock();

  const params = buildTemplateParams(template, { code: input.code });
  const deadline = sendDeadlineMs(claimedAtMs, clock());
  const result: TransportResult = !params
    ? { kind: "permanent", code: "template_params" }
    : deadline === null
      ? { kind: "transient", code: "lease_short" }
      : await sendPlatformTemplate({
          toPhone: phone, templateName: template.name, languageCode: template.language, bodyParams: params,
          urlButtonParam: input.code, callbackData: fence.callback(input.businessId, prepared.deliveryId, token), signal: AbortSignal.timeout(deadline),
        }, deps.transport ?? {}).catch((): TransportResult => ({ kind: "uncertain", code: "transport_threw" }));

  await tenantTx(input.businessId, async (tx) => {
    const where = { id: prepared.deliveryId, businessId: input.businessId, status: "PENDING" as const, error: fence.inflight(token) };
    if (result.kind === "sent") {
      await tx.notificationDelivery.updateMany({
        where: { ...where, providerMessageId: null },
        data: { status: "SENT", providerMessageId: result.providerMessageId, attempts: 1, error: null, completedAt: now, leaseUntil: null },
      });
    } else {
      const error = result.kind === "uncertain" ? fence.uncertain(token) : result.kind === "stopped" ? "send_stopped" : `${result.kind}:${result.code}`.slice(0, 64);
      await tx.notificationDelivery.updateMany({ where, data: { status: "FAILED", attempts: 1, error, completedAt: now, leaseUntil: null } });
    }
  });
  if (result.kind === "stopped") return { ok: false, reason: "send_stopped", deliveryId: prepared.deliveryId };
  if (result.kind !== "sent") return { ok: false, reason: "send_failed", deliveryId: prepared.deliveryId };
  return { ok: true, deliveryId: prepared.deliveryId, providerMessageId: result.providerMessageId, simulated: result.simulated };
}
