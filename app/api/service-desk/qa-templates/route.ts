import { json, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { QA_TEMPLATES, TRACK_QA_TEMPLATES } from "@/lib/services/service-desk/qa-templates";

/** GET — the base QA checklists per kind of service (fixed in code, P3) and, M1, the templates a track names by id. */
export async function GET(req: Request) {
  return serviceDeskRoute(req, "read", async () => json({ templates: QA_TEMPLATES, trackTemplates: TRACK_QA_TEMPLATES }));
}
