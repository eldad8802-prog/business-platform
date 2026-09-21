/**
 * ERASURE MODEL COVERAGE — one explicit disposition for EVERY Prisma model.
 *
 * WHY THIS EXISTS
 *
 * E1 made the manifest and the adapter agree about the models already inside its
 * boundary. It said nothing about a model that was never in the boundary at all, and
 * that turned out to matter within days: PR #423 added `InboundEmailMessage`,
 * `InboundEmailAddress` and `InboundEmailAttachmentImport` — carrying `fromEmail`,
 * `subject`, `rawObjectKey` and an encrypted local part — and every check in the
 * repository stayed green, because a model outside the registry is a model nobody
 * asked a question about.
 *
 * So the rule here is not "detect personal data". It is:
 *
 *     EVERY model in the schema has exactly one disposition, or the build fails.
 *
 * That is deliberately a coverage property rather than a detection one. No heuristic
 * decides whether `secret String?` is personal; a human does, once, in writing. A new
 * model with no entry is a failure whether or not a guard could have guessed its
 * contents — which is the only version of this that cannot be fooled.
 *
 * THE CATEGORIES
 *
 *   ERASURE_MANAGED          the erasure adapter writes or deletes it. Must therefore
 *                            participate in the E1 field-level contract.
 *   RETAINED_BY_DESIGN       survives on purpose. Needs a purpose AND a basis.
 *   UNMANAGED_PERSONAL_DATA  carries personal or communication data, the erasure does
 *                            NOT touch it, and that is a known gap. Needs a named
 *                            target increment. This category is debt, not an answer.
 *   NON_PERSONAL_OPERATIONAL no column describes a person or their communication.
 *                            Declared, never inferred.
 *   SYSTEM_INTERNAL          not tenant data at all — platform, auth plane, policy
 *                            substrate. Outside the tenant erasure question.
 *   NEEDS_OWNER_DECISION     I could not classify it from the schema alone without
 *                            guessing. Reported, never silently absorbed.
 *
 * `UNMANAGED_PERSONAL_DATA` and `NEEDS_OWNER_DECISION` both count as findings. The
 * registry reaching "every model classified" is NOT the same as the erasure being
 * complete, and these two categories are what keeps that distinction visible.
 */

export type ModelDisposition =
  | "ERASURE_MANAGED"
  | "RETAINED_BY_DESIGN"
  | "UNMANAGED_PERSONAL_DATA"
  | "NON_PERSONAL_OPERATIONAL"
  | "SYSTEM_INTERNAL"
  | "NEEDS_OWNER_DECISION";

export type RetentionBasis = "PRODUCT" | "LEGAL/FISCAL" | "SECURITY/AUDIT" | "UNPROVEN";

/**
 * Machine-enforced backing for a `NON_PERSONAL_OPERATIONAL` claim.
 *
 * Most entries in that category are counters and enums, and a stated `reason` is
 * a fair way to record "no column here describes a person". A few are different:
 * they hold free-text-shaped columns and the claim is not "there is no text" but
 * "nothing in this product can put a person in that text". That claim is about
 * the whole application, and it expires silently the moment somebody adds a
 * writer — so where it is made, it is proven rather than asserted.
 *
 * Declaring evidence is optional. Declaring it and being wrong is a build failure.
 */
export type NonPersonalEvidence = {
  /**
   * Every non-`@id` String/Json column the model is allowed to have. The guard
   * compares this to the schema in both directions, so a new `note` column fails
   * the build instead of quietly inheriting a non-personal classification.
   */
  textualSurface: readonly string[];
  /**
   * Repository-relative files permitted to write this model. An EMPTY list is the
   * strongest form: it asserts the product has no writer at all, and any write
   * anywhere is then a finding.
   *
   * File-granular on purpose. A rule about which local variable a value came from
   * breaks on the first rename and teaches people to edit the guard; "no new file
   * may write this" survives refactors and fails on the event that matters.
   */
  writeSites: readonly string[];
  /**
   * Models written through a parent's nested `create`. `SupplierPurchaseDraftLine`
   * has no delegate call of its own on the intake path — it is created inside
   * `supplierPurchaseDraft.create({ data: { lines: { create: [...] } } })` — so the
   * parent's writes count as writes to the child.
   */
  viaDelegates?: readonly string[];
  /**
   * When present, every write to a `textualSurface` column must be a literal, or a
   * template whose interpolations terminate in one of these property names. This
   * is what separates `` `low stock: ${item.name}` `` from `` `${customer.notes}` ``.
   */
  derivedFrom?: readonly string[];
};

