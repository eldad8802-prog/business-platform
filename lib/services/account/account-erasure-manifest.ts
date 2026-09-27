/**
 * Account-erasure manifest (Wave 1B) — the declarative, testable contract for what an
 * account deletion RETAINS, ANONYMIZES, DELETES, and REVOKES. Ratified in
 * docs/privacy-account-deletion-erasure-design-v1.md.
 *
 * Keeping this as data (not buried in imperative code) lets a unit test assert the
 * compliance invariant: no legally-retained fiscal/evidence model is ever in a purge
 * set. The Prisma adapter executes this manifest; the orchestrator enforces order/gate.
 */

/**
 * Bucket A — legally must-retain (Israeli tax law + billing-compliance non-negotiables).
 * These are NEVER anonymized or deleted. Includes the 12 `Restrict` FKs and the ratified
 * bookkeeping-evidence models (FinancialDocument/Document/FinancialRecord + children).
 *
 * WHERE THE AUTHORITY FOR THIS LIST COMES FROM
 *
 * The CLASSIFICATION of a model — retained or not, and on what basis — is decided in
 * `scripts/ci/erasure/erasure-model-coverage.ts`, which is complete by construction:
 * every model in the schema must have an entry or the build fails. This list is the
 * OPERATIONAL projection of that decision, in Prisma delegate names, because the
 * runtime guard below needs it and must not import CI code.
 *
 * Two lists mean two chances to drift, so the drift is what is checked: the erasure
 * contract verifier compares this set with the registry's RETAINED_BY_DESIGN set in
 * BOTH directions and fails on any difference, naming the models. It was written after
 * exactly that drift was found — five payables/collection models were retained in the
 * registry and absent here, and the guard below approved a manifest it could not see.
 */
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
  // Payables and collection. Retained in the registry since each shipped, and missing
  // here until the equality check was written — the drift that motivated it. Nothing
  // about their classification changes by appearing in this list: the registry still
  // states the basis (LEGAL/FISCAL, except the payables audit trail: SECURITY/AUDIT),
  // and the erasure's behaviour is unchanged — it never touched any of them.
  "payment",
  "paymentAllocation",
  "paymentEvidence",
  "payablesAuditEvent",
  "paymentAccountingSettlement",
] as const;

/** Bucket C — external integration credentials to revoke (provider-side best-effort).
 *
 *  An entry has exactly ONE of two shapes, and the difference between them is a
 *  difference in what is being promised:
 *
 *    { model, clear, set }      the ROW SURVIVES. `clear` = ciphertext/secret columns
 *                              nulled or blanked; `set` = status/revocation markers.
 *                              The claim is about named columns, and only a write to
 *                              those columns can keep it.
 *
 *    { model, deleteRow: true } the ROW IS DELETED, and everything on it goes with it.
 *                              The claim is about the row, and only an actual delete
 *                              can keep it.
 *
 *  They are not interchangeable, and the contract guard no longer lets them be. A row
 *  deletion used to count as satisfying a `clear` declaration, which meant the manifest
 *  could describe destroying an entire row as "these two columns are cleared" — weaker
 *  than the truth, and silent about every other column on the row. `OAuthToken` and
 *  `POSApiKey` were exactly that, and because nothing resolved their names the declared
 *  columns did not even exist on them. */
export const REVOKE_INTEGRATIONS = [
  { model: "billingAuthorityConnection", clear: ["accessTokenEncrypted", "accessTokenIv", "accessTokenTag", "refreshTokenEncrypted", "refreshTokenIv", "refreshTokenTag"], set: { revokedAt: "now" } },
  // SEC-E / M-13: the connection IDENTIFIERS go as well as the secrets. `emailAddress` is
  // NOT NULL and unique per (business, provider), so it is a per-row tombstone.
  { model: "emailConnection", clear: ["lastSyncCursor", "lastError", "providerAccountId", "scopes"], set: { status: "revoked", emailAddress: "tombstone-id" } },
  // Deleted, not cleared. The rows hang off EmailConnection and carry no fiscal FK,
  // so the whole row goes — ciphertext, key id, expiry and all. The delegate is
  // `oAuthToken`: Prisma Client uncapitalises only the FIRST character.
  { model: "oAuthToken", deleteRow: true },
  // SEC-E / M-13 + L-18: `phoneNumberId` is globally @unique, so leaving it bound the
  // number to the deleted business forever. Tombstoned from the business id (the table
  // is one-row-per-business), which releases the real number.
  { model: "whatsAppConnection", clear: ["accessTokenEncrypted", "accessTokenIv", "accessTokenTag", "displayPhoneNumber", "wabaId", "lastErrorMessage", "lastErrorCode", "lastErrorAt"], set: { status: "REVOKED_BY_META", phoneNumberId: "tombstone-business" } },
  { model: "businessPaymentConnection", clear: ["credentialEncrypted", "credentialIv", "credentialTag"], set: { isActive: "false" } },
  // Deleted for a reason a clear could not achieve: `keyHash` is globally @unique, so
  // blanking it to a constant would collide across two account deletions. The delegate
  // is `pOSApiKey`, and the column is `keyHash` — the old entry named neither.
  { model: "pOSApiKey", deleteRow: true },
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
  // C12-E1. Two free-text notes, and nothing else on either model. Receiving a
  // delivery, and deciding what to do with an undelivered remainder, are operational
  // facts the business keeps; what somebody typed beside them is not, because nothing
  // constrains what goes in it.
  //
  // What is kept is declared in erasure-dispositions.ts rather than left unsaid: the
  // product columns (`rawName`, `sku`, `barcode`) under the ratified S-7C
  // product-identity decision, and the three provenance pointers on a dependency the
  // guard checks — they are ids into a `User` row this same erasure anonymises.
  { model: "receivingSession", fields: { note: "null" } },
  { model: "purchaseOrderLine", fields: { remainingDecisionNote: "null" } },

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
  // Inbound-email sender authorisation. Child before parent: the challenge
  // rows are subordinate to the claim they verify and mean nothing without
  // it. Both hold personal data about someone OUTSIDE the business and have
  // no fiscal linkage, so they are deleted rather than anonymised.
  "inboundEmailSenderChallenge",
  "inboundEmailAuthorizedSender",
] as const;

/** The two shapes of a Bucket-C entry, as types rather than as a convention.
 *
 *  `revokesRow` is the only sanctioned way to tell them apart. A bare `"deleteRow" in e`
 *  is also true for `deleteRow: false`, and an entry that explicitly opted OUT of row
 *  deletion must never be read as one that opted in. */
export type RevokeByColumns = {
  readonly model: string;
  readonly clear: readonly string[];
  readonly set: Readonly<Record<string, string>>;
};

export type RevokeByRowDeletion = {
  readonly model: string;
  readonly deleteRow: true;
};

export type RevokeEntry = RevokeByColumns | RevokeByRowDeletion;

export function revokesRow(entry: RevokeEntry): entry is RevokeByRowDeletion {
  return (entry as RevokeByRowDeletion).deleteRow === true;
}

/** Bucket C as the union, for every consumer that has to distinguish the two shapes.
 *  `REVOKE_INTEGRATIONS` keeps its `as const` literal type for everything else. */
export const REVOKE_ENTRIES: readonly RevokeEntry[] = REVOKE_INTEGRATIONS;

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
