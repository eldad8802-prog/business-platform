import { removeException } from "@/lib/services/appointment/appointment-config.service";
import { appointmentsRoute, json, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ exceptionId: string }> };

/** DELETE — withdraw an exception. The row is marked removed, never deleted (it stays as history). */
export async function DELETE(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) =>
    json({ exception: await removeException(principal, positiveId((await params).exceptionId)) }));
}