export type ModelCoverage = {
  disposition: ModelDisposition;
  /** Required for RETAINED_BY_DESIGN, NON_PERSONAL_OPERATIONAL and SYSTEM_INTERNAL. */
  reason?: string;
  /** Required for RETAINED_BY_DESIGN. Never asserted without evidence. */
  basis?: RetentionBasis;
  /** Required for UNMANAGED_PERSONAL_DATA and NEEDS_OWNER_DECISION. */
  target?: string;
  /** Required for UNMANAGED_PERSONAL_DATA: what actually survives. */
  surface?: string;
  /** Required for NEEDS_OWNER_DECISION: the question that has to be answered. */
  question?: string;
  /** Optional for NON_PERSONAL_OPERATIONAL: proof instead of a promise. */
  evidence?: NonPersonalEvidence;
};

// ─────────────────────────────────────────────────────────────────────────────
// ERASURE_MANAGED — the adapter writes or deletes these.
// Derived from the adapter, not from intent: exactly the models with an erasure
// write or a delete. The guard cross-checks both directions.
// ─────────────────────────────────────────────────────────────────────────────
const ERASURE_MANAGED: Record<string, ModelCoverage> = {
  User: { disposition: "ERASURE_MANAGED" },
  BusinessProfile: { disposition: "ERASURE_MANAGED" },
  Customer: { disposition: "ERASURE_MANAGED" },
  Lead: { disposition: "ERASURE_MANAGED" },
  Conversation: { disposition: "ERASURE_MANAGED" },
  Message: { disposition: "ERASURE_MANAGED" },
  MessageAnalysis: { disposition: "ERASURE_MANAGED" },
  ReplySuggestion: { disposition: "ERASURE_MANAGED" },
  CrmNote: { disposition: "ERASURE_MANAGED" },
  CrmAttachment: { disposition: "ERASURE_MANAGED" },
  // E2-W1. Moved out of UNMANAGED_PERSONAL_DATA because the adapter now writes
  // it, not because the finding was inconvenient: the title and summary are
  // cleared under tenant context and the battery proves the sentinel is gone.
  Notification: { disposition: "ERASURE_MANAGED" },
  WhatsAppConnection: { disposition: "ERASURE_MANAGED" },
  EmailConnection: { disposition: "ERASURE_MANAGED" },
  OAuthToken: { disposition: "ERASURE_MANAGED" },
  POSApiKey: { disposition: "ERASURE_MANAGED" },
  BillingAuthorityConnection: { disposition: "ERASURE_MANAGED" },
  BusinessPaymentConnection: { disposition: "ERASURE_MANAGED" },
  InboundEmailAuthorizedSender: { disposition: "ERASURE_MANAGED" },
  InboundEmailSenderChallenge: { disposition: "ERASURE_MANAGED" },
};

// ─────────────────────────────────────────────────────────────────────────────
// RETAINED_BY_DESIGN — the manifest's RETAIN_MODELS, each with a stated basis.
// Where the basis is genuinely unproven it says so; an unproven basis is a better
// answer than an invented legal claim.
// ─────────────────────────────────────────────────────────────────────────────
const FISCAL = (reason: string): ModelCoverage => ({
  disposition: "RETAINED_BY_DESIGN",
  reason,
  basis: "LEGAL/FISCAL",
});

