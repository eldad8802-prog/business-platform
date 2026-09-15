/**
 * Account-erasure manifest (Wave 1B) — the declarative, testable contract for what an
 * account deletion RETAINS, ANONYMIZES, DELETES, and REVOKES. Ratified in
 * docs/privacy-account-deletion-erasure-design-v1.md.
 *
 * Keeping this as data (not buried in imperative code) lets a unit test assert the
 * compliance invariant: no legally-retained fiscal/evidence model is ever in a purge
 * set. The Prisma adapter executes this manifest; the orchestrator enforces order/gate.
 */

/** Bucket A — legally must-retain (Israeli tax law + billing-compliance non-negotiables).
 *  These are NEVER anonymized or deleted. Includes the 12 `Restrict` FKs and the ratified
 *  bookkeeping-evidence models (FinancialDocument/Document/FinancialRecord + children). */
export const RETAIN_MODELS = [
  // 12 Restrict fiscal/governance
  "billingDocument",
  "billingDocumentLine",
  "billingReceiptPayment",
  "billingAuditEvent",
  "billingDocumentNumberSequence",
  "billingPaymentAllocation",
  "financialEvent",
  "billingAuthoritySubmission",
  "paymentRequest",
  "paymentTransaction",
  "paymentAuditEvent",
  "riaCanonicalReferent",
  "riaPolicyLineage",
  // ratified bookkeeping-evidence
  "financialDocument",
  "document",
  "financialRecord",
  "extractedData",
  "emailAttachmentImport",
  "whatsAppAttachmentImport",
  // historical fiscal facts imported from a prior system. Retained for the same
  // reason the documents they describe are: the obligation to keep a fiscal record
  // does not care which software produced it.
  "historicalFiscalDocument",
] as const;

/** Bucket C — external integration credentials to revoke (provider-side best-effort) +
 *  clear at rest. `clear` = ciphertext/secret fields to null; `set` = status/markers. */
export const REVOKE_INTEGRATIONS = [
  { model: "billingAuthorityConnection", clear: ["accessTokenEncrypted", "accessTokenIv", "accessTokenTag", "refreshTokenEncrypted", "refreshTokenIv", "refreshTokenTag"], set: { revokedAt: "now" } },
  { model: "emailConnection", clear: [], set: { status: "revoked" } },
  { model: "oauthToken", clear: ["accessToken", "refreshToken"], set: {} },
  { model: "whatsAppConnection", clear: [], set: { status: "REVOKED_BY_META" } },
  { model: "businessPaymentConnection", clear: ["credentialEncrypted", "credentialIv", "credentialTag"], set: {} },
  { model: "posApiKey", clear: ["hashedKey"], set: {} },
] as const;

/** Bucket B.1 — anonymize in place (row kept, PII fields scrubbed). Customers are
 *  anonymized (NOT deleted) because issued invoices reference customerId; the invoice's
 *  frozen customerNameSnapshot preserves the legal record independently. */
export const ANONYMIZE_MODELS = [
  { model: "user", fields: { email: "tombstone-email", name: "null", password: "unusable" } },
  { model: "businessProfile", fields: { billingLegalName: "null", billingTaxId: "null", billingVatNumber: "null", billingPhone: "null", billingEmail: "null", billingAddress: "null", city: "null", latitude: "null", longitude: "null", billingLogoDataUrl: "null", billingSignatureDataUrl: "null" } },
  { model: "customer", fields: { name: "anonymized-name", phone: "null", email: "null", city: "null", legalName: "null", taxId: "null", notes: "null" } },
  // E2-W1. The column is `customerName`, not `name` — this entry named a field
  // that does not exist on Lead, and because nothing compared the manifest to
  // the schema it passed for months. The four content fields and the customer
  // pointer are declared now because the adapter now actually writes them. The
  // analytics columns are deliberately absent: they are not erased.
  {
    model: "lead",
    fields: {
      customerName: "null",
      phone: "null",
      email: "null",
      intentSnapshot: "null",
      followUpNote: "null",
      lostReason: "null",
      customerId: "null",
    },
  },
  // E2-W1. A denormalised COPY of counterparty identity and conversation
  // content, anonymised rather than deleted because the runtime holds no DELETE
  // on this table. `reason` and `href` are not declared because they are not
  // erased — a fixed policy string and an internal route name nobody.
  { model: "notification", fields: { title: "blank", summary: "null" } },

  // ── the conversation graph ────────────────────────────────────────────────
  //
  // This used to be one line in DELETE_MODELS. It deleted nothing: the five
  // pilot tables carry SELECT/INSERT/UPDATE policies and NO DELETE policy, so
  // under FORCE RLS the delete matched zero rows, raised nothing, and the
  // cascade never fired. The ratified decision was to anonymise in place rather
  // than grant a DELETE policy, so the guarantee changed from "the rows are
  // gone" to "nothing readable, derived or identifying is left in them".
  //
  // The graph is therefore listed field by field, deepest-first, exactly as the
  // adapter writes it. A model-level entry could not express this: "delete the
  // conversation" was a single claim, and what replaced it is twenty-four
  // separate ones, each of which has to be true.
  { model: "messageAnalysis", fields: { intent: "blank", stage: "blank" } },
  { model: "replySuggestion", fields: { text: "blank", toneLabel: "null", strategyLabel: "null" } },
  {
    model: "message",
    fields: {
      contentText: "null", languageCode: "null", intentLabel: "null",
      sentimentLabel: "null", objectionLabel: "null", stageLabel: "null",
      providerMessageId: "null", clientRequestId: "null",
      sendErrorCode: "null", sendErrorMessage: "null", customerId: "null",
    },
  },
  {
    model: "conversation",
    fields: {
      intentType: "null", sentimentSnapshot: "null", outcomeReason: "null",
      lostReason: "null", pendingFollowUp: "json-null",
      pendingAppointmentRequest: "json-null", customerId: "null", leadId: "null",
    },
  },
] as const;

/** Bucket B.2 — delete (pure operational communications PII, no fiscal linkage).
 *  `conversation` is NOT here any more: the graph is anonymised in place, and is
 *  declared field by field in ANONYMIZE_MODELS above. */
export const DELETE_MODELS = [
  "crmNote",
  "crmAttachment",
] as const;

export type ErasureManifest = {
  retain: readonly string[];
  revoke: readonly { model: string }[];
  anonymize: readonly { model: string }[];
  delete: readonly string[];
};

export const ERASURE_MANIFEST: ErasureManifest = {
  retain: RETAIN_MODELS,
  revoke: REVOKE_INTEGRATIONS,
  anonymize: ANONYMIZE_MODELS,
  delete: DELETE_MODELS,
};

/** Compliance guard: assert no retained (legal) model is present in any purge set.
 *  Throws if the manifest would ever anonymize/delete/revoke a must-retain model. */
export function assertManifestSafe(m: ErasureManifest = ERASURE_MANIFEST): void {
  const retain = new Set(m.retain);
  const purged = [
    ...m.anonymize.map((a) => a.model),
    ...m.delete,
    ...m.revoke.map((r) => r.model),
  ];
  const violations = purged.filter((model) => retain.has(model));
  if (violations.length > 0) {
    throw new Error(`account-erasure: manifest would purge legally-retained model(s): ${violations.join(", ")}`);
  }
}
