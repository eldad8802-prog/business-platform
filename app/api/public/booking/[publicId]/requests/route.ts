import { submitPublicRequest } from "@/lib/services/booking/public-booking.service";
import { jsonBodyOf, limitBusiness, LimitResponse, publicJson, publicRoute } from "@/lib/services/booking/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ publicId: string }> };

/**
 * POST — a booking request (Idempotency-Key: UUIDv7). No session. Rate limited per IP and per business (D11, fail
 * closed); everything else is decided by the server under the business's appointment lock.
 */
export async function POST(req: Request, { params }: Params) {
  return publicRoute(req, "PUBLIC_BOOKING_SUBMIT", async () => {
    const key = req.headers.get("idempotency-key") ?? "";
    const body = await jsonBodyOf(req);
    try {
      const out = await submitPublicRequest((await params).publicId, body, key, undefined, {
        beforeWrite: (businessId) => limitBusiness("PUBLIC_BOOKING_SUBMIT_BUSINESS", businessId),
      });
      return publicJson(out, out.replayed ? 200 : 201);
    } catch (e) {
      if (e instanceof LimitResponse) return e.response;
      throw e;
    }
  });
}
