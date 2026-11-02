/**
 * Receiving goods against a purchase order line — what is still open, whether this
 * receipt leaves the line short, and what to send for the remainder.
 *
 * The open balance is the server's `openQty` = ordered − already received (posted
 * sessions) − already closed short. A receipt is short against THAT, not against
 * the ordered quantity, so a second partial delivery is judged on what is left.
 *
 * Server contract (purchaseOrderService.setLineRemainingDecision):
 *   KEEP_OPEN     → remainingDecision only (the server stores no quantity)
 *   BACKORDER     → remainingDecisionQty  > 0 and ≤ ordered − received
 *   CLOSED_SHORT  → remainingDecisionQty  > 0 and ≤ ordered − received
 * The screen used to send no quantity, so BACKORDER and CLOSED_SHORT were always
 * refused and the whole receipt failed (audit 2026-11-03, ב3). The quantity sent
 * is the part of the open balance this receipt does not cover: open − received now.
 */
export type RemainderDecision = "KEEP_OPEN" | "BACKORDER" | "CLOSED_SHORT";

export type ReceivableLine = {
  orderedQty: number;
  receivedQty?: number;
  closedShortQty?: number;
  openQty?: number;
};

export function lineOpenQty(line: ReceivableLine): number {
  const open =
    typeof line.openQty === "number"
      ? line.openQty
      : line.orderedQty - (line.receivedQty ?? 0) - (line.closedShortQty ?? 0);
  return Math.max(0, open);
}

/** Received quantity the stepper may hold: never below 0, never above what is open. */
export function clampReceived(line: ReceivableLine, value: number): number {
  return Math.min(lineOpenQty(line), Math.max(0, value));
}

/** How much of the open balance this receipt leaves undelivered (0 when it covers it). */
export function shortfall(line: ReceivableLine, receivedNow: number): number {
  return Math.max(0, lineOpenQty(line) - receivedNow);
}

export function remainderDecisionPayload(
  line: ReceivableLine,
  receivedNow: number,
  decision: RemainderDecision | undefined
): { remainingDecision: RemainderDecision; remainingDecisionQty?: number } | null {
  const left = shortfall(line, receivedNow);
  if (!decision || left <= 0) return null;
  if (decision === "KEEP_OPEN") return { remainingDecision: decision };
  return { remainingDecision: decision, remainingDecisionQty: left };
}
