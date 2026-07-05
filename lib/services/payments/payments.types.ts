/**
 * Payments domain — shared types and the persistence port.
 *
 * P1: Payment Links Foundation. Dubiz is NOT a payment processor:
 *   - We never store card numbers / CVV / card details.
 *   - Payment happens at an external provider via a hosted checkout URL.
 *   - We persist only statuses, identifiers, the payment link, webhook
 *     events, and links to document / customer.
 *
 * Domain status/provider types are plain string-literal unions (independent of
 * the generated Prisma client) so the services and their tests stay pure and
 * DB-free. The Prisma-backed store (`payment-store.prisma.ts`) maps between
 * these unions and Prisma enums — the values are identical by construction.
 */

export type PaymentProvider = "TRANZILA" | "CARDCOM" | "PAYPAL";

export type PaymentRequestStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export type PaymentTransactionStatus =
  | "PENDING"
  | "PAID"
  | "FAILED"
  | "CANCELLED";

export type PaymentWebhookProcessingStatus =
  | "RECEIVED"
  | "PROCESSED"
  | "FAILED"
  | "UNMATCHED";

/** A `PaymentRequestStatus` from which no further provider event should move us. */
export const TERMINAL_REQUEST_STATUSES: ReadonlySet<PaymentRequestStatus> =
  new Set<PaymentRequestStatus>(["PAID", "FAILED", "CANCELLED", "EXPIRED"]);

export function isTerminalRequestStatus(
  status: PaymentRequestStatus
): boolean {
  return TERMINAL_REQUEST_STATUSES.has(status);
}

// --- Persisted record shapes (what the store reads/writes) ---------------

