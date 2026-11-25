/**
 * Can this business turn its public booking link on? (G3 — eligibility and self-activation, appointments completion
 * program, workstream G.) SERVER-ONLY.
 *
 * The owner turns the link on by themself ("self-activation") once EVERYTHING below holds — checked server-side when
 * the switch is turned on (booking-admin.service updateBookingSettings), and shown on the settings screen as a list:
 *   eligible   the business may offer the link: `appointments` AND `public_booking` available to it through the
 *              existing feature-access resolver (flags, admin overrides, emergency switch — the same answer guardFeature
 *              / featureAllowedForBusiness give), with the plan layer (resolvePlanEntitlement: plan ADVANCED, trial =
 *              full) computed in SHADOW and logged (`subscription_would_deny`), never enforced here — the owner's
 *              subscriptions stage C decision (customer-entitlement.ts, shared with workstream F);
 *   hours      the business's own weekly hours exist (the link only ever offers times inside them);
 *   services   at least one service is open to the link with a length and a lane that may take it;
 *   whatsapp   a platform WhatsApp path that can DELIVER the verification code is available (live mode with the
 *              platform's credentials — not before Meta approves the central number). Without it the link would be a
 *              dead end, since …
 *   verification is MANDATORY for every business (owner requirement 8) — not a check that can fail, a rule: it is
 *              enforced at submit time whatever BookingSettings.requireVerification holds, and this module never reads
 *              or writes that column (existing rows keep their stored value untouched).
 * The public_booking flag itself is never changed here.
 */
import { customerMessagesEntitlement } from "@/lib/notifications/customer/customer-entitlement";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { otpDeliveryAvailable } from "./phone-verification.service";
import { publicCatalog } from "./public-booking.service";

export type ReadinessItem = "eligible" | "hours" | "services" | "whatsapp";
export type BookingReadiness = { ready: boolean; missing: ReadinessItem[]; verification: "required" };

export async function bookingLinkReadiness(businessId: number): Promise<BookingReadiness> {
  const missing: ReadinessItem[] = [];
  const eligible = (await customerMessagesEntitlement(businessId)).allowed;
  if (!eligible) missing.push("eligible");
  const { hours, services } = await tenantTx(businessId, async (tx) => ({
    hours: (await tx.availabilityRule.count({ where: { businessId, staffMemberId: null, removedAt: null } })) > 0,
    services: (await publicCatalog(tx, businessId)).services.length > 0,
  }));
  if (!hours) missing.push("hours");
  if (!services) missing.push("services");
  if (!otpDeliveryAvailable()) missing.push("whatsapp");
  return { ready: missing.length === 0, missing, verification: "required" };
}