const RETAINED: Record<string, ModelCoverage> = {
  BillingDocument: FISCAL("the issued legal document; the frozen customer snapshot is part of the record"),
  BillingDocumentLine: FISCAL("line detail of an issued document"),
  BillingReceiptPayment: FISCAL("settlement detail of an issued receipt"),
  BillingPaymentAllocation: FISCAL("which payment settled which document"),
  BillingDocumentNumberSequence: FISCAL("numbering integrity; a gap in the sequence is itself a finding"),
  BillingAuditEvent: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "tamper-evident billing audit trail, including who acted",
    basis: "SECURITY/AUDIT",
  },
  PaymentAuditEvent: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "tamper-evident payment audit trail",
    basis: "SECURITY/AUDIT",
  },
  // ── Payables, Phase 1a ────────────────────────────────────────────────────
  // The outbound money family is classified like its inbound counterpart: a
  // Payment is bookkeeping evidence that money LEFT the business, exactly as
  // BillingReceiptPayment is evidence that money arrived, and it carries the
  // same retention weight as the FinancialRecord declared FISCAL below.
  // (Commitment / Installment / Payee are forward-looking or counterparty
  // records, not realized fiscal facts, and are declared UNMANAGED alongside
  // BusinessObligation and Supplier.)
  Payment: FISCAL("bookkeeping evidence that money left the business"),
  PaymentAllocation: FISCAL("which payment settled which installment"),
  PaymentEvidence: FISCAL("what proves a retained payment happened"),
  PayablesAuditEvent: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "tamper-evident payables audit trail, including who acted",
    basis: "SECURITY/AUDIT",
  },
  FinancialEvent: FISCAL("the ledger event behind a fiscal document"),
  BillingAuthoritySubmission: FISCAL("proof of what was filed with the tax authority and when"),
  PaymentRequest: FISCAL("payment evidence referenced by issued receipts"),
  PaymentTransaction: FISCAL("clearing evidence; `rawPayload` may carry provider-side personal data"),
  FinancialDocument: FISCAL("bookkeeping evidence"),
  FinancialRecord: FISCAL("the extracted fiscal facts of a document"),
  Document: FISCAL("the source artifact the fiscal record derives from — the artifact IS the evidence"),
  ExtractedData: FISCAL("extraction output bound to a retained document"),
  HistoricalFiscalDocument: {
    disposition: "RETAINED_BY_DESIGN",
    reason:
      "fiscal facts imported from a prior system. Name and tax id are part of the record; " +
      "the email, phone and address snapshots are NOT, and their retention is unproven",
    basis: "LEGAL/FISCAL",
  },
  EmailAttachmentImport: {
    disposition: "RETAINED_BY_DESIGN",
    reason:
      "provenance and import de-duplication for a retained document. The dedupe rests on " +
      "contentHashSha256 and the message/attachment unique, NOT on fromEmail or subject — " +
      "those two are minimisable and are an E2 question",
    basis: "UNPROVEN",
  },
  WhatsAppAttachmentImport: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "as EmailAttachmentImport, and `fromPhone` is a raw phone number",
    basis: "UNPROVEN",
  },
  RiaCanonicalReferent: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "identity-resolution substrate; inert, no consumers",
    basis: "PRODUCT",
  },
  RiaPolicyLineage: {
    disposition: "RETAINED_BY_DESIGN",
    reason: "policy-lineage substrate; inert, no consumers",
    basis: "PRODUCT",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// UNMANAGED_PERSONAL_DATA — the residual sweep's findings, as machine-checked debt.
// Every entry names what survives and which increment closes it.
// ─────────────────────────────────────────────────────────────────────────────
const unmanaged = (surface: string, target = "E2"): ModelCoverage => ({
  disposition: "UNMANAGED_PERSONAL_DATA",
  surface,
  target,
});

const UNMANAGED: Record<string, ModelCoverage> = {
  Supplier: unmanaged("name, phone, email, contactName/Role/Phone/Email, legalName, taxId, full address, notes"),
  Appointment: unmanaged("notes and title as free text, plus customerId and leadId"),
  Task: unmanaged("title and description as free text"),
  BusinessObligation: unmanaged("obligeeName and note"),
  // Payables, Phase 1a. A payee is the counterparty the business pays and may
  // well be a person — a landlord, an employee — so it sits beside Supplier
  // rather than being waved through as operational. Commitment and Installment
  // are the forward-looking obligations that replaced BusinessObligation and
  // inherit its classification.
  Payee: unmanaged("displayName, legalName, taxId and note"),
  Commitment: unmanaged("payeeNameSnapshot, title and note"),
  Installment: unmanaged("note, plus the legacy settlement provenance"),
  // Payables, Phase 2. A rejected match is a decision record, but `reason` is
  // owner-written free text and can name a person as readily as any other note
  // field, so it inherits the same classification rather than being waved
  // through as operational telemetry.
  PayablesMatchRejection: unmanaged("reason, the owner's free-text note on a rejected match"),
  // Payables, Phase 3. A sole trader's business account IS their personal bank
  // account, so the coordinates are personal data even though they are only
  // ever stored as AES-256-GCM ciphertext, last4 and a keyed fingerprint. A
  // cheque names its payee as written and carries free-text notes and reasons.
  BusinessBankAccount: unmanaged("encrypted bank coordinates, last4, label and note"),
  Cheque: unmanaged("payeeNameSnapshot, note and cancellationReason"),
  Deal: unmanaged("lostReason, and leadId to a partially-scrubbed Lead"),
  Recommendation: unmanaged("title and body, generated about the business"),
  RecommendationOutcome: unmanaged("notes"),
  InventoryItem: unmanaged("supplierName, a denormalised copy of a Supplier name"),
  InventoryMovement: unmanaged("note, plus createdByUserId"),
  InventoryDraft: unmanaged("detectedName and imageUrl"),
  PurchaseOrder: unmanaged("supplierName and supplierId"),
  PurchaseOrderLine: unmanaged("rawName as typed, and remainingDecisionNote"),
  SupplierPurchaseDraft: unmanaged("supplierName and supplierId"),
  ReceivingSession: unmanaged("note, plus createdByUserId"),
  VendorLearning: unmanaged("vendorName and its normalised form"),
  BusinessBotKnowledge: unmanaged("address and notes, entered by the owner"),
  AuthSession: unmanaged("userId and userAgent survive; sessions are refused by the lifecycle gate, not invalidated"),
  AuthSessionSecret: unmanaged("session secrets hang off AuthSession and are not removed with it"),
  InboundEmailMessage: unmanaged(
    "fromEmail, subject, providerMessageId and rawObjectKey — and rawObjectKey references " +
      "a raw MIME object OUTSIDE Postgres, which a database erasure cannot reach"
  ),
  InboundEmailAddress: unmanaged("localPartPreview, label, and the encrypted local part with its key id"),
  InboundEmailAttachmentImport: unmanaged("filename, plus the link to the message and the document"),
};

// ─────────────────────────────────────────────────────────────────────────────
// NON_PERSONAL_OPERATIONAL — declared, not inferred. Every column is structural,
// numeric, an enum, or a configuration value that describes the business's setup
// rather than a person or an exchange.
// ─────────────────────────────────────────────────────────────────────────────
const operational = (reason: string): ModelCoverage => ({
  disposition: "NON_PERSONAL_OPERATIONAL",
  reason,
});

const OPERATIONAL: Record<string, ModelCoverage> = {
  Usage: operational("per-week feature counters"),
  ProductUsageEvent: operational("feature-key telemetry; no free text, no identifiers beyond userId"),
  BusinessFeatureAccess: operational("which feature flags a business has, and a short enum-like reason"),
  BusinessObligationOrientation: operational("a per-business orientation setting"),
  LearningSignal: operational("numeric learning signals"),
  ServiceCostProfile: operational("cost inputs for pricing"),
  PricingRecommendation: operational("numeric pricing output"),
  PricingProfile: operational("a named pricing configuration; the name describes a rate card"),
  PricingCalculation: operational("pricing inputs and outputs; explanationText describes the calculation"),
  InventoryCategory: operational("category names for stock, not people"),
  InventoryPendingMatch: operational("match bookkeeping between POS lines and stock"),
  InventoryExternalSale: operational("external sale counters"),
  POSProductMapping: operational("maps a POS product code to a stock item"),
  ReceivingLine: operational("quantities received against a purchase-order line"),
  Coupon: operational("coupon definition and its public token; issued to no one until redeemed"),
  RedemptionEvent: operational("that a coupon was redeemed, with no redeemer identity stored"),
  BotGoalSelection: operational("which goal keys the owner picked for the bot"),
  BusinessBotProfile: operational("bot voice and personality settings"),
  ContentFeedback: operational("numeric feedback on generated content"),
  Party: operational("an empty identity anchor — id, businessId and timestamps only"),
  PaymentProviderRouting: operational("which provider a business routes to"),
  NotificationDelivery: operational("delivery bookkeeping for one notification"),
  ImportRunRow: operational("per-row import status and hashes"),
  DerivedClaimCandidate: operational("candidate bookkeeping in the inert claim substrate"),
  DerivedClaimEvidenceLink: operational("link rows in the inert claim substrate"),

  // ── C12-R: four corrections, each with its evidence attached ──────────────
  //
  // These four were classified UNMANAGED_PERSONAL_DATA on the assumption that a
  // text column is a personal-data surface. Read against the code, none of them
  // is: the correction is that the original classification was wrong, not that
  // the data stopped mattering. Nothing is erased to earn any of them, and every
  // claim below is checked by C14/C15/C16 rather than taken on trust.

  // Not "the service catalogue is impersonal" — that would be an opinion. The
  // product has NO writer for this model at all: zero create, update or upsert
  // anywhere outside tests. The only reference in the codebase is a `count()`.
  // An empty writeSites list is what says so, and what fails if one appears.
  BusinessService: {
    disposition: "NON_PERSONAL_OPERATIONAL",
    reason: "the product has no writer for it: a service catalogue nothing in the app fills",
    evidence: { textualSurface: ["name", "description"], writeSites: [] },
  },

  // Every content field comes from a fixed rule table in the matching engine —
  // `title: "שיתוף פעולה עם קוסמטיקאית"`, `partnerType: "Cosmetician"` — and the
  // one route that writes the model writes `status`, an enum. `partnerType` is a
  // closed professional label, not a person. There is no path from request text
  // to any column here, which is precisely what the write sites pin down.
  CollaborationDeal: {
    disposition: "NON_PERSONAL_OPERATIONAL",
    reason: "generated partnership suggestions from a fixed rule table; the API writes only status",
    evidence: {
      textualSurface: ["title", "description", "partnerType", "reasonText", "sourceType"],
      writeSites: ["app/api/deals/[id]/route.ts", "lib/collaboration/matchingEngine.ts"],
    },
  },

  // `message` is derived, not authored. Three of seven write sites touch it and
  // all three interpolate stock identity: `מלאי קריטי: ${item.name}`,
  // `מלאי נמוך: ${item.name}`, `מוצר מהקופה לא זוהה: ${metadata.name || sku || barcode}`.
  // The other four set isResolved/resolvedAt. Product names are
  // NON_PERSONAL_OPERATIONAL by ratified decision, so a string built only out of
  // them is too — and `derivedFrom` is what keeps it built only out of them.
  InventoryAlert: {
    disposition: "NON_PERSONAL_OPERATIONAL",
    reason: "stock alerts whose message interpolates product identity and nothing else",
    evidence: {
      textualSurface: ["message"],
      // The resolve route writes `isResolved` and no text. It is listed because the
      // site rule is delegate-granular on purpose — "who may write this model" is a
      // cheaper question to keep honest than "who may write this column", and it was
      // this scan that found the route at all: the call is split across two lines
      // (`tx.inventoryAlert` then `.updateMany(`), so every grep-based inventory of
      // write sites in the preceding audits missed it.
      writeSites: [
        "app/(shell)/inventory/alerts/[id]/resolve/route.ts",
        "lib/services/inventory/inventory.service.ts",
        "lib/services/inventory/pending-match.service.ts",
      ],
      derivedFrom: ["name", "sku", "barcode", "externalSaleId"],
    },
  },

  // `rawName` is the only text column on the model, and it is a PRODUCT name:
  // the CSV connector maps it to `productName`, the adapter falls back to
  // `line.productName`, the document service prints `rawName || "מוצר ללא שם"`,
  // and intake copies it straight into `InventoryDraft.detectedName`. It sits
  // beside `sku` and `barcode` in the line's identity check. The via-delegate is
  // not an optimisation: on the intake path these rows only ever exist inside
  // `supplierPurchaseDraft.create({ data: { lines: { create: [...] } } })`.
  SupplierPurchaseDraftLine: {
    disposition: "NON_PERSONAL_OPERATIONAL",
    reason: "purchase-draft lines; rawName is a product name, alongside sku and barcode",
    evidence: {
      textualSurface: ["rawName", "sku", "barcode"],
      writeSites: [
        "app/api/inventory/supplier-purchases/[id]/reject/route.ts",
        "lib/services/inventory/supplier-purchase-approval.service.ts",
        "lib/services/inventory/supplier-purchase-intake.service.ts",
      ],
      viaDelegates: ["supplierPurchaseDraft"],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM_INTERNAL — not tenant data. These are Dubiz's own platform, auth plane and
// policy substrate. They are outside the tenant erasure question by construction,
// which is a different statement from "they hold nothing sensitive".
// ─────────────────────────────────────────────────────────────────────────────
const internal = (reason: string): ModelCoverage => ({ disposition: "SYSTEM_INTERNAL", reason });

const INTERNAL: Record<string, ModelCoverage> = {
  PlatformAdminMfa: internal("platform-admin MFA secret; belongs to the operator, not to a tenant"),
  PlatformAuditEvent: internal("platform-operator audit trail"),
  PlatformFeatureDefinition: internal("the catalogue of feature flags"),
  PlatformFeaturePolicy: internal("default policy per feature flag"),
  BillingAuthorityApp: internal("Dubiz's own OAuth client credentials with the tax authority"),
  DerivationPolicy: internal("policy definitions in the inert derivation substrate"),
  DerivationPolicyVersion: internal("versions of the same"),
};

// ─────────────────────────────────────────────────────────────────────────────
// NEEDS_OWNER_DECISION — classified as unclassifiable, on purpose.
//
// Each of these needs either a product decision or a code trace I cannot complete
// from the schema alone. Guessing would be worse than saying so: a wrong
// NON_PERSONAL_OPERATIONAL here is exactly the silent gap this file exists to stop.
// ─────────────────────────────────────────────────────────────────────────────
const decide = (question: string, target = "E2"): ModelCoverage => ({
  disposition: "NEEDS_OWNER_DECISION",
  question,
  target,
});

const DECIDE: Record<string, ModelCoverage> = {
  Business: decide(
    "Business.name survives. For a sole trader it IS the owner's name — but retained invoices " +
      "name the same business by legal necessity, so anonymising it may be incoherent. Product decision."
  ),
  LearningEvent: decide(
    "payload is an untyped Json written from 16 call sites. One of them (billing-draft) writes " +
      "customerNameSnapshot. Needs a rule for audit payloads, plus a trace of the other 15."
  ),
  ContentRun: decide("inputSnapshot and businessContextSnapshot are Json; their contents are not knowable from the schema"),
  ContentVariant: decide("seven Json columns of generated creative output; needs a trace of the producer"),
  ContentRender: decide("providerPayload and output URLs from an external render provider"),
  ContentEvent: decide("payload is Json; contents unknown from the schema"),
  BusinessBotSettings: decide("welcomeMessage and three Json columns the owner authors; may quote customers"),
  BusinessBotSetupDraft: decide("activationMeta and selectedGoalKeys are Json"),
  BusinessBotRecommendation: decide("reason and payload; generated, contents not knowable from the schema"),
  BusinessBotMemoryPolicy: decide("contactHistory and manualNotes are policy toggles by name, but the naming suggests otherwise"),
  BusinessBotLearningSuggestion: decide("title, description and payload generated from conversations"),
  BusinessBot: decide("displayName and avatar — the bot's identity, possibly the owner's"),
  Offer: decide("title, description and customerBenefitText are marketing copy the owner writes"),
  ExtractionSnapshot: decide("rawResult is the full OCR result blob for a retained document; retained or erased?"),
  SliceDecision: decide("reasoningBlob is derived from document content"),
  ExtractionEvidence: decide("reasoningBlob and ocrGeometry, derived from document content"),
  ReviewEvent: decide("rawBelief and rawFinal are decision blobs over document content"),
  PartyResolutionClaim: decide("subjectType/subjectId point at a Customer or Supplier; the claim itself is a link"),
  DerivedClaimProjection: decide("subjectNormalizedKey may encode a counterparty name"),
  ImportRun: decide("sheetName and the content hashes describe an uploaded file"),
  PaymentWebhookEvent: decide(
    "a raw provider webhook `payload` with NO businessId. The erasure is tenant-scoped, so it " +
      "cannot find these rows by business at all — closing this needs a way to reach them, not " +
      "just a decision about whether to."
  ),
};

export const MODEL_COVERAGE: Record<string, ModelCoverage> = {
  ...ERASURE_MANAGED,
  ...RETAINED,
  ...UNMANAGED,
  ...OPERATIONAL,
  ...INTERNAL,
  ...DECIDE,
};

/** Every category a model appears in. Used to prove no model is classified twice —
 *  object spread would silently keep the last one, so the sources are checked
 *  separately rather than trusting the merge. */
export const COVERAGE_SOURCES: { name: string; models: Record<string, ModelCoverage> }[] = [
  { name: "ERASURE_MANAGED", models: ERASURE_MANAGED },
  { name: "RETAINED_BY_DESIGN", models: RETAINED },
  { name: "UNMANAGED_PERSONAL_DATA", models: UNMANAGED },
  { name: "NON_PERSONAL_OPERATIONAL", models: OPERATIONAL },
  { name: "SYSTEM_INTERNAL", models: INTERNAL },
  { name: "NEEDS_OWNER_DECISION", models: DECIDE },
];
