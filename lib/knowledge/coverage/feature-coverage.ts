/**
 * ALL-FEATURE LEARNING COVERAGE — the canonical business-feature inventory and each feature's learning
 * decision. The SOURCE OF TRUTH for "what does this feature teach Dubiz?".
 *
 * WHY IT EXISTS
 * The product requirement is that every business feature participates in learning. An audit after #584
 * found 4 features learning, the rest partial or absent, and a sensor catalogue declaring consumers that
 * did not exist. This manifest makes the state explicit and keeps it explicit: the contract test
 * (`feature-coverage.test.ts`) fails when
 *   - a learning rule belongs to no feature, or a feature claims a rule that does not exist;
 *   - a tenant Prisma model, an API route family or a shell route is owned by no feature and is not
 *     declared infrastructure (so a new feature cannot land without a learning decision);
 *   - a sensor's learning role is inconsistent with the rules and ledgers it names;
 *   - LearningEvent is written outside the two governed writers.
 *
 * `coverage` is the CURRENT truth, never the plan. `target` is the plan for this milestone. `GAP` is
 * the only class that means "not yet covered" — it requires a target, and the milestone's Definition of
 * Done is zero GAP. Every other non-learning class carries the reason it is a decision, not an omission.
 *
 * Sensor architecture (decided with the owner, All-Feature Learning Coverage): the domain ledger is the
 * authority; LearningEvent is an observation ledger only for acts that leave no domain trace — see
 * `SensorLearningRole` in lib/sensors/sensor.contract.ts.
 */

export type CoverageClass =
  /** At least one active governed learning rule (M4 measure and/or M6 temporal) learns from it. */
  | "LEARNS"
  /** Reaches the BKS as L0 facts / owner statements only — and that is the decided level (reason). */
  | "L0_ONLY"
  /** Contributes identity relationships (M5), not measures. */
  | "RELATIONSHIPS"
  /** An ingress channel: its evidence is learned in the feature(s) it delivers into (`channelOf`). */
  | "CHANNEL"
  /** Learning is impossible until a named product defect or semantic gap is fixed (reason). */
  | "BLOCKED"
  /** Present in code but not a live business surface (orphan / no writer) — reason. */
  | "DORMANT"
  /** A superseded duplicate of another feature (`aliasOf`). */
  | "LEGACY_ALIAS"
  /** Read-only or one-off operation with no business behaviour to learn (reason). */
  | "NOT_LEARNING_RELEVANT"
  /** Consumes knowledge (presents it); produces no evidence of its own. */
  | "AGGREGATOR"
  /** The learning system itself. */
  | "META"
  /** NOT YET COVERED — a milestone backlog item. Requires `target`. Definition of Done: zero. */
  | "GAP";

export type LearningTarget = {
  readonly coverage: CoverageClass | "L1_LIMITED";
  /** What this feature will teach Dubiz, in business terms. */
  readonly plan: string;
};

/** Point 10 of the milestone: outcome readiness, decided now so M9 never again meets a domain without it. */
export type OutcomeReadiness = {
  readonly observableAction: boolean;
  readonly observableOutcome: boolean;
  readonly ownerDecisionRelevant: boolean;
  readonly recommendationPotential: "NONE" | "LOW" | "MEDIUM" | "HIGH";
  readonly note?: string;
};

export type FeatureCoverage = {
  readonly key: string;
  readonly name: string;
  readonly coverage: CoverageClass;
  /** Required for every class except LEARNS, AGGREGATOR and META. */
  readonly reason?: string;
  readonly channelOf?: readonly string[];
  readonly aliasOf?: string;
  /** M4 measure rule ids (registry `knowledgeCatalogue`). */
  readonly rules: readonly string[];
  /** M6 temporal rule ids (`temporalCatalogue`). */
  readonly temporalRules: readonly string[];
  /** Other learning units that run in derive (composers, cross-domain, identity, M9 families). */
  readonly otherUnits: readonly string[];
  /** L0 fact sources in lib/business-status (engine/translator ids). */
  readonly l0: readonly string[];
  /** Prisma models this feature owns (its domain ledger and state). Every tenant model is owned once. */
  readonly models: readonly string[];
  /** LearningEvent catalogue sensors written by this feature. Every catalogue sensor is owned once. */
  readonly sensors: readonly string[];
  /** Legacy LearningEvent types (logAuditEvent / direct writers) — LEGACY_AUDIT, never learning evidence. */
  readonly legacyEvents: readonly string[];
  /** Top-level route segments it owns: "api/<seg>" and "page/<seg>". */
  readonly routes: readonly string[];
  readonly target?: LearningTarget;
  readonly outcome: OutcomeReadiness;
};

