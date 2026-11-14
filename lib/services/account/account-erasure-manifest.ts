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
  // Monthly accountant packages: stored copies of the retained fiscal records above, for one month.
  "accountantPackage",
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
  // Revenue truth (milestone A): fiscal revenue evidence (registry: LEGAL/FISCAL). Listed so the guard below
  // protects it; the erasure never touched these tables and its behaviour is unchanged.
  "revenueSale",
  "revenueReceipt",
  "revenueDailyClose",
  "revenueDailyCloseTender",
  "revenueDailyCloseVat",
  "revenueSettlement",
  "revenueLink",
  "revenueDecision",
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
  { model: "emailConnection", clear: ["lastSyncCursor"], set: { status: "revoked" } },
  // Deleted, not cleared. The rows hang off EmailConnection and carry no fiscal FK,
  // so the whole row goes — ciphertext, key id, expiry and all. The delegate is
  // `oAuthToken`: Prisma Client uncapitalises only the FIRST character.
  { model: "oAuthToken", deleteRow: true },
  { model: "whatsAppConnection", clear: ["accessTokenEncrypted", "accessTokenIv", "accessTokenTag"], set: { status: "REVOKED_BY_META" } },
  { model: "businessPaymentConnection", clear: ["credentialEncrypted", "credentialIv", "credentialTag"], set: { isActive: "false" } },
  // Deleted for a reason a clear could not achieve: `keyHash` is globally @unique, so
  // blanking it to a constant would collide across two account deletions. The delegate
  // is `pOSApiKey`, and the column is `keyHash` — the old entry named neither.
  { model: "pOSApiKey", deleteRow: true },
  // M6 — acquisition connections: revoked in place (no DELETE policy; the row is the audit of the
  // binding). The Meta Page token and the owner-facing label go; the key hash stays (a hash of a
  // random key, naming nobody) but a REVOKED row can never resolve again.
  {
    model: "acquisitionConnection",
    clear: ["credentialCiphertext", "credentialIv", "credentialTag", "credentialKeyId", "credentialExpiresAt", "label"],
    set: { status: "REVOKED", revokedAt: "now" },
  },
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
      // Leads L1 · G-01b — the phone typed into an anonymous enquiry (personal data).
      claimedPhone: "null",
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
  // Daily Tasks (milestone A). The owner's own words on a task or a series are blanked in place: the runtime
  // holds no DELETE on either table, and due days, states and rules are the business's history. erasedAt
  // records the erasure.
  { model: "task", fields: { title: "blank", description: "null", erasedAt: "now" } },
  { model: "taskSeries", fields: { title: "blank", note: "null", erasedAt: "now" } },
  // Web Push subscriptions (migration 20261022090000): the browser's push address and keys are blanked in place
  // (endpoint = 'erased:<id>', keys empty) and the row is revoked — the runtime holds no DELETE on the table, and
  // with no address and no keys nothing can ever be sent to that device again.
  { model: "pushSubscription", fields: { endpoint: "erased-id", p256dh: "blank", auth: "blank", revokedAt: "now" } },
  // Monthly accountant workflow. The recipient snapshot of every send is erased in place (the delivery's
  // approval columns are immutable and its outcome is the business's history) and every download link is
  // revoked, so nothing of the accountant remains and no link can open again.
  { model: "accountantDelivery", fields: { recipientName: "null", recipientEmail: "null", linkRevokedAt: "now" } },
  // Appointments (milestone A, migration 20261029090000). Erased in place — the runtime holds no DELETE on any of
  // these tables, and times, kinds, statuses and rules are the business's own history. An appointment loses its free
  // text and its customer / lead pointers; a staff member (a third person) loses their name; an exception loses its
  // label; an external request loses the requester's contact details; every manage link is revoked, so none can open
  // again. The journal's acting users and digests go through appointment_erase_business() (the adapter calls it).
  {
    model: "appointment",
    fields: { title: "null", notes: "null", locationDetail: "null", customerId: "null", leadId: "null", erasedAt: "now" },
  },
  { model: "staffMember", fields: { displayName: "blank", erasedAt: "now" } },
  { model: "availabilityException", fields: { label: "null" } },
  {
    model: "bookingRequest",
    fields: { contactName: "blank", contactPhone: "null", contactEmail: "null", customerNote: "null", erasedAt: "now" },
  },
  { model: "appointmentManageToken", fields: { revokedAt: "now" } },
  // Document ↔ supplier links (migration 20261103090000) hold no text: ids, closed tokens, versions and times.
  // Who linked / removed / acted is nulled by document_supplier_link_erase_business() (the adapter calls it),
  // so neither model needs a field entry here.
  // Service Desk (migration 20261112090000): erased in place by service_erase_business() — see
  // DB_FUNCTION_ERASURES below; the tables' guards refuse that change from the runtime itself.
  // Service Desk 1.2b (migration 20261113090000): erased in place by service_external_erase_business() — see
  // DB_FUNCTION_ERASURES below; same reason.
  // Service Desk spare parts M2 (migration 20261115090000): erased in place by service_parts_erase_business() — see
  // DB_FUNCTION_ERASURES below; same reason.
  // Service Desk UI foundation 1.3-0 (migration 20261120090000): erased in place by service_desk_ui_erase_business() —
  // see DB_FUNCTION_ERASURES below; same reason. Its objects go after commit (account-storage-erasure.ts).

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
  // M2 — Business Intake receipts. The payload holds the event as received until
  // it is processed (and kept for retry when it fails); the pointers would
  // reconnect a receipt to the conversation graph. The replay key is a hash.
  {
    model: "intakeEvent",
    fields: {
      payload: "json-null", metadata: "json-null", providerAccountRef: "null",
      messageId: "null", conversationId: "null", customerId: "null",
    },
  },
  // M3 — what Dubiz understood from a receipt. Contact hints are personal data;
  // attribution and the result pointers would reconnect the record to a person
  // or to the conversation graph. The non-personal signals and lifecycle stay.
  {
    model: "intakeNormalizedEvent",
    fields: {
      contactHints: "json-null", attribution: "json-null", resultRefs: "json-null",
      identityEvidence: "json-null", identityCustomerId: "null",
    },
  },
  // M4 — identity. A link's hash is pseudonymous personal data: nulled (an erased
  // link can never match again). Proposals: hashes, evidence and applied effects.
  { model: "identityLink", fields: { valueHash: "null" } },
  { model: "identityProposal", fields: { proposedLinks: "json-null", evidence: "json-null", appliedEffects: "json-null" } },
  // M7-A — commerce and calls. The order keeps status / currency / totals / times (non-personal facts);
  // the Customer pointer, attribution and the store's order number go. A line's product title goes
  // (stores personalise titles). A call keeps direction / outcome / duration / times; the Customer
  // and lead pointers and the unknown caller's hash go — an erased call can never be regrouped.
  { model: "commerceOrder", fields: { customerId: "null", attribution: "json-null", orderNumber: "null" } },
  { model: "commerceOrderLine", fields: { title: "null" } },
  { model: "callActivity", fields: { callerHash: "null", customerId: "null", leadId: "null" } },
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
  // Transactional email to the owner (address + template parameters). No fiscal
  // linkage; deleted under the tenant context through its tenant-scoped policy.
  "transactionalEmail",
  // Single-use account links (hash + the address each was sent to). Deleted under
  // the tenant context through its tenant-scoped policy, like transactionalEmail.
  "authEmailToken",
  // Google identity links (the subject + the address it was linked with). Deleted under the tenant context
  // through its tenant-scoped policy, like authEmailToken.
  "userIdentity",
  // Daily Tasks request fingerprints (HMAC of a request that may have carried a title). Deleted under the
  // tenant context through its tenant-scoped DELETE policy (task_request_ledger_runtime_delete).
  "taskRequestLedger",
  // The accountant recipient of the monthly package (a third person's name and address). Deleted under the
  // tenant context through its tenant-scoped DELETE policy (accountant_recipient_runtime_delete).
  "accountantRecipient",
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

