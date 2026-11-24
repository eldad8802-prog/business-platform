import { removeException } from "@/lib/services/appointment/appointment-config.service";
import { readHoursImpact } from "@/lib/services/appointment/appointment-schedule.service";
import { appointmentsRoute, json, positiveId } from "@/lib/services/appointment/appointments-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ exceptionId: string }> };

/**
 * DELETE — withdraw an exception. The row is marked removed, never deleted (it stays as history). The answer also says
 * how many live future appointments now fall outside the hours (G20 — information only).
 */
export async function DELETE(req: Request, { params }: Params) {
  return appointmentsRoute(req, async ({ principal }) => {
    const exception = await removeException(principal, positiveId((await params).exceptionId));
    return json({ exception, impact: await readHoursImpact(principal, { staffMemberId: exception.staffMemberId }) });
  });
}
