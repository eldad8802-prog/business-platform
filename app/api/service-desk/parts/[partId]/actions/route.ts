import {
  idempotencyKeyOf, json, jsonBody, positiveId, SERVICE_DESK_JSON_BODY_MAX_BYTES, serviceDeskRateLimit, serviceDeskRoute,
} from "@/lib/services/service-desk/service-desk-http";
import { assertPartsApiOpen, runPartAction } from "@/lib/services/service-desk/parts.service";

/**
 * POST { action: { type: RESERVE | RELEASE | SET_PRICE | CANCEL, … }, expectedVersion } + Idempotency-Key. No stock moves.
 * A RESERVE is a SOFT, logical hold among Service Desk cases only (two cases cannot reserve the same units); it is NOT a
 * guarantee of availability: the till and other inventory flows do not see it and can still take the units. A fresh RESERVE answer
 * that leaves a line RESERVED, and its replay, carries the warning RESERVATION_IS_SOFT. Closed until 1.3b.
 */
export async function POST(req: Request, context: { params: Promise<{ partId: string }> }) {
  return serviceDeskRoute(req, "write", async ({ principal }) => {
    assertPartsApiOpen();
    const limited = await serviceDeskRateLimit("SERVICE_DESK_PARTS_WRITE", principal);
    if (limited) return limited;
    const id = positiveId((await context.params).partId);
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req, SERVICE_DESK_JSON_BODY_MAX_BYTES);
    return json(await runPartAction(principal, id, { action: b.action, expectedVersion: b.expectedVersion }, { idempotencyKey: key }));
  });
}
