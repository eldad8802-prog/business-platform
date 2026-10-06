/**
 * Business Intake M4 · deterministic routing rules.
 *
 * Pure: (event family, event type, the adapter's normalized target, identity
 * state, adapter capabilities) → one decision, with the NAME of the rule that
 * made it. No AI, no BusinessProfile heuristic can override these:
 *
 *   R0_FORBIDDEN_LEAD     a non-LEAD family (a message, an order, a call…) can
 *                         never become a Lead — frozen domain rule. The event is
 *                         dead-lettered so the violation is visible, not absorbed.
 *   R1_MESSAGE            MESSAGE → conversation (the adapter's M2 path)
 *   R2_MESSAGE_STATUS     delivery / read receipts → the outbound message only
 *   R3_DOCUMENT           → the documents intake (stays authoritative)
 *   R4_EXPLICIT_LEAD      LEAD family with a lead target → Lead. Identity
 *                         decides the CONTACT: resolved → that Customer;
 *                         unresolved → a new Customer (deterministic creation);
 *                         candidate / ambiguous / conflict → a contact-less Lead
 *                         plus owner proposals. Never a guess.
 *   R5_COMMERCE           COMMERCE → commerce: the core commerce destination
 *                         (M7-A) writes the CommerceOrder; identity decides the
 *                         buyer's Customer. Never a Lead. A source that did not
 *                         opt in is 'unavailable' (dead-lettered, payload KEPT).
 *   R9_CALL               CALL with a call target → the core call destination
 *                         (M7-A): one CallActivity. Identity may NAME a known
 *                         Customer; it never creates one, never links an
 *                         identifier and never creates or moves a Lead. A
 *                         conflict asks the owner. (A CALL aimed at "lead" is
 *                         already refused by R0.)
 *   R6_FORM_ATTENTION     FORM_SUBMISSION → attention (owner decides)
 *   R7_NONE               the adapter understood it and chose not to materialise
 *   R8_ATTENTION_DEFAULT  anything else the rules do not name → attention
 *
 * Executor: 'core' when M4's own destination handler runs it (lead) and the
 * adapter opted in; otherwise the adapter's route() runs it, receiving this
 * decision. 'unavailable' means there is no handler for that destination yet.
 */

import type { IntakeEventFamily } from "@prisma/client";
import type { RouteTarget } from "@/lib/intake/core/contract";
import type { IdentityState } from "@/lib/intake/identity/resolve";

export const ROUTING_POLICY_VERSION = "routing-policy@2";

export type RoutingDecision = {
  rule: string;
  destination: RouteTarget;
  executor: "adapter" | "core" | "unavailable" | "forbidden";
  ownerReviewRequired: boolean;
};

const UNCERTAIN: IdentityState[] = ["candidate", "ambiguous", "conflict"];

export function decideRoute(input: {
  family: IntakeEventFamily;
  eventType: string;
  target: RouteTarget;
  identityState: IdentityState;
  coreDestinations: readonly RouteTarget[];
}): RoutingDecision {
  const { family, target, identityState } = input;
  const core = (d: RouteTarget) => input.coreDestinations.includes(d);

  if (target === "lead" && family !== "LEAD") {
    return { rule: "R0_FORBIDDEN_LEAD", destination: "none", executor: "forbidden", ownerReviewRequired: false };
  }
  if (family === "COMMERCE") {
    return { rule: "R5_COMMERCE", destination: "commerce", executor: core("commerce") ? "core" : "unavailable", ownerReviewRequired: false };
  }
  if (family === "CALL" && target === "call") {
    return { rule: "R9_CALL", destination: "call", executor: core("call") ? "core" : "unavailable", ownerReviewRequired: identityState === "conflict" };
  }
  if (target === "message_status") {
    return { rule: "R2_MESSAGE_STATUS", destination: "message_status", executor: "adapter", ownerReviewRequired: false };
  }
  if (family === "MESSAGE" && target === "conversation") {
    return { rule: "R1_MESSAGE", destination: "conversation", executor: "adapter", ownerReviewRequired: false };
  }
  if (target === "document") {
    return { rule: "R3_DOCUMENT", destination: "document", executor: "adapter", ownerReviewRequired: false };
  }
  if (family === "LEAD" && target === "lead") {
    return {
      rule: "R4_EXPLICIT_LEAD",
      destination: "lead",
      executor: core("lead") ? "core" : "adapter",
      ownerReviewRequired: UNCERTAIN.includes(identityState),
    };
  }
  if (family === "FORM_SUBMISSION") {
    return { rule: "R6_FORM_ATTENTION", destination: "attention", executor: "adapter", ownerReviewRequired: true };
  }
  if (target === "none") {
    return { rule: "R7_NONE", destination: "none", executor: "adapter", ownerReviewRequired: false };
  }
  return { rule: "R8_ATTENTION_DEFAULT", destination: "attention", executor: "adapter", ownerReviewRequired: true };
}
