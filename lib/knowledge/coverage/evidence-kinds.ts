/**
 * All-Feature Learning Coverage — what each evidence kind POINTS AT.
 *
 * A measure's evidence link is `(evidenceKind, evidenceRecordId)`. The id is only provenance if the
 * kind names the table that id lives in. The measure writer stores the kind as given; this map is
 * what holds the rules to it:
 *   - evidence-kinds.test.ts fails when a W2/W3 rule emits a kind that is not mapped here, and
 *   - the read-only Production proof (scripts/ops/learning-coverage-proof.ts) resolves every link of
 *     the coverage rules through this map and checks that the record exists and belongs to the same
 *     business as the measure.
 */
export const COVERAGE_EVIDENCE_STORES: Readonly<Record<string, string>> = {
  "billing-document": "BillingDocument",
  "billing-quote": "BillingDocument",
  "payment-request": "PaymentRequest",
  lead: "Lead",
  "lead-lifecycle-event": "LeadLifecycleEvent",
  conversation: "Conversation",
  appointment: "Appointment",
  // InstallmentWorkflow's primary key IS the installment id; the evidence id is that installment.
  "installment-workflow": "Installment",
  "business-obligation": "BusinessObligation",
  "offering-demand-signal": "OfferingDemandSignal",
  "learning-event:DATA_EXPORTED": "LearningEvent",
};

/** The measure-key prefixes (= domains) the coverage milestone added. */
export const COVERAGE_DOMAINS = [
  "billing", "customers", "payments", "collection", "leads", "conversations", "appointments", "secretary", "offering", "reports",
] as const;
