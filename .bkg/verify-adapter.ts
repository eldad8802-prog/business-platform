/**
 * Lab adapter for the mandatory phone verification (appointments completion G2 / owner requirement 8) — for the
 * batteries and seeds that open the public booking link or submit through it IN-PROCESS (.bkg/app-battery.ts,
 * .appt/open-all-battery.ts, .appt/ui-seed.ts, .appt/redesign-server-battery.ts, .bkg/demo-seed.ts, B's
 * .appt/engine-correctness-battery.ts). Synthetic labs only — never Production.
 *
 *   - the WhatsApp delivery path is declared available (the door and "turn the link on" need it; the transport stays
 *     simulated, nothing is sent);
 *   - forBusiness / forLink write, AS THE OWNER ROLE, a verified BookingPhoneChallenge for the phone and return its
 *     verification token — exactly what a customer who typed the right code holds. The submit then checks and consumes
 *     it for real (one token = one request, as in Production).
 *
 * The verification flow itself (codes, caps, attempts, isolation) is proven by lib/services/booking/phone-verification.db.test.ts.
 * Import it dynamically AFTER the battery has set its env (TASK_REQUEST_HMAC_KEY):
 *   const { bookingVerificationAdapter } = await import("../.bkg/verify-adapter");
 *   const verified = await bookingVerificationAdapter(owner);
 *   … body: { …, verificationToken: await verified.forBusiness(businessId, phone) }
 */
import type { PrismaClient } from "@prisma/client";

export type BookingVerificationAdapter = {
  /** A verified phone for `businessId` → its token (undefined for a phone the form would refuse anyway). */
  forBusiness: (businessId: number, rawPhone: unknown) => Promise<string | undefined>;
  /** The same, by the business's public link id (undefined for an unknown link). */
  forLink: (publicId: string, rawPhone: unknown) => Promise<string | undefined>;
};

export async function bookingVerificationAdapter(owner: PrismaClient): Promise<BookingVerificationAdapter> {
  const { parsePublicPhone } = await import("@/lib/services/booking/booking.core");
  const { phoneHashOf, verificationTokenOf, otpKeysFromEnv } = await import("@/lib/services/booking/phone-verification.core");
  const { toE164 } = await import("@/lib/notifications/customer/appointment-messages");
  const { __setOtpTestHooks } = await import("@/lib/services/booking/phone-verification.service");
  __setOtpTestHooks({ deliveryAvailable: () => true });

  const forBusiness = async (businessId: number, rawPhone: unknown): Promise<string | undefined> => {
    const digits = parsePublicPhone(rawPhone);
    const e164 = digits ? toE164(digits) : null;
    if (!e164) return undefined;
    const keys = otpKeysFromEnv();
    const t0 = new Date();
    const c = await owner.bookingPhoneChallenge.create({
      data: {
        businessId, phoneHash: phoneHashOf(keys.current, e164), codeHash: "0".repeat(64), attempts: 1, sends: 1,
        createdAt: t0, expiresAt: new Date(t0.getTime() + 300_000), verifiedAt: t0,
      },
      select: { id: true, verifiedAt: true },
    });
    return verificationTokenOf(keys.current, businessId, c.id, c.verifiedAt as Date);
  };

  const bizOfLink = new Map<string, number>();
  const forLink = async (publicId: string, rawPhone: unknown): Promise<string | undefined> => {
    let biz = bizOfLink.get(publicId);
    if (biz === undefined) {
      const row = await owner.bookingSettings.findFirst({ where: { publicId }, select: { businessId: true } });
      if (!row) return undefined;
      biz = row.businessId;
      bizOfLink.set(publicId, biz);
    }
    return forBusiness(biz, rawPhone);
  };

  return { forBusiness, forLink };
}
