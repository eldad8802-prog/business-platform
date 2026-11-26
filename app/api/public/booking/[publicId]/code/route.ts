import { requestPublicCode } from "@/lib/services/booking/public-booking.service";
import { jsonBodyOf, publicJson, publicRoute } from "@/lib/services/booking/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ publicId: string }> };

/**
 * POST { phone } — send a WhatsApp verification code to the phone (G2, design c). No session. Rate limited per IP
 * (PUBLIC_BOOKING_OTP_SEND, fail closed), then the platform-wide and per-business send caps and the resend cooldown
 * (phone-verification.service.ts). The answer never says whether the phone has bookings.
 */
export async function POST(req: Request, { params }: Params) {
  return publicRoute(req, "PUBLIC_BOOKING_OTP_SEND", async ({ ip }) => {
    const body = await jsonBodyOf(req);
    return publicJson(await requestPublicCode((await params).publicId, { phone: body.phone }, { ip }));
  });
}
