import { idempotencyKeyOf, json, jsonBody, positiveId, serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";
import { assertExternalWorkOpen, returnFromExternal } from "@/lib/services/service-desk/external-work.service";

/** POST { expectedVersion, caseExpectedVersion, next, outcome?, result, … } + Idempotency-Key — the item is back. Closed until 1.3b. */
export async function POST(req: Request, context: { params: Promise<{ workId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertExternalWorkOpen();
    const id = positiveId((await context.params).workId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    return json(await returnFromExternal(principal, id, {
      expectedVersion: b.expectedVersion, caseExpectedVersion: b.caseExpectedVersion, next: b.next, outcome: b.outcome, result: b.result,
      workPerformed: b.workPerformed, unresolvedIssue: b.unresolvedIssue, followUpRequired: b.followUpRequired,
      finalCostAgorot: b.finalCostAgorot, receivedByStaffMemberId: b.receivedByStaffMemberId,
    }, { idempotencyKey: key }));
  });
}
