import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { runLoanAction } from "@/lib/services/service-desk/loans.service";

/**
 * POST { action: { type: "RETURN", conditionAtReturn, returnNote? } | { type: "CLOSE_UNRETURNED", closeReason, reason }
 *        | { type: "CHANGE_EXPECTED_RETURN", expectedReturnOn }, expectedVersion } + Idempotency-Key.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string; loanId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    const params = await context.params;
    const id = positiveId(params.id);
    const loanId = positiveId(params.loanId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await runLoanAction(principal, id, loanId, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
