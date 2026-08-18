/**
 * Business Memory IMPL-5A · Materialization — PUBLIC SURFACE (barrel).
 *
 * The narrow Claim persistence Writer + its contract. INERT / UNWIRED: no product code imports this.
 * No Resolver, no Orchestrator, no Evidence Adapter read, no Deriver invocation, no VendorLearning.
 */
export type {
  MaterializationCommand,
  MaterializationOutcome,
  MaterializationAction,
  ClaimWriterClient,
  ClaimWriterTx,
} from "./claim-writer.contract";
export { materializeClaim } from "./claim-writer";
export { validateCommand, MaterializationRejected } from "./claim-writer.validate";
