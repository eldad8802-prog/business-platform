/**
 * Business Memory IMPL-2 · Evidence Reference / Adapter — PUBLIC SURFACE (barrel).
 *
 * The only thing a future Business Memory consumer (Derivation Policy / Claim materializer) should
 * import. It re-exports the store-agnostic contract + the reader factories. It exposes NO Prisma type
 * and NO physical row shape beyond the mappers' structural inputs.
 *
 * INERT / UNWIRED: exporting this barrel does not wire anything. No product code imports it (IMPL-2 §15).
 */
export type {
  EvidenceAuthority,
  EvidenceKind,
  EvidenceRef,
  SubjectDomain,
  DomainLocalSubject,
  FieldVerdict,
  OwnerDecisionEvidence,
  EngineBeliefEvidence,
  EvidenceSetIdentity,
  OwnerDecisionEvidenceSet,
  OwnerDecisionEvidenceReader,
  EngineBeliefEvidenceReader,
} from "./evidence-contract";

export {
  createReviewEventEvidenceReader,
  projectOwnerDecisionEvidence,
  type ReviewEventRowSource,
} from "./review-event.reader";
export { mapReviewEvent, vendorSubject, matchesSubject, type ReviewEventRow } from "./review-event.mapper";
export {
  createExtractionSnapshotBeliefReader,
  mapExtractionSnapshot,
  type ExtractionSnapshotRow,
  type ExtractionSnapshotRowSource,
} from "./extraction-snapshot.mapper";