/**
 * Erasure performed by a database function the adapter calls (SECURITY DEFINER, in the
 * purge transaction) — for tables whose guards refuse the change from the runtime itself.
 * Each entry is proven, not trusted, by erasure-db-function-contract.ts: the adapter call,
 * the function in `migration` (definer, pg_temp last, tenant-scoped, deletion-gated) and,
 * per model, that every `cleared` column is set to NULL / '' / '{}' and every other text
 * column is listed in `kept` with a reason. `model` is the Prisma MODEL name.
 */
export type DbFunctionErasure = {
  fn: string;
  migration: string;
  models: readonly {
    model: string;
    /** The function DELETES the business's rows of this model (then `cleared` and `kept` are empty). */
    deleted?: true;
    cleared: readonly string[];
    kept: Readonly<Record<string, string>>;
  }[];
};

export const DB_FUNCTION_ERASURES: readonly DbFunctionErasure[] = [
  // Service Desk (1.2a). The account-deletion adapter calls it in the purge transaction. Statuses, outcomes,
  // amounts, versions, hashes and times stay as the business's history; the journal's acting users and request
  // digests and the quotes' user ids are nulled by the same function (those models hold no text — they are
  // NON_PERSONAL_OPERATIONAL in erasure-model-coverage.ts).
  {
    fn: "service_erase_business",
    migration: "20261112090000_service_desk_foundation",
    models: [
      {
        model: "ServiceCase",
        cleared: ["problemDescription", "diagnosisNote", "cancelReason", "abandonReason"],
        kept: {
          qaChecklist: "QA checklist results: item keys with pass / fail flags, no free text — the writer (task 1.3) must keep it so or add it to service_erase_business()",
          // M1 (20261127090000): this function's fixed column list cannot know these — a second declared function clears them.
          siteAddress: "cleared by service_tracks_erase_business() (M1) — see its declaration",
          siteNotes: "cleared by service_tracks_erase_business() (M1) — see its declaration",
          originalSaleRef: "cleared by service_tracks_erase_business() (M1) — see its declaration",
          profileKey: "the service profile key (one of eight code tokens) the case was opened under — not personal",
          profileSnapshot: "the requirement rules copied from the code catalog at the opening (tokens and booleans) — no personal data",
        },
      },
      {
        model: "ServiceDevice",
        cleared: ["serialNumber", "serialNormalized", "description"],
        kept: {
          category: "the product category (e.g. phone), not the person",
          brand: "the maker (e.g. Samsung), not the person",
          model: "the product model (e.g. A54), not the person",
          displayName: "cleared by service_tracks_erase_business() (M1) — see its declaration",
          attributes: "cleared by service_tracks_erase_business() (M1) — see its declaration",
        },
      },
      {
        model: "ServiceCaseIntake",
        cleared: ["deviceSnapshot", "conditionNote", "accessoriesNote", "signatureKey"],
        kept: {
          slipPdfKey: "a private object key under biz/{id}/service/ (CHECK); the bytes are an object surface, erased after commit with the biz/{id}/service/ prefix (OBJECT_SURFACES), and a key column is not the object",
          termsVersion: "the version token of the intake terms text the customer signed",
        },
      },
      {
        model: "ServiceHandover",
        cleared: ["receivedByName", "signatureKey", "debtOverrideReason", "loanerOverrideReason"],
        kept: {},
      },
    ],
  },
  // Service Desk 1.2b — work at an external supplier. The account-deletion adapter calls it in the purge
  // transaction, next to service_erase_business(). Supplier, amounts, dates, stages, results and times stay as the
  // business's history; the supplier reference is cleared although its CHECK makes it an RMA-like token (correction 3).
  {
    fn: "service_external_erase_business",
    migration: "20261113090000_service_external_work",
    models: [
      {
        model: "ServiceExternalWork",
        cleared: ["sendReason", "requestedWork", "conditionAtSend", "operationalNote", "supplierReference",
          "workPerformed", "unresolvedIssue", "sentByUserId", "returnedByUserId"],
        kept: {
          currency: "the currency code — 'ILS' by CHECK, not the person",
        },
      },
      {
        model: "ServiceExternalWorkEvent",
        cleared: ["actorUserId", "requestDigest", "digestKeyId", "reason"],
        kept: {
          payload: "a closed JSON object of short tokens and numbers (no free text by DB CHECK ServiceExternalWorkEvent_payload_closed)",
          idempotencyKey: "a client request token (CHECK ^[A-Za-z0-9:_#-]{8,200}$), not the person",
        },
      },
    ],
  },
  // Service Desk spare parts M2. The account-deletion adapter calls it in the purge transaction, next to
  // service_external_erase_business(). M2-3: only names typed by hand are personal; a name or sku copied from the
  // business's own inventory item stays, with states, quantities, costs, prices, links and times.
  {
    fn: "service_parts_erase_business",
    migration: "20261115090000_service_parts",
    models: [
      {
        model: "ServicePart",
        cleared: ["reason", "note", "createdByUserId"],
        kept: {
          nameSnapshot: "replaced by a fixed text when typed by hand (no inventory item); otherwise the inventory item's own name, not the person (M2-3)",
          skuSnapshot: "cleared when typed by hand (no inventory item); otherwise the inventory item's own sku, not the person (M2-3)",
        },
      },
      {
        model: "ServicePartEvent",
        cleared: ["actorUserId", "requestDigest", "digestKeyId", "reason"],
        kept: {
          payload: "a closed JSON object of short tokens and numbers (no free text by DB CHECK ServicePartEvent_payload_closed)",
          idempotencyKey: "a client request token (CHECK ^[A-Za-z0-9:_#-]{8,200}$), not the person",
        },
      },
    ],
  },
  // Service Desk UI foundation 1.3-0. The account-deletion adapter calls it in the purge transaction, after
  // service_parts_erase_business(). Who acted (users), a warranty change reason and a phone-reminder note are personal;
  // the business's own texts, hashes, keys, times and states stay as the case's history. The function also opens the
  // durable object-erasure job (ServiceStorageErasure, one row per business, the tenant's own id) — the objects under
  // biz/{id}/service/ go after commit (OBJECT_SURFACES, service-storage-erasure.ts).
  {
    fn: "service_desk_ui_erase_business",
    migration: "20261120090000_service_desk_ui_foundation",
    models: [
      {
        model: "ServiceTextVersion",
        cleared: ["createdByUserId", "legallyApprovedByUserId"],
        kept: {
          body: "the business's own service terms / statutory-rights text shown to customers (ו4: versioned, legally approved) — not about a person; the consumer-law record of what was presented",
          bodySha256: "the sha256 of that text (CHECK-bound to the body), not the person",
        },
      },
      {
        model: "ServiceIntakeTermsSnapshot",
        cleared: ["presentedByUserId"],
        kept: {
          termsSha256: "the hash of the terms version presented at intake, not the person",
          statutorySha256: "the hash of the statutory notice presented at intake, not the person",
        },
      },
      {
        model: "ServiceWarrantyOffer",
        cleared: ["changeReason", "presentedByUserId", "createdByUserId"],
        kept: {
          scopeText: "the commercial warranty scope offered for the repair — kept by the applied function as the case's consumer record; per-case owner free text, so scrubbing it is an OPEN owner decision (privacy mapping, 1.3-0 PR-2)",
          exclusionsText: "the commercial warranty exclusions offered for the repair — kept by the applied function, same open owner decision as scopeText",
          contentSha256: "the hash of the offer's content, not the person",
        },
      },
      {
        model: "ServiceIntakePhoto",
        cleared: ["createdByUserId"],
        kept: {
          storageKey: "biz/{id}/service/cases/{caseId}/intake/photos/{sha256}.{ext} by CHECK — ids and a hash; the object itself is deleted after commit (OBJECT_SURFACES)",
          sha256: "the photo's content hash, not the person",
          mimeType: "image/jpeg | image/png | image/webp by CHECK",
        },
      },
      {
        model: "ServiceShareEvent",
        cleared: ["actorUserId"],
        kept: {
          objectKey: "the stored copy's key under biz/{id}/service/ (CHECK + guard); the object is deleted after commit (OBJECT_SURFACES)",
          objectSha256: "the stored copy's hash, not the person",
          idempotencyKey: "a client request token (CHECK ^[A-Za-z0-9._:-]{16,128}$), not the person",
        },
      },
      {
        model: "ServicePhoneReminder",
        cleared: ["actorUserId", "note"],
        kept: {
          idempotencyKey: "a client request token (CHECK ^[A-Za-z0-9._:-]{16,128}$), not the person",
        },
      },
    ],
  },
  // Business documents (migration 20261114090000). The account-deletion adapter calls it in the purge transaction,
  // next to the Service Desk functions. Unlike those it DELETES the records — nothing of a quote share copy, a share
  // event or a saved letter is history the business keeps — and it writes the durable erasure job and marks every
  // stored file DELETING (keys kept) in the same transaction. The stored PDFs go after commit (OBJECT_SURFACES).
  // BusinessDocumentRequest (idempotency keys, no text) is deleted too; it is NON_PERSONAL_OPERATIONAL, so not
  // declared here.
  {
    fn: "business_documents_erase",
    // Redefined (same name, contract and grants) by the purchase-order sheet migration, which adds that table.
    migration: "20261121090000_business_documents_po_sheets",
    models: [
      { model: "QuoteShareCopy", deleted: true, cleared: [], kept: {} },
      { model: "QuoteShareEvent", deleted: true, cleared: [], kept: {} },
      { model: "BusinessLetter", deleted: true, cleared: [], kept: {} },
      { model: "PurchaseOrderSheet", deleted: true, cleared: [], kept: {} },
    ],
  },
  // Service Desk P4 audit journal (migration 20261122090000). The account-deletion adapter calls it in the purge
  // transaction, after service_desk_ui_erase_business(). Who acted and the request digest are personal / linkable; the
  // rest is RETAINED as the business's audit record of settings changes — pseudonymised (no acting user), not anonymous:
  // it stays linked to the (anonymised) business row. The P4 case records live in ServiceCaseEvent and are blanked by
  // service_erase_business() (actorUserId, requestDigest, digestKeyId) — their payload is closed (tokens, numbers,
  // booleans; staff ids whose display names the purge blanks).
  {
    fn: "service_settings_journal_erase_business",
    migration: "20261122090000_service_desk_audit_journal",
    models: [
      {
        model: "ServiceSettingsEvent",
        cleared: ["actorUserId", "requestDigest", "digestKeyId"],
        kept: {
          settingsVersion: "the settings version the change produced — a counter, not the person",
          changedFields: "names of the settings fields that changed, from a closed set (CHECK) — never their values",
          actor: "always OWNER_USER (CHECK) — a role token, not the person once actorUserId is cleared",
          occurredAt: "when the settings changed — the audit time of the business's own configuration",
          idempotencyKey: "a client request token (a random UUIDv7: its only content is its creation time), not the person",
        },
      },
    ],
  },
  // Service Desk case charge (migration 20261126090000). The account-deletion adapter calls it in the purge transaction,
  // after service_settings_journal_erase_business(). Who acted and the free-text reasons are personal; the amounts,
  // modes, document ids and times are RETAINED as the business's financial record — pseudonymised, linked to the
  // (anonymised) business row.
  {
    fn: "service_case_charge_erase_business",
    migration: "20261126090000_service_desk_case_charge",
    models: [
      {
        model: "ServiceCaseCharge",
        cleared: ["reason", "actorUserId"],
        kept: {
          seq: "the record's place in the case's charge history — a counter, not the person",
          mode: "CHARGEABLE or NO_CHARGE (enum) — what the case was charged, not who decided",
          amountAgorot: "the agreed amount — the business's financial record of the case",
          currency: "always ILS (CHECK)",
          source: "APPROVED_QUOTE or OWNER_ENTERED (enum) — where the amount came from",
          quoteVersion: "the quote version an approved amount came from — a counter",
          actor: "a role token (OWNER_USER / CUSTOMER_LINK / SYSTEM), not the person once actorUserId is cleared",
          createdAt: "when the charge was recorded — the financial record's time",
        },
      },
      {
        model: "ServiceCaseBillingLink",
        cleared: ["linkedByUserId", "unlinkedByUserId", "unlinkReason"],
        kept: {
          billingDocumentId: "which billing document belonged to the case — an id into a retained fiscal record",
          role: "CHARGE or STANDALONE_PAYMENT (enum)",
          linkedAt: "when the document was linked",
          unlinkedAt: "when it was unlinked, if it was",
        },
      },
    ],
  },
  // Service Desk tracks (migration 20261127090000). The account-deletion adapter calls it in the purge transaction, after
  // service_case_charge_erase_business(). It scrubs the M1 personal columns that service_erase_business()'s fixed column
  // list cannot know; the work type, place, profile snapshot and completion type stay as the case's record.
  {
    fn: "service_tracks_erase_business",
    migration: "20261127090000_service_desk_tracks",
    models: [
      {
        model: "ServiceCase",
        cleared: ["siteAddress", "siteNotes", "originalSaleRef"],
        kept: {
          profileKey: "the service profile key (one of eight code tokens) the case was opened under — not personal",
          profileSnapshot: "the requirement rules copied from the code catalog at the opening (tokens and booleans) — no personal data",
          problemDescription: "cleared by service_erase_business() (foundation) — see its declaration",
          diagnosisNote: "cleared by service_erase_business() (foundation) — see its declaration",
          cancelReason: "cleared by service_erase_business() (foundation) — see its declaration",
          abandonReason: "cleared by service_erase_business() (foundation) — see its declaration",
          qaChecklist: "item keys with pass / fail flags — declared kept by service_erase_business() (foundation)",
        },
      },
      {
        model: "ServiceDevice",
        cleared: ["displayName", "attributes"],
        kept: {
          serialNumber: "cleared by service_erase_business() (foundation) — see its declaration",
          serialNormalized: "cleared by service_erase_business() (foundation) — see its declaration",
          description: "cleared by service_erase_business() (foundation) — see its declaration",
          category: "the product category, not the person — declared kept by service_erase_business()",
          brand: "the maker, not the person — declared kept by service_erase_business()",
          model: "the product model, not the person — declared kept by service_erase_business()",
        },
      },
      {
        model: "ServiceCompletion",
        cleared: ["confirmedByName", "note", "debtOverrideReason", "actorUserId", "debtApprovedByUserId"],
        kept: {
          completionType: "where the owner confirmed the work (enum) — not who",
          completedAt: "when the case was completed",
          openBalanceAgorot: "the open balance the case was closed with (an amount) — not who",
          overpaidAgorot: "the overpayment the case was closed with (an amount) — not who",
          debtApprovedAt: "when the debt was approved — a time, not who (the approver is cleared)",
        },
      },
      {
        model: "ServiceCaseDetailChange",
        cleared: ["reason", "actorUserId", "siteAddressBefore", "siteAddressAfter"],
        kept: {
          changedFields: "names of the changed fields (a closed set of tokens) — never values",
          caseVersion: "the case version the change produced — a counter",
          occurredAt: "when the details changed",
        },
      },
    ],
  },
  // Service Desk QA lists (migration 20261129090000). The account-deletion adapter calls it in the purge transaction, after
  // service_tracks_erase_business(). The texts the owner typed (list names, check labels, result notes) and who acted are
  // personal; the structure — versions, check keys, REQUIRED flags, PASS / FAIL results, counts and times — stays as the
  // cases' QA history. The list head (ServiceQaList) holds no text of a person (NON_PERSONAL_OPERATIONAL).
  {
    fn: "service_qa_lists_erase_business",
    migration: "20261129090000_service_desk_qa_lists",
    models: [
      {
        model: "ServiceQaListVersion",
        cleared: ["name", "createdByUserId"],
        kept: {
          version: "the content version number — a counter",
          itemCount: "how many checks the version holds — a count",
          requiredCount: "how many of them are REQUIRED — a count",
          createdAt: "when the version was written",
        },
      },
      {
        model: "ServiceQaListItem",
        cleared: ["label"],
        kept: {
          itemKey: "the check's stable key — a token (CHECK ^[a-z][a-z0-9_]{0,39}$: generated i<version>_<n> or a built-in template's key)",
          required: "whether the check is REQUIRED (boolean)",
          position: "the check's place in its version — a counter",
        },
      },
      {
        model: "ServiceQaListEvent",
        cleared: ["actorUserId", "requestDigest", "digestKeyId"],
        kept: {
          action: "CREATE / REVISE / ARCHIVE / RESTORE (enum) — what changed, not who",
          revision: "the list's change counter",
          listVersion: "the content version the change produced — a counter",
          idempotencyKey: "a client request token (a random UUIDv7: its only content is its creation time), not the person",
          occurredAt: "when the list changed",
        },
      },
      {
        model: "ServiceCaseQaRecord",
        cleared: ["actorUserId"],
        kept: {
          templateId: "a built-in template id (a code token such as FIELD.v1, CHECK) when the case named no list — not personal",
          completed: "whether QA was complete — the case's QA history",
          recordedAt: "when the results were recorded",
        },
      },
      {
        model: "ServiceCaseQaItemResult",
        cleared: ["note"],
        kept: {
          itemKey: "the check's key — a token (CHECK), never text typed by a person",
          result: "PASS or FAIL (enum) — the case's QA history",
          required: "the check's REQUIRED flag as it was in that version (boolean)",
        },
      },
    ],
  },
];

