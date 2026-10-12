import {
  recordPaidViaTasks,
  routeDomainAction,
  setDisplayState,
  type DisplayOp,
  type RoutedOp,
} from "@/lib/services/tasks/source-actions.service";
import { idempotencyKeyOf, json, jsonBody, tasksRoute, TasksHttpError } from "@/lib/services/tasks/tasks-http";

export const runtime = "nodejs";

type Params = { params: Promise<{ op: string }> };

const DISPLAY: readonly string[] = ["acknowledge", "snooze", "pin", "unpin"];
const ROUTED: readonly string[] = ["lead_done", "lead_snooze", "payment_handled", "payment_snooze"];

/**
 * POST — an owner action on a business item (spec 3.3–3.5, 12.3, 12.12). Body: { sourceKind, dedupeKey, until?,
 * amount?, paidAt?, method? }. The item must be one the source shows this business now.
 */
export async function POST(req: Request, { params }: Params) {
  return tasksRoute(req, async ({ actor }) => {
    const { op } = await params;
    const key = idempotencyKeyOf(req);
    const b = await jsonBody(req);
    const ref = { sourceKind: String(b.sourceKind ?? ""), dedupeKey: String(b.dedupeKey ?? "") };
    const r = { idempotencyKey: key };
    const until = typeof b.until === "string" ? b.until : undefined;
    if (DISPLAY.includes(op)) return json(await setDisplayState(actor, r, ref, op as DisplayOp, until));
    if (ROUTED.includes(op)) return json(await routeDomainAction(actor, r, ref, op as RoutedOp, until));
    if (op === "payment_paid") {
      return json(await recordPaidViaTasks(actor, r, { ...ref, amount: String(b.amount ?? ""), paidAt: String(b.paidAt ?? ""), method: String(b.method ?? "") }));
    }
    throw new TasksHttpError(404, "NOT_FOUND");
  });
}
