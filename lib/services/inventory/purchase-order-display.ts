/**
 * Purchasing Lifecycle Alignment — Phase D: derived PurchaseOrder display state.
 *
 * Replaces the ghost-status label/grouping logic (SENT / AWAITING_DELIVERY /
 * CLOSED) with a state DERIVED from the Receiving ledger plus the sharedAt event.
 * Pure and UI-agnostic — the UI maps the returned state to label/tone/tab.
 *
 *   - Only CANCELLED is read from the stored status (a real, human-set status).
 *   - "done" (RECEIVED / CLOSED) is derived from openQty / closedShortQty.
 *   - "SHARED" / "PARTIAL" reflect the sharedAt event + received quantity.
 */

const EPS = 1e-9;

export type PoDisplayState =
  | "OPEN" // open commitment, not yet shared, nothing received
  | "SHARED" // shared to supplier, nothing received yet
  | "PARTIAL" // some received, remainder still open
  | "RECEIVED" // fully received (no open, no shortfall)
  | "CLOSED" // done with a closed-short shortfall
  | "CANCELLED";

export type PoDisplayBucket = "pending" | "transit" | "history";

export type PurchaseOrderDisplayInput = {
  status: string;
  orderedQty: number;
  receivedQty: number;
  closedShortQty: number;
  openQty: number;
  sharedAt: Date | string | null;
};

/** Derive the display state. Never consults SENT/AWAITING_DELIVERY/CLOSED status. */
export function derivePurchaseOrderDisplayState(
  input: PurchaseOrderDisplayInput
): PoDisplayState {
  if (input.status === "CANCELLED") return "CANCELLED";

  if (input.openQty <= EPS) {
    return input.closedShortQty > EPS ? "CLOSED" : "RECEIVED";
  }

  if (input.receivedQty > EPS) return "PARTIAL";
  if (input.sharedAt != null) return "SHARED";
  return "OPEN";
}

/** Map a display state to the hub tab it belongs in. */
export function purchaseOrderDisplayBucket(state: PoDisplayState): PoDisplayBucket {
  switch (state) {
    case "CANCELLED":
    case "RECEIVED":
    case "CLOSED":
      return "history";
    case "SHARED":
    case "PARTIAL":
      return "transit";
    case "OPEN":
    default:
      return "pending";
  }
}

/** Receive-eligible display states (mirrors the Phase C eligibility predicate). */
export function isReceivableDisplayState(state: PoDisplayState): boolean {
  return state === "OPEN" || state === "SHARED" || state === "PARTIAL";
}
