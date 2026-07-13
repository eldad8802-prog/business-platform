/**
 * Father Engine — C0 / PR2. Seed concepts — TEST FIXTURE ONLY.
 *
 * These three definitions are the minimum needed to exercise the registries in
 * tests. They are NOT a production catalog and NOT a ratified semantic source of
 * truth. The conceptId is CLEAN of the aspect (aspect lives only in `aspect`).
 */

import { conceptId, conceptVersion } from "../../versioning.types";
import type { BusinessConceptDefinition } from "../concept-registry";

export const SEED_CONCEPTS: readonly BusinessConceptDefinition[] = [
  {
    conceptId: conceptId("SalesCommitment"),
    conceptVersion: conceptVersion("1"),
    referentType: "COMMITMENT",
    aspect: "Established",
    valueShape: { mode: "EVENT", scale: "NOMINAL" },
    semanticDefinition:
      "A sales commitment (a customer obligation to buy/pay) came into existence — e.g. an order was placed or a deal agreed. Records the ESTABLISHMENT event only; nothing about fulfillment, settlement, or amount.",
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
  {
    conceptId: conceptId("Communication"),
    conceptVersion: conceptVersion("1"),
    referentType: "PARTY",
    aspect: "Received",
    valueShape: { mode: "EVENT", scale: "NOMINAL" },
    semanticDefinition:
      "An inbound communication from a party was received (message/email/call arrived). Records the RECEIPT event only; nothing about content classification, intent, or any reply.",
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
  {
    conceptId: conceptId("ResourceLevel"),
    conceptVersion: conceptVersion("1"),
    referentType: "RESOURCE",
    aspect: "Observed",
    valueShape: { mode: "MEASURE", scale: "RATIO", unitDimension: "count" },
    semanticDefinition:
      "A measured level/quantity of a resource at a point in time (e.g. inventory on hand). A ratio-scaled magnitude with a unit dimension; a point MEASURE reading — not a flow, not a change, not a threshold judgment.",
    effectiveFrom: "2026-07-01T00:00:00.000Z",
  },
];