export type ErasureManifest = {
  retain: readonly string[];
  revoke: readonly { model: string }[];
  anonymize: readonly { model: string }[];
  delete: readonly string[];
  /** Prisma delegates erased through DB_FUNCTION_ERASURES (never a retained model). */
  dbFunction?: readonly string[];
};

export const ERASURE_MANIFEST: ErasureManifest = {
  retain: RETAIN_MODELS,
  revoke: REVOKE_INTEGRATIONS,
  anonymize: ANONYMIZE_MODELS,
  delete: DELETE_MODELS,
  dbFunction: DB_FUNCTION_ERASURES.flatMap((d) => d.models.map((m) => m.model.charAt(0).toLowerCase() + m.model.slice(1))),
};

/** Compliance guard: assert no retained (legal) model is present in any purge set.
 *  Throws if the manifest would ever anonymize/delete/revoke a must-retain model. */
export function assertManifestSafe(m: ErasureManifest = ERASURE_MANIFEST): void {
  const retain = new Set(m.retain);
  const purged = [
    ...m.anonymize.map((a) => a.model),
    ...m.delete,
    ...m.revoke.map((r) => r.model),
    ...(m.dbFunction ?? []),
  ];
  const violations = purged.filter((model) => retain.has(model));
  if (violations.length > 0) {
    throw new Error(`account-erasure: manifest would purge legally-retained model(s): ${violations.join(", ")}`);
  }
}
