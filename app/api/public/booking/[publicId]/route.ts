import { getPublicProfile } from "@/lib/services/booking/public-booking.service";
import { publicJson, publicRoute } from "@/lib/services/booking/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ publicId: string }> };

/** GET — what the business chose to publish (D10) and its services open to booking. No session. 404 unless open. */
export async function GET(req: Request, { params }: Params) {
  return publicRoute(req, "PUBLIC_BOOKING_READ", async () => publicJson(await getPublicProfile((await params).publicId)));
}