export interface PaymentConnectionRecord {
  id: number;
  businessId: number;
  provider: PaymentProvider;
  merchantId: string | null;
  /** Encrypted provider credential material. NEVER card data. */
  credentialEncrypted: string | null;
  credentialIv: string | null;
  credentialTag: string | null;
  encryptionKeyId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Connection shape safe to return through an API: no credential material at
 * all. `hasCredential` says whether a secret is stored, without exposing it.
 */
export interface PublicPaymentConnection {
  id: number;
  businessId: number;
  provider: PaymentProvider;
  merchantId: string | null;
  isActive: boolean;
  hasCredential: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentRequestRecord {
  id: number;
  businessId: number;
  customerId: number | null;
  billingDocumentId: number | null;
  provider: PaymentProvider;
  /** Decimal serialized as string to avoid float drift. */
  amount: string;
  currency: string;
  description: string | null;
  status: PaymentRequestStatus;
  paymentUrl: string | null;
  providerRequestId: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface PaymentTransactionRecord {
  id: number;
  paymentRequestId: number;
  provider: PaymentProvider;
  providerTransactionId: string | null;
  amount: string;
  currency: string;
  status: PaymentTransactionStatus;
  rawPayload: unknown;
  createdAt: Date;
}

export interface PaymentWebhookEventRecord {
  id: number;
  provider: PaymentProvider;
  eventType: string | null;
  providerEventId: string | null;
  payload: unknown;
  processingStatus: PaymentWebhookProcessingStatus;
  processedAt: Date | null;
  error: string | null;
}

// --- Store inputs --------------------------------------------------------

export interface UpsertConnectionRow {
  businessId: number;
  provider: PaymentProvider;
  merchantId: string | null;
  credentialEncrypted: string | null;
  credentialIv: string | null;
  credentialTag: string | null;
  encryptionKeyId: string | null;
  isActive: boolean;
}

export interface CreatePaymentRequestRow {
  businessId: number;
  customerId: number | null;
  billingDocumentId: number | null;
  provider: PaymentProvider;
  amount: string;
  currency: string;
  description: string | null;
  status: PaymentRequestStatus;
  expiresAt: Date | null;
}

export interface PaymentRequestPatch {
  status?: PaymentRequestStatus;
  paymentUrl?: string | null;
  providerRequestId?: string | null;
  expiresAt?: Date | null;
  paidAt?: Date | null;
}

export interface CreateTransactionRow {
  paymentRequestId: number;
  provider: PaymentProvider;
  providerTransactionId: string | null;
  amount: string;
  currency: string;
  status: PaymentTransactionStatus;
  rawPayload: unknown;
}

export interface InsertWebhookEventRow {
  provider: PaymentProvider;
  eventType: string | null;
  providerEventId: string | null;
  payload: unknown;
}

export interface WebhookEventPatch {
  processingStatus?: PaymentWebhookProcessingStatus;
  processedAt?: Date | null;
  error?: string | null;
}

export interface ListPaymentRequestsOptions {
  status?: PaymentRequestStatus;
  customerId?: number;
  billingDocumentId?: number;
  limit?: number;
}

// --- Audit (M7) ----------------------------------------------------------

/** Origin of an audit event: a person, an engine decision, or the provider. */
export type PaymentAuditSource = "USER" | "SYSTEM" | "PROVIDER";

export interface PaymentAuditEventRecord {
  id: number;
  businessId: number;
  paymentRequestId: number | null;
  actorUserId: number | null;
  eventType: string;
  source: PaymentAuditSource;
  summary: string;
  metadata: unknown;
  eventHash: string;
  occurredAt: Date;
  createdAt: Date;
}

/** Normalized, hashed row the store appends. Append-only — never updated. */
export interface AppendPaymentAuditEventRow {
  businessId: number;
  paymentRequestId: number | null;
  actorUserId: number | null;
  eventType: string;
  source: PaymentAuditSource;
  summary: string;
  metadata: Record<string, unknown> | null;
  eventHash: string;
  occurredAt: Date;
}

export interface ListPaymentAuditEventsOptions {
  paymentRequestId?: number;
  eventType?: string;
  limit?: number;
}

/**
 * Persistence port for the payments domain. Production uses the Prisma-backed
 * implementation; tests use an in-memory fake. Services depend on this
 * interface only — never on Prisma directly — which keeps the create/webhook
 * logic unit-testable without a database.
 */
export interface PaymentStore {
  findActiveConnection(
    businessId: number,
    provider: PaymentProvider
  ): Promise<PaymentConnectionRecord | null>;

  /** Create or update a business's connection for a provider (unique per pair). */
  upsertConnection(
    row: UpsertConnectionRow
  ): Promise<PaymentConnectionRecord>;

  /** All connections for a business (credentials included — caller must redact). */
  listConnections(businessId: number): Promise<PaymentConnectionRecord[]>;

  createPaymentRequest(
    row: CreatePaymentRequestRow
  ): Promise<PaymentRequestRecord>;

  updatePaymentRequest(
    id: number,
    patch: PaymentRequestPatch
  ): Promise<PaymentRequestRecord>;

  findPaymentRequestById(id: number): Promise<PaymentRequestRecord | null>;

  findPaymentRequestByProviderRequestId(
    provider: PaymentProvider,
    providerRequestId: string
  ): Promise<PaymentRequestRecord | null>;

  listPaymentRequests(
    businessId: number,
    options?: ListPaymentRequestsOptions
  ): Promise<PaymentRequestRecord[]>;

  /**
   * List a business's requests across MANY statuses at once, newest-first.
   * Read-only; powers the collection workspace working-set + history reads.
   */
  listPaymentRequestsByStatuses(
    businessId: number,
    statuses: PaymentRequestStatus[],
    options?: { limit?: number }
  ): Promise<PaymentRequestRecord[]>;

  /**
   * Sum + count of VERIFIED collections (status PAID) whose `paidAt` falls in
   * [from, to). Read-only aggregation for the "collected this month" figure —
   * PAID is verified truth (Authority), so this never counts an unverified ask.
   */
  sumPaidBetween(
    businessId: number,
    from: Date,
    to: Date
  ): Promise<{ amount: string; count: number }>;

  createTransaction(
    row: CreateTransactionRow
  ): Promise<PaymentTransactionRecord>;

  findTransactionByProviderTransactionId(
    provider: PaymentProvider,
    providerTransactionId: string
  ): Promise<PaymentTransactionRecord | null>;

  /** All settlement records for one request, oldest-first (ledger read). */
  listTransactionsByRequest(
    paymentRequestId: number
  ): Promise<PaymentTransactionRecord[]>;

  /**
   * Insert a webhook event, deduplicating on (provider, providerEventId).
   * Returns `created: false` plus the existing row when the same event id was
   * already ingested — this is the first idempotency gate. Rows with a null
   * providerEventId cannot be deduplicated here and are always created;
   * downstream transaction-level idempotency still prevents double effects.
   */
  insertWebhookEventIfNew(
    row: InsertWebhookEventRow
  ): Promise<{ created: boolean; event: PaymentWebhookEventRecord }>;

  updateWebhookEvent(
    id: number,
    patch: WebhookEventPatch
  ): Promise<PaymentWebhookEventRecord>;

  /**
   * Append-only audit insert (M7). There is deliberately no update or delete:
   * the payments audit trail can only grow. Callers build the hashed row via
   * the payment-audit service and emit best-effort.
   */
  appendAuditEvent(
    row: AppendPaymentAuditEventRow
  ): Promise<PaymentAuditEventRecord>;

  listAuditEvents(
    businessId: number,
    options?: ListPaymentAuditEventsOptions
  ): Promise<PaymentAuditEventRecord[]>;
}
