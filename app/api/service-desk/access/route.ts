import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

/** GET — the business's Service Desk access mode (FULL / READ_ONLY). NONE answers 404 like every route. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async ({ mode }) => json({ mode }));
}
