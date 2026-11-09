import { json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { recordIntake } from "@/lib/services/service-desk/service-case.service";

/** PUT { conditionNote, accessoriesNote, conditionRecorded, accessoriesRecorded, expectedUpdatedAt } — the intake data (no signature, no PDF). */
export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const id = positiveId((await context.params).id);
    const b = await jsonBody(req);
    return json(await recordIntake(principal, id, {
      conditionNote: b.conditionNote, accessoriesNote: b.accessoriesNote, conditionRecorded: b.conditionRecorded,
      accessoriesRecorded: b.accessoriesRecorded, expectedUpdatedAt: b.expectedUpdatedAt === undefined ? null : b.expectedUpdatedAt,
    }));
  });
}
