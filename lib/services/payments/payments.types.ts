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

export type PaymentProvider = "TRANZILA";

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

  createTransaction(
    row: CreateTransactionRow
  ): Promise<PaymentTransactionRecord>;

  findTransactionByProviderTransactionId(
    provider: PaymentProvider,
    providerTransactionId: string
  ): Promise<PaymentTransactionRecord | null>;

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
}
