/**
 * Business Obligation — integration seam (WP6).
 *
 * The coordinator is a CONSUMER (docs/dubiz-business-obligation-integration-model-v1.md):
 * other domains emit business *signals* (§3) and the coordinator decides the
 * operational *reaction* (§4). This module is that attach point — expressed in
 * the canonical business vocabulary, independent of any producer.
 *
 * MVP wiring (canon §7): the only signal sources actually wired are the ones the
 * MVP can receive today — MANUAL discovery and OWNER-confirmed closure. Every
 * other source (Documents, Suppliers, Payments settlement, Bank) is DEFERRED:
 * its meaning is defined here so a future producer plugs in without changing the
 * coordinator, but no live producer is built and no other domain is imported.
 *
 * This file is intentionally pure (no DB / HTTP / domain imports) so the
 * contract stays testable and the deferral is explicit, not silent.
 */

/** The canonical signal meanings (Integration Model §3). A finite vocabulary —
 * new sources add *origins of these meanings*, never new meanings. */
export type ObligationSignalKind =
  | "OBLIGATION_DISCOVERED"
  | "OBLIGATION_DETAILS_CHANGED"
  | "DUE_MOMENT_CHANGED"
  | "SUPPLIER_COMMITMENT_CHANGED"
  | "SETTLEMENT_OBSERVED"
  | "CLOSURE_EVIDENCE_AVAILABLE"
  | "OWNER_CONFIRMED_HANDLED"
  | "OBLIGATION_CANCELLED_RELEASED"
  | "CROSS_OBLIGATION_MEANING";

/** Where a signal originated. MVP can only receive OWNER/MANUAL. */
export type SignalSource =
  | "OWNER"
  | "DOCUMENTS"
  | "BILLING"
  | "SUPPLIERS"
  | "PAYMENTS"
  | "BANK"
  | "BUSINESS_BRAIN";

/** The coordinator's understanding of a signal (Integration Model §4). */
export type ObligationReaction =
  | "RECOGNIZE"
  | "UPDATE_AWARENESS"
  | "UPDATE_TIMING"
  | "CLOSE_MET"
  | "CLOSE_RELEASED"
  | "RAISE_CONFIDENCE"
  | "ADJUST_FRAMING"
  | "IGNORE";

/**
 * Pure mapping of signal meaning -> operational reaction (Integration §4).
 * This encodes the contract once; producers and the coordinator agree on it.
 */
export function reactionFor(kind: ObligationSignalKind): ObligationReaction {
  switch (kind) {
    case "OBLIGATION_DISCOVERED":
      return "RECOGNIZE";
    case "OBLIGATION_DETAILS_CHANGED":
      return "UPDATE_AWARENESS";
    case "DUE_MOMENT_CHANGED":
      return "UPDATE_TIMING";
    case "SUPPLIER_COMMITMENT_CHANGED":
      return "UPDATE_AWARENESS";
    case "SETTLEMENT_OBSERVED":
      return "CLOSE_MET";
    case "OWNER_CONFIRMED_HANDLED":
      return "CLOSE_MET";
    case "CLOSURE_EVIDENCE_AVAILABLE":
      return "RAISE_CONFIDENCE";
    case "OBLIGATION_CANCELLED_RELEASED":
      return "CLOSE_RELEASED";
    case "CROSS_OBLIGATION_MEANING":
      return "ADJUST_FRAMING";
    default:
      return "IGNORE";
  }
}

/**
 * Whether the MVP is actually wired to receive this signal source. Only the
 * owner/manual path is live today; the rest are DEFERRED (canon §7) and require
 * a future producer in the originating domain. A source that is not wired must
 * never be treated as a silent no-op — callers should surface the deferral.
 */
export function isSourceWiredInMvp(source: SignalSource): boolean {
  return source === "OWNER";
}
