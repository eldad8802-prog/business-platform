import { getPublicSlots } from "@/lib/services/booking/public-booking.service";
import { publicJson, publicRoute } from "@/lib/services/booking/public-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ publicId: string }> };

const intOrNull = (v: string | null) => (v === null || v === "" ? null : /^\d{1,9}$/.test(v) ? Number(v) : v);

/** GET ?serviceId=&staffId=&fromDay=&toDay= — free start times from the calendar's own engine. No session. */
export async function GET(req: Request, { params }: Params) {
  return publicRoute(req, "PUBLIC_BOOKING_READ", async () => {
    const q = new URL(req.url).searchParams;
    return publicJson(await getPublicSlots((await params).publicId, {
      serviceId: intOrNull(q.get("serviceId")),
      staffId: intOrNull(q.get("staffId")),
      fromDay: q.get("fromDay") ?? undefined,
      toDay: q.get("toDay") ?? undefined,
    }));
  });
}
