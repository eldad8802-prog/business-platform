import { verifyPublicCode } from "@/lib/services/booking/public-booking.service";
import { jsonBodyOf, publicJson, publicRoute } from "@/lib/services/booking/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ publicId: string }> };

/**
 * POST { phone, code } — check the code (G2). No session. Rate limited per IP (PUBLIC_BOOKING_OTP_VERIFY, fail
 * closed) on top of the challenge's own 5-attempt limit. A wrong, expired, used or replaced code is one answer
 * (OTP_INVALID); a right one returns the verification token the request must carry.
 */
export async function POST(req: Request, { params }: Params) {
  return publicRoute(req, "PUBLIC_BOOKING_OTP_VERIFY", async () => {
    const body = await jsonBodyOf(req);
    return publicJson(await verifyPublicCode((await params).publicId, { phone: body.phone, code: body.code }));
  });
}
