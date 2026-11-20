import { json, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { returnLoan } from "@/lib/services/service-desk/case-extras.service";

/** POST — the lent item came back (idempotent). */
export async function POST(req: Request, context: { params: Promise<{ id: string; loanId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const p = await context.params;
    return json(await returnLoan(principal, positiveId(p.id), positiveId(p.loanId)));
  });
}
