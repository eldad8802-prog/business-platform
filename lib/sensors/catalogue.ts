/**
 * M5.5 · The sensor catalogue — every event this contract is allowed to write, and nothing else.
 *
 * This is the machine-readable half of `docs/learning/SENSOR_COVERAGE.md`. A sensor that is not in
 * this list cannot be recorded (`recordSensor` refuses it), and every entry is checked by
 * `lib/sensors/sensors.test.ts`: past-tense occurrence names, no forbidden payload keys, a domain, a
 * version, and a sentence describing what happened.
 *
 * Existing `LearningEvent` types written through `logAuditEvent` (LEAD_*, BILLING_*, REVENUE_*, …) are
 * NOT redefined here: they keep their names so historical rows stay comparable, and now carry an
 * actor and a source. This catalogue holds the sensors that did not exist before M5.5.
 */
import type { SensorDefinition } from "./sensor.contract";

const S = <T extends SensorDefinition>(d: T): T => d;

export const SENSORS = {
  /* ─────────────────────────────── customers ─────────────────────────────── */
  CUSTOMER_CREATED: S({
    eventType: "CUSTOMER_CREATED",
    domain: "customers",
    entityType: "CUSTOMER",
    version: 1,
    payloadKeys: ["origin", "importRunId", "sourceRowNumber", "conversationId", "leadId"],
    describes: "A customer record came into existence, and through which path (UI, lead, WhatsApp, import, billing).",
    consumer: "planned: customer acquisition channel mix",
  }),
  CUSTOMER_UPDATED: S({
    eventType: "CUSTOMER_UPDATED",
    domain: "customers",
    entityType: "CUSTOMER",
    version: 1,
    payloadKeys: ["fields"],
    describes: "The owner changed a customer's details; which fields, never their values.",
    consumer: null,
  }),
  CUSTOMER_ARCHIVED: S({
    eventType: "CUSTOMER_ARCHIVED",
    domain: "customers",
    entityType: "CUSTOMER",
    version: 1,
    payloadKeys: [],
    describes: "The owner marked a customer inactive.",
    consumer: "planned: customer churn",
  }),
  CUSTOMER_REACTIVATED: S({
    eventType: "CUSTOMER_REACTIVATED",
    domain: "customers",
    entityType: "CUSTOMER",
    version: 1,
    payloadKeys: [],
    describes: "The owner marked an inactive customer active again.",
    consumer: "planned: customer churn",
  }),
  CUSTOMER_TAX_IDENTITY_CHANGED: S({
    eventType: "CUSTOMER_TAX_IDENTITY_CHANGED",
    domain: "customers",
    entityType: "CUSTOMER",
    version: 1,
    payloadKeys: ["fields"],
    describes: "The owner changed a customer's billing tax identity; which fields, never their values.",
    consumer: null,
  }),

  /* ─────────────────────────────── appointments ─────────────────────────────── */
  APPOINTMENT_STATUS_CHANGED: S({
    eventType: "APPOINTMENT_STATUS_CHANGED",
    domain: "appointments",
    entityType: "APPOINTMENT",
    version: 1,
    payloadKeys: ["from", "to"],
    describes: "An appointment moved between lifecycle states (confirmed, completed, cancelled, no-show).",
    consumer: "planned: no-show and cancellation rate",
  }),
  APPOINTMENT_RESCHEDULED: S({
    eventType: "APPOINTMENT_RESCHEDULED",
    domain: "appointments",
    entityType: "APPOINTMENT",
    version: 1,
    payloadKeys: ["previousStartsAt", "startsAt", "durationChanged"],
    describes: "An appointment's time was changed; the previous and new start.",
    consumer: "planned: reschedule rate",
  }),

  /* ─────────────────────────────── suppliers / purchasing ─────────────────────────────── */
  SUPPLIER_CREATED: S({
    eventType: "SUPPLIER_CREATED",
    domain: "suppliers",
    entityType: "SUPPLIER",
    version: 1,
    payloadKeys: ["origin", "importRunId", "sourceRowNumber", "hasTaxId"],
    describes: "A supplier record came into existence, and through which path (UI or import).",
    consumer: "M5 identity resolution (subjects)",
  }),
  SUPPLIER_UPDATED: S({
    eventType: "SUPPLIER_UPDATED",
    domain: "suppliers",
    entityType: "SUPPLIER",
    version: 1,
    payloadKeys: ["fields", "taxIdChanged"],
    describes: "The owner changed a supplier's details; which fields, never their values.",
    consumer: "M5 identity resolution (a changed tax id changes what may bind)",
  }),
  SUPPLIER_DEACTIVATED: S({
    eventType: "SUPPLIER_DEACTIVATED",
    domain: "suppliers",
    entityType: "SUPPLIER",
    version: 1,
    payloadKeys: [],
    describes: "The owner marked a supplier inactive.",
    consumer: "SUPP-01 freshness (a quiet supplier)",
  }),
  SUPPLIER_REACTIVATED: S({
    eventType: "SUPPLIER_REACTIVATED",
    domain: "suppliers",
    entityType: "SUPPLIER",
    version: 1,
    payloadKeys: [],
    describes: "The owner marked an inactive supplier active again.",
    consumer: null,
  }),
  SUPPLIER_PURCHASE_DRAFT_REJECTED: S({
    eventType: "SUPPLIER_PURCHASE_DRAFT_REJECTED",
    domain: "purchasing",
    entityType: "SUPPLIER_PURCHASE_DRAFT",
    version: 1,
    payloadKeys: ["lineCount"],
    describes: "The owner rejected a supplier purchase draft that intake had proposed.",
    consumer: "planned: intake precision",
  }),
  PURCHASE_ORDER_STATUS_SETTLED: S({
    eventType: "PURCHASE_ORDER_STATUS_SETTLED",
    domain: "purchasing",
    entityType: "PURCHASE_ORDER",
    version: 1,
    payloadKeys: ["from", "to"],
    describes: "A purchase order reached a new settled status (e.g. CLOSED) after receiving or a remainder decision, and when.",
    consumer: "SUPP-02 (closure time)",
  }),
  PURCHASE_ORDER_REMAINDER_DECIDED: S({
    eventType: "PURCHASE_ORDER_REMAINDER_DECIDED",
    domain: "purchasing",
    entityType: "PURCHASE_ORDER_LINE",
    version: 1,
    payloadKeys: ["purchaseOrderId", "from", "to"],
    describes: "The owner decided what happens to an undelivered remainder (backorder or close short).",
    consumer: "SUPP-03 (short deliveries the owner accepted)",
  }),

  /* ─────────────────────────────── inventory / POS ─────────────────────────────── */
  INVENTORY_ITEM_CREATED: S({
    eventType: "INVENTORY_ITEM_CREATED",
    domain: "inventory",
    entityType: "INVENTORY_ITEM",
    version: 1,
    payloadKeys: ["origin", "importRunId", "sourceRowNumber", "pendingMatchId", "supplierPurchaseDraftId"],
    describes: "An inventory item came into existence, and through which path.",
    consumer: "INV-* (item population)",
  }),
  INVENTORY_ITEM_UPDATED: S({
    eventType: "INVENTORY_ITEM_UPDATED",
    domain: "inventory",
    entityType: "INVENTORY_ITEM",
    version: 1,
    payloadKeys: ["fields", "identityChanged", "thresholdsChanged", "deactivated", "reactivated"],
    describes: "The owner changed an item; which fields, and whether its SKU/barcode or stock thresholds changed.",
    consumer: "INV-05 (a moved threshold changes what 'pressure' means)",
  }),
  INVENTORY_RECEIVING_POSTED: S({
    eventType: "INVENTORY_RECEIVING_POSTED",
    domain: "inventory",
    entityType: "RECEIVING_SESSION",
    version: 1,
    payloadKeys: ["purchaseOrderId", "movementIds", "lineCount"],
    describes: "A receiving session was posted; the stock movements it produced, as structured ids.",
    consumer: "SUPP-02, INV-02 (movement ↔ receipt provenance)",
  }),
  POS_SALE_INGESTED: S({
    eventType: "POS_SALE_INGESTED",
    domain: "inventory",
    entityType: "INVENTORY_EXTERNAL_SALE",
    version: 1,
    payloadKeys: ["externalSaleId", "posSource", "movementIds", "lineCount", "outcome"],
    describes: "A POS sale arrived and was applied to stock, or held for matching; the movements it produced.",
    consumer: "planned: sales velocity (POS-sourced only)",
  }),
  POS_PENDING_MATCH_RESOLVED: S({
    eventType: "POS_PENDING_MATCH_RESOLVED",
    domain: "inventory",
    entityType: "INVENTORY_PENDING_MATCH",
    version: 1,
    payloadKeys: ["mode", "externalSaleId", "movementIds", "mappingReplaced"],
    describes: "The owner resolved a held POS sale (link, create, or reject); the movement it produced.",
    consumer: "planned: POS mapping precision",
  }),
  INVENTORY_DRAFT_DECIDED: S({
    eventType: "INVENTORY_DRAFT_DECIDED",
    domain: "inventory",
    entityType: "INVENTORY_DRAFT",
    version: 1,
    payloadKeys: ["decision", "itemId"],
    describes: "The owner approved, merged or rejected a photo-detected inventory draft.",
    consumer: "planned: photo detection precision",
  }),

  /* ─────────────────────────────── documents / data ─────────────────────────────── */
  DOCUMENT_INGESTED: S({
    eventType: "DOCUMENT_INGESTED",
    domain: "documents",
    entityType: "DOCUMENT",
    version: 1,
    payloadKeys: ["origin", "forcedDuplicate", "importRunId", "sourceRowNumber"],
    describes: "A document entered the system, through which path, and whether the owner forced a duplicate in.",
    consumer: "DOC-04 (intake channel), DOC-06 (correction rate per channel)",
  }),
  DOCUMENT_REPROCESS_REQUESTED: S({
    eventType: "DOCUMENT_REPROCESS_REQUESTED",
    domain: "documents",
    entityType: "DOCUMENT",
    version: 1,
    payloadKeys: ["outcome"],
    describes: "The owner asked for a document to be extracted again.",
    consumer: "planned: extraction reliability",
  }),
  DATA_EXPORTED: S({
    eventType: "DATA_EXPORTED",
    domain: "data",
    entityType: "BUSINESS",
    version: 1,
    payloadKeys: ["kind", "format", "rowCount"],
    describes: "The owner exported business data out of Dubiz; which kind and how much.",
    consumer: null,
  }),

  /* ─────────────────────────────── conversations ─────────────────────────────── */
  CONVERSATION_OPENED_MANUALLY: S({
    eventType: "CONVERSATION_OPENED_MANUALLY",
    domain: "conversations",
    entityType: "CONVERSATION",
    version: 1,
    payloadKeys: ["channel", "linkedCustomer", "linkedLead"],
    describes: "The owner opened a conversation by hand (not from an inbound message).",
    consumer: null,
  }),
  CONVERSATION_CLOSED: S({
    eventType: "CONVERSATION_CLOSED",
    domain: "conversations",
    entityType: "CONVERSATION",
    version: 1,
    payloadKeys: ["previousStatus"],
    describes: "The owner closed a conversation.",
    consumer: "planned: conversation resolution time",
  }),
  CONVERSATION_HUMAN_TAKEOVER: S({
    eventType: "CONVERSATION_HUMAN_TAKEOVER",
    domain: "conversations",
    entityType: "CONVERSATION",
    version: 1,
    payloadKeys: ["draftsDismissed"],
    describes: "The owner took a conversation over from the bot; how many pending drafts were dismissed.",
    consumer: "planned: bot handoff rate",
  }),

  /* ─────────────────────────────── settings ─────────────────────────────── */
  BUSINESS_PROFILE_CHANGED: S({
    eventType: "BUSINESS_PROFILE_CHANGED",
    domain: "settings",
    entityType: "BUSINESS",
    version: 1,
    payloadKeys: ["fields", "fromBusinessModel", "toBusinessModel"],
    // category is free text, so it appears only by name in `fields`; businessModel is a validated enum.
    describes: "The owner changed how the business describes itself (category, business model).",
    consumer: "every rule's interpretation of the business (M6 baselines reset on a model change)",
  }),
  BILLING_IDENTITY_CHANGED: S({
    eventType: "BILLING_IDENTITY_CHANGED",
    domain: "settings",
    entityType: "BUSINESS",
    version: 1,
    payloadKeys: ["fields", "fromBusinessKind", "toBusinessKind", "taxIdChanged", "vatNumberChanged"],
    describes: "The owner changed the business's billing identity; VAT status as from/to, identifiers as a flag only.",
    consumer: "billing interpretation (VAT status changes what an amount means)",
  }),
  BOT_SETTINGS_CHANGED: S({
    eventType: "BOT_SETTINGS_CHANGED",
    domain: "settings",
    entityType: "BUSINESS",
    version: 1,
    payloadKeys: ["fields", "fromEnabled", "toEnabled", "fromMode", "toMode"],
    describes: "The owner changed the assistant's settings; whether it was switched on or off, and its mode.",
    consumer: "planned: response latency (a bot being on changes what 'the business replied' means)",
  }),

  /* ─────────────────────────────── insights ─────────────────────────────── */
  INSIGHT_DECIDED: S({
    eventType: "INSIGHT_DECIDED",
    domain: "insights",
    entityType: "BUSINESS_INSIGHT",
    version: 1,
    payloadKeys: ["from", "to", "insightKind", "composerVersion", "noteGiven"],
    describes: "The owner explicitly decided on an insight; the previous and new decision. Silence writes nothing.",
    consumer: "M9 recommendation/outcome learning",
  }),

  /* ─────────────────────────────── payables (legacy obligations) ─────────────────────────────── */
  OBLIGATION_CHANGED: S({
    eventType: "OBLIGATION_CHANGED",
    domain: "payables",
    entityType: "BUSINESS_OBLIGATION",
    version: 1,
    payloadKeys: ["action", "fields", "amountChanged", "dueAtChanged"],
    describes: "A legacy obligation was created, edited, snoozed, completed, released, oriented or continued by its series.",
    consumer: "planned: legacy obligation handling (the Commitment ledger has its own audit)",
  }),
} as const;

export type SensorKey = keyof typeof SENSORS;