const NO_OUTCOME: OutcomeReadiness = { observableAction: false, observableOutcome: false, ownerDecisionRelevant: false, recommendationPotential: "NONE" };

export const FEATURE_COVERAGE: readonly FeatureCoverage[] = [
  /* ───────────────────────────── learning today ───────────────────────────── */
  {
    key: "documents", name: "Documents (upload, OCR, review)", coverage: "LEARNS",
    rules: ["DOC-04", "DOC-02", "DOC-05", "DOC-06"], temporalRules: ["T-DOC-04", "T-DOC-05", "T-DOC-02", "T-DOC-06"],
    otherUnits: ["vendor-category@v1 (business memory, shadow)", "M9:REVIEW_PENDING_DOCUMENTS"],
    l0: ["documents-review-queue", "documents-inbox"],
    models: ["Document", "FinancialRecord", "VendorLearning", "ExtractionSnapshot", "SliceDecision", "ReviewEvent", "FinancialDocument",
      "DerivedClaimProjection", "DerivedClaimEvidenceLink"],
    sensors: ["DOCUMENT_INGESTED", "DOCUMENT_REPROCESS_REQUESTED"], legacyEvents: [],
    routes: ["api/documents", "page/documents"],
    target: { coverage: "LEARNS", plan: "Add the document intake-channel mix (Document.source) so channel features are learned through here." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "HIGH", note: "M9 REVIEW_PENDING_DOCUMENTS live." },
  },
  {
    key: "payables", name: "Payables (commitments, payments, cheques, bank)", coverage: "LEARNS",
    rules: ["AP-01", "AP-03", "AP-04", "AP-06"], temporalRules: ["T-AP-01", "T-AP-04"],
    otherUnits: ["composer:payables.pressure_with_paperwork_backlog", "M9:SETTLE_OVERDUE_INSTALLMENT"],
    l0: ["payables-schedule"],
    models: ["Payee", "Commitment", "Installment", "Payment", "PaymentAllocation", "PaymentEvidence", "PayablesMatchRejection", "PayablesAuditEvent",
      "BusinessBankAccount", "Cheque", "PaymentDestination", "PaymentPreparation", "ExternalTransaction", "ExternalTransactionMatchRejection", "OutboundExecution"],
    sensors: [], legacyEvents: [],
    routes: ["api/payables", "page/payables"],
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "HIGH", note: "M9 SETTLE_OVERDUE_INSTALLMENT live." },
  },
  {
    key: "business-cost", name: "Business cost (daily cost)", coverage: "LEARNS",
    rules: ["COST-08", "COST-02", "COST-04", "COST-05", "COST-01", "COST-06", "COST-07"], temporalRules: [],
    otherUnits: ["composer:cost.* (Wave 1 facts, Wave 2 patterns — #628)"], l0: [],
    models: [], sensors: [], legacyEvents: [],
    routes: ["api/business-cost"],
    outcome: { observableAction: false, observableOutcome: false, ownerDecisionRelevant: true, recommendationPotential: "LOW", note: "Owned by the Phase 3 cost-learning workstream." },
  },
  {
    key: "suppliers", name: "Suppliers & purchase orders", coverage: "LEARNS",
    rules: ["SUPP-01", "SUPP-02", "SUPP-03"], temporalRules: ["T-SUPP-01", "T-SUPP-02"], otherUnits: [],
    l0: ["supplier-purchases"],
    models: ["Supplier", "SupplierPurchaseDraft", "SupplierPurchaseDraftLine", "PurchaseOrder", "PurchaseOrderLine", "ReceivingSession", "ReceivingLine"],
    sensors: ["SUPPLIER_CREATED", "SUPPLIER_UPDATED", "SUPPLIER_DEACTIVATED", "SUPPLIER_REACTIVATED", "SUPPLIER_PURCHASE_DRAFT_REJECTED",
      "PURCHASE_ORDER_STATUS_SETTLED", "PURCHASE_ORDER_REMAINDER_DECIDED"],
    legacyEvents: [], routes: ["page/suppliers"],
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM" },
  },
  {
    key: "inventory", name: "Inventory", coverage: "LEARNS",
    rules: ["INV-02", "INV-04", "INV-05"], temporalRules: ["T-INV-02", "T-INV-04"], otherUnits: [],
    l0: ["inventory-alerts"],
    models: ["InventoryCategory", "InventoryItem", "InventoryMovement", "InventoryAlert", "InventoryDraft", "InventoryPendingMatch",
      "InventoryExternalSale", "InventorySale", "InventorySaleLine", "InventorySourceSaleLine", "InventoryItemAsset"],
    sensors: ["INVENTORY_ITEM_CREATED", "INVENTORY_ITEM_UPDATED", "INVENTORY_RECEIVING_POSTED", "INVENTORY_DRAFT_DECIDED"],
    legacyEvents: [], routes: ["api/inventory", "page/inventory"],
    target: { coverage: "LEARNS", plan: "Add sales velocity per item from recorded sales (InventorySale/SaleLine; POS ingestion stays blocked)." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM", note: "POS stock defect blocks stock-outcome families." },
  },

  /* ─────────────────────────── income side (deep) ─────────────────────────── */
  {
    key: "billing", name: "Billing (invoices, quotes, receipts, credit notes)", coverage: "LEARNS",
    rules: ["BILL-01", "BILL-02", "BILL-03", "BILL-04", "BILL-05"], temporalRules: ["T-BILL-01", "T-BILL-02"], otherUnits: ["cross-domain:X-COLL-01 (premise)"],
    l0: ["billing-review", "billing-pdf", "billing-draft-age"],
    models: ["BillingDocument", "BillingDocumentLine", "BillingReceiptPayment", "BillingPaymentAllocation", "BillingAuditEvent",
      "BillingDocumentNumberSequence", "FinancialEvent", "HistoricalFiscalDocument"],
    sensors: [],
    legacyEvents: ["BILLING_DRAFT_CREATED", "BILLING_DRAFT_HEADER_UPDATED", "BILLING_DRAFT_LINES_REPLACED", "BILLING_DOC_ISSUED", "BILLING_DOC_SUBMITTED_FOR_REVIEW",
      "BILLING_DOC_REVERTED_TO_DRAFT", "BILLING_PDF_RENDERED", "BILLING_PDF_RENDER_FAILED", "BILLING_QUOTE_PDF_RENDERED", "BILLING_QUOTE_CONVERTED_TO_INVOICE",
      "BILLING_CREDIT_NOTE_DRAFT_CREATED"],
    routes: ["api/billing", "page/billing"],
    target: { coverage: "LEARNS", plan: "Invoicing cadence, quote→invoice conversion and lag, credit-note rate, invoice → payment days and lateness vs resolved terms; temporal stability/change/anomaly." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "HIGH" },
  },
  {
    key: "payments-in", name: "Payments-in / payment links", coverage: "LEARNS",
    rules: ["PAY-01", "PAY-02"], temporalRules: ["T-PAY-02"], otherUnits: [], l0: ["payment-link-age"],
    models: ["BusinessPaymentConnection", "PaymentRequest", "PaymentTransaction", "PaymentAccountingSettlement", "PaymentProviderRouting",
      "PaymentWebhookEvent", "PaymentAuditEvent"],
    sensors: [], legacyEvents: [], routes: ["api/payments", "page/payments"],
    target: { coverage: "LEARNS", plan: "Payment-link conversion, time from link to paid (PaymentRequest.paidAt), expiry/cancel rate; temporal change/anomaly." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "HIGH" },
  },
  {
    key: "collection", name: "Collection (receivables, reminders)", coverage: "LEARNS",
    rules: ["COLL-01", "COLL-02"], temporalRules: [], otherUnits: ["cross-domain:X-COLL-01"], l0: [],
    models: ["CollectionAction"], sensors: [], legacyEvents: [], routes: ["api/collection", "page/collection"],
    target: { coverage: "LEARNS", plan: "Reminder timing relative to due date, reminder → payment sequence (sequence, never cause), share of overdue receivables collected." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "HIGH", note: "Currently excluded from M9 (no invoice link on a reminder, refunds not netted)." },
  },
  {
    key: "customers", name: "Customers (CRM card)", coverage: "LEARNS",
    rules: ["CUST-01", "CUST-02", "CUST-03"], temporalRules: ["T-CUST-01"], otherUnits: [], l0: [],
    models: ["Customer", "CrmNote", "CrmAttachment"],
    sensors: ["CUSTOMER_CREATED", "CUSTOMER_UPDATED", "CUSTOMER_ARCHIVED", "CUSTOMER_REACTIVATED", "CUSTOMER_TAX_IDENTITY_CHANGED"],
    legacyEvents: [], routes: ["api/customers", "api/customer", "api/crm", "page/customers"],
    target: { coverage: "LEARNS", plan: "Per customer (domain FK customerId, no inference): payment habit, lateness vs terms, ticket size, invoicing cadence; churn from archive/reactivate sensors." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM" },
  },

  /* ─────────────────────────── other business features ─────────────────────────── */
  {
    key: "leads", name: "Leads", coverage: "LEARNS",
    rules: ["LEAD-01", "LEAD-02", "LEAD-03", "LEAD-04"], temporalRules: ["T-LEAD-01"], otherUnits: [], l0: ["leads-attention"],
    models: ["Lead", "LeadLifecycleEvent"],
    sensors: ["LEAD_LIFECYCLE_STARTED", "LEAD_STAGE_CHANGED", "LEAD_OUTCOME_RECORDED", "LEAD_NEXT_ACTION_SCHEDULED", "LEAD_NEXT_ACTION_COMPLETED",
      "LEAD_FIRST_HANDLED", "LEAD_VALUE_RECORDED"],
    legacyEvents: ["LEAD_CREATED", "LEAD_UPDATED", "LEAD_STATUS_CHANGED", "LEAD_FOLLOWUP_SET", "LEAD_FOLLOWUP_RESCHEDULED", "LEAD_FOLLOWUP_COMPLETED",
      "LEAD_WON", "LEAD_LOST", "LEAD_CREATED_FROM_CONVERSATION", "LEAD_CONVERSATION_LINKED"],
    routes: ["api/leads", "page/leads"],
    target: { coverage: "LEARNS", plan: "From LeadLifecycleEvent: time to first handling, stage durations, win/loss rate, follow-up punctuality; temporal." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM" },
  },
  {
    key: "conversations", name: "Conversations / inbox", coverage: "LEARNS",
    rules: ["CONV-01", "CONV-02"], temporalRules: ["T-CONV-01"], otherUnits: [], l0: ["attention-queue"],
    models: ["Conversation", "Message"],
    sensors: ["CONVERSATION_OPENED_MANUALLY", "CONVERSATION_CLOSED", "CONVERSATION_HUMAN_TAKEOVER"],
    legacyEvents: ["CONVERSATION_INBOUND_RECEIVED", "CONVERSATION_BUSINESS_RESPONDED", "CONVERSATION_BECAME_HOT", "CONVERSATION_STAGE_ADVANCED"],
    routes: ["api/conversations", "api/conversation", "api/message", "api/inbox", "page/inbox"],
    target: { coverage: "LEARNS", plan: "From Message sentAt: response latency, unanswered share, resolution time; temporal." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM" },
  },
  {
    key: "reply-suggestions", name: "Reply suggestions / starter bot", coverage: "BLOCKED",
    reason: "Evidence boundary (SENSOR_COVERAGE.md GAP): suggestion shown / selected / edited / sent are client-asserted and non-atomic, and sentMessageId is never written. Learning adoption from it would learn what the browser claimed. Unblocks when the send path binds the suggestion server-side: a product change to the send contract.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["ReplySuggestion", "BusinessBotSettings", "BusinessBot", "Recommendation", "RecommendationOutcome"],
    sensors: ["BOT_SETTINGS_CHANGED"], legacyEvents: [], routes: ["api/reply-suggestion"],
    target: { coverage: "LEARNS", plan: "Owner behaviour (observable only): suggestion adoption and edit rate from ReplySuggestion timestamps." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "LOW" },
  },
  {
    key: "appointments", name: "Appointments", coverage: "LEARNS",
    rules: ["APPT-01", "APPT-02", "APPT-03", "APPT-04"], temporalRules: ["T-APPT-03"], otherUnits: [], l0: [],
    models: ["Appointment"], sensors: ["APPOINTMENT_STATUS_CHANGED", "APPOINTMENT_RESCHEDULED"], legacyEvents: [], routes: ["api/appointments"],
    target: { coverage: "LEARNS", plan: "No-show and cancellation rate, booking lead time, reschedule rate — status history from the observation sensors (Appointment keeps no history)." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "MEDIUM" },
  },
  {
    key: "secretary", name: "Payment Secretary (obligations)", coverage: "LEARNS",
    rules: ["SEC-01", "SEC-02"], temporalRules: [], otherUnits: [], l0: [],
    models: ["BusinessObligation", "BusinessObligationOrientation", "InstallmentWorkflow", "Task"],
    sensors: ["OBLIGATION_CHANGED"], legacyEvents: [], routes: ["api/obligations", "page/secretary"],
    target: { coverage: "LEARNS", plan: "Owner behaviour (observable only): lag between 'handled' and the real payment, snooze habit (InstallmentWorkflow) — handled ≠ paid." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "LOW" },
  },
  {
    key: "coupons", name: "Coupons / revenue (marketing center)", coverage: "BLOCKED",
    reason: "OWNER GATE: Offer, Coupon and RedemptionEvent are PENDING_OWNER_DECISION in tenant-table-rls-guard (tenant-owned, no database isolation yet). Learning must not read a table whose tenant boundary is undecided; unblocks when the owner decides those policies.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["Offer", "Coupon", "RedemptionEvent", "CouponSurfaceEvent"], sensors: [],
    legacyEvents: ["REVENUE_COUPON_CREATED", "REVENUE_COUPON_CREATE_REJECTED", "REVENUE_COUPON_PUBLISHED", "REVENUE_COUPON_DISABLED", "REVENUE_COUPON_ENABLED",
      "REVENUE_COUPON_REDEEMED", "REVENUE_COUPON_REDEEM_REJECTED", "REVENUE_OFFER_CREATED"],
    routes: ["api/revenue", "api/coupons", "page/revenue", "page/promotions"],
    target: { coverage: "LEARNS", plan: "Redemption rate and time from issue to redemption per offer (Coupon, RedemptionEvent)." },
    outcome: { observableAction: true, observableOutcome: true, ownerDecisionRelevant: true, recommendationPotential: "LOW" },
  },
  {
    key: "offering", name: "Offering / services catalogue", coverage: "LEARNS",
    rules: ["OFF-01"], temporalRules: [], otherUnits: [], l0: [],
    models: ["BusinessService", "BusinessServiceAsset", "BusinessAsset", "OfferingDemandSignal", "ServiceCostProfile"], sensors: [], legacyEvents: [],
    routes: [],
    target: { coverage: "LEARNS", plan: "Demand per offering (booking/purchase signals) — cadence and change over time." },
    outcome: { observableAction: false, observableOutcome: true, ownerDecisionRelevant: false, recommendationPotential: "LOW" },
  },
  {
    key: "notifications", name: "Notifications", coverage: "NOT_LEARNING_RELEVANT",
    reason: "Decided in SENSOR_COVERAGE.md (Notification read = NOT_LEARNING_RELEVANT): alerts are Dubiz talking to the owner, and their read/dismiss timing describes the inbox, not the business. The underlying domains learn from their own ledgers.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["Notification", "NotificationDelivery"], sensors: [], legacyEvents: [], routes: ["api/notifications", "page/notifications"],
    target: { coverage: "LEARNS", plan: "Owner behaviour (observable only): responsiveness to alerts — first surfaced → read/resolved, per domain." },
    outcome: { observableAction: true, observableOutcome: false, ownerDecisionRelevant: false, recommendationPotential: "NONE" },
  },
  {
    key: "reports", name: "Reports / accountant export", coverage: "LEARNS",
    rules: ["REP-01"], temporalRules: [], otherUnits: [], l0: [],
    models: [], sensors: ["DATA_EXPORTED"], legacyEvents: [], routes: ["api/reports", "page/dashboard"],
    target: { coverage: "LEARNS", plan: "Owner behaviour (observable only): accountant-pack export cadence — the only record is the DATA_EXPORTED observation sensor." },
    outcome: { observableAction: true, observableOutcome: false, ownerDecisionRelevant: false, recommendationPotential: "LOW" },
  },
  {
    key: "content", name: "Content & video", coverage: "BLOCKED",
    reason: "Evidence boundary (SENSOR_COVERAGE.md): ContentRun is NOT_LEARNING_RELEVANT tool internals, and a post is owner-reported at LINK time, not publish time, with no platform verification. A cadence of link times would teach data-entry rhythm. Unblocks with a publish timestamp (or a verified platform post): a product change.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["ContentRun", "ContentVariant", "ContentEvent", "ContentRender", "ContentFeedback"], sensors: [],
    legacyEvents: ["CONTENT_POST_LINKED", "CONTENT_POST_PERFORMANCE_RECORDED"],
    routes: ["api/content", "api/video", "page/content", "page/posts"],
    target: { coverage: "L1_LIMITED", plan: "Production cadence; reported post performance is an owner CLAIM, never a fact." },
    outcome: { observableAction: true, observableOutcome: false, ownerDecisionRelevant: false, recommendationPotential: "LOW", note: "Performance is owner-reported; no platform verification." },
  },

  /* ───────────────────────── relationships / channels ───────────────────────── */
  {
    key: "identity", name: "Party / identity resolution", coverage: "RELATIONSHIPS",
    reason: "Contributes SAME_COUNTERPARTY relationships (M5) for supplier, payee and document vendor; customer subjects await the owner's identity decision.",
    rules: [], temporalRules: [], otherUnits: ["M5 entity identity", "cross-domain:X-PARTY-01"], l0: [],
    models: ["Party", "PartyResolutionClaim", "EntityLinkProposal", "IdentityLink", "IdentityProposal", "RiaCanonicalReferent", "RiaPolicyLineage"],
    sensors: ["IDENTITY_PROPOSAL_DECIDED"], legacyEvents: [], routes: ["api/identity"],
    target: { coverage: "RELATIONSHIPS", plan: "Customer subject in the deterministic resolver — OWNER GATE (identifiers, purpose, persistence, privacy, deletion)." },
    outcome: { observableAction: true, observableOutcome: false, ownerDecisionRelevant: true, recommendationPotential: "LOW" },
  },
  {
    key: "intake", name: "Business intake (unified ingress)", coverage: "CHANNEL", channelOf: ["conversations", "leads", "customers"],
    reason: "Every inbound event becomes a receipt routed into conversations/leads/customers; its evidence is learned there, against IntakeEvent.occurredAt (business time). M6 acquisition connections are its trusted source mapping (configuration, not evidence); the lead's source is learned through LEAD_LIFECYCLE_STARTED.intakeSource.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["IntakeEvent", "IntakeNormalizedEvent", "AcquisitionConnection"], sensors: ["INTAKE_EVENT_SETTLED", "INTAKE_IDENTITY_RESOLVED"], legacyEvents: [], routes: ["api/intake"],
    outcome: NO_OUTCOME,
  },
  {
    key: "whatsapp", name: "WhatsApp integration", coverage: "CHANNEL", channelOf: ["conversations", "intake", "documents"],
    reason: "Delivery channel: messages are learned in conversations, attachments in documents.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["WhatsAppConnection", "WhatsAppAttachmentImport"], sensors: [], legacyEvents: [], routes: ["api/integrations"],
    outcome: NO_OUTCOME,
  },
  {
    key: "gmail-import", name: "Gmail document import", coverage: "CHANNEL", channelOf: ["documents"],
    reason: "Delivery channel for documents; learned through the documents intake-channel mix.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["EmailConnection", "EmailAttachmentImport"], sensors: [], legacyEvents: [], routes: [],
    outcome: NO_OUTCOME,
  },
  {
    key: "inbound-email", name: "Inbound email (forward-to address)", coverage: "CHANNEL", channelOf: ["documents"],
    reason: "Delivery channel for documents. Behind INBOUND_EMAIL_ENABLED (off) and no mail-receiving route exists yet — dormant channel.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["InboundEmailAddress", "InboundEmailMessage", "InboundEmailAttachmentImport", "InboundEmailAuthorizedSender", "InboundEmailSenderChallenge"],
    sensors: [], legacyEvents: ["INBOUND_EMAIL_ADDRESS_CREATED", "INBOUND_EMAIL_ADDRESS_ROTATED", "INBOUND_EMAIL_ADDRESS_REVOKED", "INBOUND_EMAIL_SENDER_ADDED", "INBOUND_EMAIL_SENDER_REVOKED"],
    routes: ["api/inbound-email"],
    outcome: NO_OUTCOME,
  },

  /* ───────────────────────── decided non-learning classes ───────────────────────── */
  {
    key: "pos", name: "POS integration", coverage: "BLOCKED",
    reason: "No POS connector is registered and no route provisions a POSApiKey; the pending-match path corrupts stock (documented product defect). Manually recorded sales are learned under inventory.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["POSApiKey", "POSProductMapping"], sensors: ["POS_SALE_INGESTED", "POS_PENDING_MATCH_RESOLVED"], legacyEvents: [], routes: [],
    outcome: NO_OUTCOME,
  },
  {
    key: "tax-authority", name: "Tax Authority (ITA) allocation numbers", coverage: "NOT_LEARNING_RELEVANT",
    reason: "A regulatory allocation-number lifecycle on issued invoices; it carries no business behaviour of the owner's business beyond what billing learns.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["BillingAuthorityConnection", "BillingAuthoritySubmission", "BillingAuthorityApp"], sensors: [], legacyEvents: [], routes: ["api/taxes"],
    outcome: NO_OUTCOME,
  },
  {
    key: "pricing", name: "Pricing (calculator)", coverage: "NOT_LEARNING_RELEVANT",
    reason: "A what-if calculator with no ledger of prices actually charged (orphan page); actual prices are learned from billing and offering.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["PricingProfile", "PricingCalculation", "PricingRecommendation"], sensors: [], legacyEvents: [], routes: ["api/pricing", "page/pricing"],
    outcome: NO_OUTCOME,
  },
  {
    key: "business-identity", name: "Business identity / profile", coverage: "L0_ONLY",
    reason: "Owner-confirmed identity statements/facts reach the BKS as OWNER_DECISION context; profile changes are an interpretation boundary, not a behaviour.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["BusinessProfile", "BusinessIdentityStatement", "BusinessIdentityFactAuthority", "BusinessTrustClaim"],
    sensors: ["BUSINESS_PROFILE_CHANGED", "BILLING_IDENTITY_CHANGED"], legacyEvents: [], routes: ["api/business", "page/business", "page/onboarding"],
    outcome: NO_OUTCOME,
  },
  {
    key: "deals", name: "Deals / collaboration opportunities", coverage: "DORMANT",
    reason: "Orphan page (/opportunities has no inbound link); AI-generated partner suggestions; the Deal model has no writer.",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["Deal", "CollaborationDeal"], sensors: [], legacyEvents: ["DEAL_CREATED", "DEAL_ACCEPTED", "DEAL_DISMISSED"],
    routes: ["api/deals", "page/opportunities"],
    outcome: NO_OUTCOME,
  },
  {
    key: "offers-legacy", name: "Offers (legacy coupon backend)", coverage: "LEGACY_ALIAS", aliasOf: "coupons",
    reason: "Superseded by the atomic coupon publish path; its rows are the same Offer/Coupon models learned under coupons.",
    rules: [], temporalRules: [], otherUnits: [], l0: [], models: [], sensors: [], legacyEvents: [], routes: ["api/offers", "page/offers"],
    outcome: NO_OUTCOME,
  },
  {
    key: "search", name: "Search (financial records)", coverage: "NOT_LEARNING_RELEVANT",
    reason: "Read-only lookup; produces no business evidence.",
    rules: [], temporalRules: [], otherUnits: [], l0: [], models: [], sensors: [], legacyEvents: [], routes: ["api/search", "page/search"],
    outcome: NO_OUTCOME,
  },
  {
    key: "data-transfer", name: "Data import / export (migration)", coverage: "NOT_LEARNING_RELEVANT",
    reason: "One-off migration from another system; imported business rows are learned in their own features (export cadence under reports).",
    rules: [], temporalRules: [], otherUnits: [], l0: [], models: ["ImportRun", "ImportRunRow"], sensors: [], legacyEvents: [], routes: ["api/data-transfer"],
    outcome: NO_OUTCOME,
  },
  {
    key: "home", name: "Home (business day)", coverage: "AGGREGATOR",
    rules: [], temporalRules: [], otherUnits: [], l0: [], models: [], sensors: [], legacyEvents: [], routes: ["api/home", "page/app", "page/tools"],
    outcome: NO_OUTCOME,
  },
  {
    key: "attention", name: "Attention / exception engine", coverage: "AGGREGATOR",
    rules: [], temporalRules: [], otherUnits: [], l0: [], models: [], sensors: [], legacyEvents: [], routes: ["api/business-status", "page/attention"],
    outcome: NO_OUTCOME,
  },
  {
    key: "knowledge", name: "Knowledge / insights / outcomes (the business brain)", coverage: "META",
    rules: [], temporalRules: [], otherUnits: [], l0: [],
    models: ["KnowledgeMeasure", "KnowledgeMeasureEvidenceLink", "TemporalKnowledge", "BusinessInsight", "OutcomeRecommendation", "OutcomeDecision",
      "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment", "KnowledgeDerivationRun", "LearningEvent", "LearningSignal",
      "DerivationPolicy", "DerivationPolicyVersion", "DerivedClaimCandidate"],
    sensors: ["INSIGHT_DECIDED"], legacyEvents: [], routes: ["api/knowledge", "api/insights", "api/outcomes"],
    outcome: NO_OUTCOME,
  },
];

/**
 * Not business features: authentication, platform administration, security, configuration, dev/demo
 * surfaces and generic infrastructure. Declared so that the route/model guards can tell "infrastructure"
 * from "a business feature nobody decided about".
 */
export const INFRASTRUCTURE = {
  models: ["User", "Business", "ProductUsageEvent", "BusinessFeatureAccess", "Usage", "AuthSession", "AuthSessionSecret", "PlatformAdminMfa",
    "PlatformAuditEvent", "PlatformFeatureDefinition", "PlatformFeaturePolicy", "OAuthToken", "ExtractedData", "ExtractionEvidence", "MessageAnalysis",
    "BusinessBotProfile", "BotGoalSelection", "BusinessBotSetupDraft", "BusinessBotKnowledge", "BusinessBotRecommendation", "BusinessBotMemoryPolicy",
    "BusinessBotLearningSuggestion"],
  routes: ["api/account", "api/audit", "api/auth", "api/dev", "api/health", "api/platform-admin", "api/security",
    "page/settings", "page/login", "page/register", "page/dev", "page/brand-animation-demo", "page/coupon-design", "page/test-upload", "page/upload",
    "page/admin", "page/about", "page/contact", "page/data-deletion", "page/home", "page/home-prototype", "page/privacy", "page/terms"],
  /** ProductUsageEvent is PLATFORM TELEMETRY (feature usage, platform-scoped), never business learning evidence. */
  platformTelemetry: ["ProductUsageEvent"],
} as const;

/** The only files allowed to write LearningEvent (the two governed writers, plus erasure's own audit). */
export const LEARNING_EVENT_WRITERS = ["lib/sensors/record-sensor.ts", "lib/services/audit.service.ts"] as const;

/**
 * LearningEvent writes that bypass both governed writers. LEGACY_AUDIT: kept for historical continuity,
 * never learning evidence. CLOSED SET — the coverage test fails on any new one.
 */
export const LEGACY_DIRECT_LEARNING_EVENT_WRITERS = [
  "lib/collaboration/matchingEngine.ts",
  "app/api/deals/[id]/route.ts",
  "app/api/content/social-post-link/route.ts",
  "app/api/content/social-post-performance/route.ts",
  "lib/services/account/account-deletion.prisma-store.ts",
] as const;
