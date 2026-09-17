/**
 * ERASURE CONTRACT — the debt this guard found on the tree the day it was written.
 *
 * A new guard that goes green on its first run has proven nothing. This one does not.
 * Sixteen findings, of which three were already known from the residual-data sweep and
 * thirteen were not. Every entry below is a real disagreement between the schema, the
 * manifest and the adapter, now visible instead of silent.
 *
 * This file is a RATCHET, not a mute:
 *
 *   an entry here that still fails    → known, reported, deferred on purpose
 *   an entry here that now passes     → the build FAILS until it is removed, so an
 *                                       improvement is locked in and cannot regress
 *   a failure NOT listed here         → the contract broke somewhere new. Build FAILS.
 *
 * Nothing is listed because it is inconvenient. Everything here is deferred to a named
 * increment, and deliberately NOT fixed in the increment that built the guard: shipping
 * the guard and the fixes together would leave no way to tell whether the evidence was
 * about the guard working or about the fixes working.
 *
 * `npm run verify:erasure-contract` with no flag ignores this file entirely and shows
 * the real state. That mode is the truth; this one is the schedule.
 */

export type DebtEntry = { code: string; key: string; why: string };

/** Naming drift — CLOSED by E2 Wave 2.
 *
 *  Prisma Client uncapitalizes only the FIRST character, so the delegates are
 *  `oAuthToken` and `pOSApiKey`; the manifest guessed `oauthToken` and `posApiKey`,
 *  which were the client's names for nothing. Because `resolve()` returns null and the
 *  field loop then skips, the wrong MODEL name was also hiding wrong COLUMN names
 *  underneath it: correcting only the models surfaced three C2-NO-SUCH-FIELD findings
 *  that had been invisible for months — `OAuthToken.accessToken`,
 *  `OAuthToken.refreshToken` and `POSApiKey.hashedKey`, none of which is a column on
 *  the model that named it. That is the M2 shape again, and it is why the fix is the
 *  DELETE ROW shape rather than a rename. */
const NAMING: DebtEntry[] = [
];

/** The finding the residual sweep was built around. The contract promises the lead's
 *  email address is erased. The code does not erase it. This is the one entry here
 *  that is a live personal-data exposure rather than a naming or coverage gap.
 *  → deferred to E2 ONLY because this increment is forbidden from changing product
 *    behaviour; it is the first thing E2 should close. */
const UNKEPT_PROMISE: DebtEntry[] = [
];

/** Erasure the adapter performs that no contract represents — CLOSED by E2 Wave 2.
 *
 *  None of these was ever wrong behaviour: every one is a credential being destroyed,
 *  which is exactly what should happen. What was missing was the declaration, so the
 *  manifest under-described what the deletion actually did. The adapter was not
 *  changed to close them; the manifest was changed to describe it truthfully.
 *
 *  `REVOKE_INTEGRATIONS` gained the shape this entry asked for — `deleteRow: true`
 *  alongside `clear`/`set` — and the guard now refuses to let one stand in for the
 *  other in either direction. Proofs D1…D4 in scripts/ci/erasure-mutate.ts. */
const UNDECLARED: DebtEntry[] = [
];

/** Columns with an explicit disposition that the adapter does not carry out. These are
 *  the residual-sweep P1 findings for `Lead`, now expressed as contract violations
 *  rather than prose in a report.
 *  → deferred to E2. Listing them as debt is the point: the disposition is the decision,
 *    and the guard now holds us to it. */
const LEAD_RESIDUALS: DebtEntry[] = [
];


/** E1.1 — every model now carries a disposition, and two of the categories ARE debt by
 *  construction. `UNMANAGED_PERSONAL_DATA` means the model holds personal data the
 *  erasure does not touch; `NEEDS_OWNER_DECISION` means I could not classify it from the
 *  schema without guessing. Both are recorded here so the registry being COMPLETE is
 *  never mistaken for the erasure being complete.
 *
 *  Each entry duplicates only the target increment. The surface and the question live in
 *  erasure-model-coverage.ts, which is the single description; this file is the schedule.
 *  Adding a model to either category therefore requires touching this file too, which is
 *  the point: one more unmanaged model cannot slip in as a one-line edit. */
const MODEL_LEVEL: DebtEntry[] = [
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Appointment", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "AuthSession", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "AuthSessionSecret", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "BusinessBotKnowledge", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "BusinessObligation", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "BusinessService", why: "E2" },
  // Payables Phase 1a. Commitment and Installment are what BusinessObligation
  // becomes; they inherit its exact erasure position — same personal surface,
  // same E2 target — and Payee sits beside Supplier for the same reason.
  // Recorded here so the debt is accepted explicitly, rather than three new
  // models quietly carrying personal data nobody declared.
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Commitment", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Installment", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Payee", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "CollaborationDeal", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Deal", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InboundEmailAddress", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InboundEmailAttachmentImport", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InboundEmailMessage", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InventoryAlert", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InventoryDraft", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InventoryItem", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "InventoryMovement", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "PurchaseOrder", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "PurchaseOrderLine", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "ReceivingSession", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Recommendation", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "RecommendationOutcome", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Supplier", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "SupplierPurchaseDraft", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "SupplierPurchaseDraftLine", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "Task", why: "E2" },
  { code: "C12-UNMANAGED-PERSONAL-DATA", key: "VendorLearning", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "Business", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBot", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBotLearningSuggestion", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBotMemoryPolicy", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBotRecommendation", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBotSettings", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "BusinessBotSetupDraft", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ContentEvent", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ContentRender", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ContentRun", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ContentVariant", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "DerivedClaimProjection", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ExtractionEvidence", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ExtractionSnapshot", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ImportRun", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "LearningEvent", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "Offer", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "PartyResolutionClaim", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "PaymentWebhookEvent", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "ReviewEvent", why: "E2" },
  { code: "C13-NEEDS-OWNER-DECISION", key: "SliceDecision", why: "E2" },
];

export const ACCEPTED_DEBT: DebtEntry[] = [
  ...NAMING,
  ...UNKEPT_PROMISE,
  ...UNDECLARED,
  ...LEAD_RESIDUALS,
  ...MODEL_LEVEL,
];

/** Findings and debt entries are matched on code + key, never on the prose detail, so
 *  improving a message never silently re-arms an accepted entry. */
export function debtKey(d: { code: string; key: string }): string {
  return `${d.code}::${d.key}`;
}
