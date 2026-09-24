/**
 * M5.5 · The Business Sensor contract.
 *
 * A SENSOR REPORTS WHAT HAPPENED. A LEARNING RULE DECIDES WHAT CAN BE LEARNED FROM IT.
 *
 *   GOOD  OWNER_INITIATED_COLLECTION_REMINDER · INVENTORY_QUANTITY_CORRECTED · LEAD_MARKED_LOST
 *   BAD   CUSTOMER_WAS_PRESSURED_TO_PAY       · DEMAND_INCREASED             · LEAD_WAS_LOW_QUALITY
 *
 * WHAT THIS IS NOT. Not a second copy of evidence the product already keeps authoritatively.
 * Billing, payments, payables, document review and collection reminders each have their own
 * append-only ledger (BillingAuditEvent, PaymentAuditEvent, PayablesAuditEvent, ReviewEvent,
 * CollectionAction), written in the same transaction as the action. Those ledgers ARE the sensors for
 * their domains, and duplicating them here would create two versions of one truth. This contract
 * covers the actions that had no durable trace at all — and it is the canonical shape for any new one.
 *
 * WHO AND HOW ARE TWO QUESTIONS.
 *   actor   who caused it — a person of this business, Dubiz itself, an external system, or unknown
 *   source  the channel it arrived through — the owner's UI, a file import, an integration, a job
 *
 *   An owner importing a CSV is actor OWNER_USER + source IMPORT. Collapsing the two would make
 *   "did a person do this?" and "was this typed or imported?" impossible to ask separately.
 *
 * FAIL-OPEN, AND WHY THAT IS SAFE HERE. Everything written through this contract is learning
 * evidence about an action the product has ALREADY recorded authoritatively in its own tables. A
 * sensor failure must never be able to stop a customer being saved. Where the event itself is part of
 * an authoritative operation (issuing an invoice, settling a payment), the domain ledger is used, and
 * those are not fail-open.
 *
 * Inside a caller's transaction the sensor is written behind a SAVEPOINT: atomic with the action
 * when both succeed, and rolled back ALONE when only the sensor fails.
 */

/** Who caused the action. Mirrors the `LearningEventActor` enum. */
export type SensorActor =
  | { readonly type: "OWNER_USER"; readonly userId: number }
  | { readonly type: "SYSTEM" }
  | { readonly type: "INTEGRATION" }
  | { readonly type: "UNKNOWN" };

/** The channel the action arrived through. Mirrors the `LearningEventSource` enum. */
export type SensorSource = "OWNER_UI" | "IMPORT" | "INTEGRATION" | "SYSTEM" | "API" | "UNKNOWN";

export type SensorDomain =
  | "customers"
  | "leads"
  | "appointments"
  | "suppliers"
  | "purchasing"
  | "inventory"
  | "documents"
  | "billing"
  | "payables"
  | "conversations"
  | "settings"
  | "insights"
  | "revenue"
  | "account"
  | "data";

/**
 * A payload value. Deliberately narrow: identifiers, enums, counts, flags, dates as ISO strings, and
 * lists of those. There is no room for a paragraph, and that is the point — see `MAX_STRING`.
 */
export type SensorScalar = string | number | boolean | null;
export type SensorValue = SensorScalar | readonly SensorScalar[];
export type SensorPayload = Readonly<Record<string, SensorValue>>;

/**
 * Longest string a payload may carry. Enum labels, field names, status names and external ids fit;
 * a customer's name, a message, a free-text reason or an address mostly do not — and the catalogue
 * never admits a key for one. The length cap is the second lock on the same door.
 */
export const MAX_STRING = 100;
export const MAX_LIST = 50;

/**
 * Keys that are refused in EVERY sensor payload regardless of the catalogue, because what they name
 * is personal data, message content, a secret, or free text. A catalogue entry that tried to admit
 * one would fail the catalogue's own test.
 */
export const FORBIDDEN_KEY =
  /(name|phone|email|address|text|content|message|body|note|reason|token|secret|password|qr|iban|account ?number|snapshot)$/i;

export type SensorDefinition = {
  /** The persisted `eventType`. Past tense, describing an occurrence — never an interpretation. */
  readonly eventType: string;
  readonly domain: SensorDomain;
  /** The persisted `entityType`: what `entityId` points at. */
  readonly entityType: string;
  /** Payload shape version. Bump when a key changes meaning. */
  readonly version: number;
  /** The ONLY keys this sensor may write. Anything else is refused. */
  readonly payloadKeys: readonly string[];
  /** One sentence: what occurred. Never why. */
  readonly describes: string;
  /** The rule or planned consumer, or null when the sensor exists for completeness of the record. */
  readonly consumer: string | null;
};
