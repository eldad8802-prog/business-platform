/**
 * SEC-E / M-13 (F-6) — the COLUMN SET each model-level debt entry was accepted against.
 *
 * C12 (unmanaged personal data) and C13 (owner decision) are model-level findings, and
 * they used to be keyed by the model name alone. That made one accepted entry absorb
 * every column added to the model afterwards: add `nationalId String?` to a model that
 * was already debt, and the build stayed green because "Supplier" was already known.
 *
 * Each finding's key is now `Model@<shape>`, where the shape is the first 12 hex of the
 * SHA-256 of the model's sorted scalar columns (`name:Type[?][]`). This map records the
 * shape each entry in erasure-contract-debt.ts was accepted for. A schema change to an
 * indebted model therefore produces a NEW finding and fails --baseline-check, and the
 * old entry reports as resolved, until a person looks at the new column and updates the
 * shape here — deliberately, in review, with the column list printed in the finding.
 *
 * Regenerate after a reviewed change:
 *   npx tsx lib/services/account/erasure-contract.verify.test.ts --print-debt-shapes
 *
 * A shape for a model that no longer carries C12/C13 debt is itself a finding (C29).
 * Nothing here reclassifies anything; it only makes the existing debt precise.
 */
export const SHAPED_CODES: ReadonlySet<string> = new Set([
  "C12-UNMANAGED-PERSONAL-DATA",
  "C13-NEEDS-OWNER-DECISION",
]);

export const DEBT_SHAPES: Readonly<Record<string, string>> = {
  // M6 (main b5d165a): derived temporal summaries; classified NEEDS_OWNER_DECISION on main.
  TemporalKnowledge: "f8892e139ffa",
  // SEC-E revalidation: ProductUsageEvent is C12 debt (was mis-declared non-personal).
  ProductUsageEvent: "e3510a127453",
  Appointment: "b9b226035368",
  BusinessBotKnowledge: "dcebf6cb0bc0",
  BusinessObligation: "af1eb33a1e68",
  Commitment: "5610045ac502",
  Installment: "544c5436b3b0",
  Payee: "81cee3c32fc6",
  PayablesMatchRejection: "ba77c151ac31",
  BusinessBankAccount: "164f0c020852",
  Cheque: "0b883a81d6b0",
  PaymentDestination: "53d11319cdb9",
  PaymentPreparation: "ce31cb816840",
  ExternalTransaction: "1dd723c8c60d",
  ExternalTransactionMatchRejection: "9eca6c9c7a3e",
  OutboundExecution: "10805e6a223d",
  Deal: "482513225de5",
  InboundEmailAddress: "b60546a905c7",
  InboundEmailAttachmentImport: "a80317dbb5cf",
  InboundEmailMessage: "2f22de03ec3d",
  InventoryDraft: "04903875b0d6",
  InventoryItem: "694542fc6c46",
  InventoryMovement: "470567a44dee",
  PurchaseOrder: "805cf4d6d255",
  Recommendation: "daf958e8de69",
  RecommendationOutcome: "5609fb13b0a2",
  Supplier: "0c6f34f97774",
  SupplierPurchaseDraft: "ae536cc511ba",
  Task: "d3074e96e2ca",
  VendorLearning: "a4b64eca4797",
  Business: "cda3fdd0b1e3",
  BusinessBot: "ecbcdbcbd1b1",
  BusinessBotLearningSuggestion: "675d818d6c86",
  BusinessBotMemoryPolicy: "286b243288c3",
  BusinessBotRecommendation: "a792330dd611",
  BusinessBotSettings: "14b81dc754ff",
  BusinessBotSetupDraft: "a02c9c3f9d54",
  BusinessInsight: "ff62d3ad02f8",
  CollectionAction: "ec24dcc30a39",
  // Reviewed on refresh (main 3f3a023d): #551 added idempotencyKey (an opaque retry id, not
  // personal). Still C13 NEEDS_OWNER_DECISION for the same reason (payload Json).
  ContentEvent: "604f2e0072a0",
  ContentRender: "033201e8712e",
  ContentRun: "f993a94550ac",
  // Reviewed on refresh: #551 added businessId (tenant key, not personal). Still C13.
  ContentVariant: "25ded197bedf",
  DerivedClaimProjection: "12665419172d",
  EntityLinkProposal: "5a8519237151",
  ExtractionEvidence: "874385426587",
  ExtractionSnapshot: "fffe7b710608",
  ImportRun: "e9eb133bade6",
  LearningEvent: "69101bfa529e",
  // Reviewed on refresh: P1 added benefitType/benefitValue/benefitScope/minPurchaseAmount/
  // newCustomersOnly (structured offer terms the business sets, no person). Still C13
  // (title/description/customerBenefitText are owner-written copy); Offer.imageUrl stays C19.
  Offer: "05b34626d2a9",
  PartyResolutionClaim: "290e6b51769f",
  PaymentWebhookEvent: "f091c2af4e24",
  ReviewEvent: "e6c7de800774",
  SliceDecision: "ff28e081c77a",
  // M9 (#562/#563): main recorded these five as C13 NEEDS_OWNER_DECISION debt by model name;
  // their column sets are pinned here as reviewed (ids, states, counts, codes; no free text,
  // no amounts). OutcomeDecision is the owner's own answer and not rebuildable — the
  // decision main's entry asks for is unchanged, only made precise.
  OutcomeRecommendation: "5e923322f9f7",
  OutcomeDecision: "898000fa4583",
  OutcomeActionEvent: "e1de4228e91c",
  OutcomeObservation: "b1bd3cbeb3ec",
  OutcomeAssessment: "a2d3186c7ccd",
};
