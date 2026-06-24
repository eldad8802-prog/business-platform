/**
 * In-memory `PaymentStore` — used by tests and local experiments.
 *
 * Mirrors the Prisma store's contract, including the (provider,
 * providerEventId) idempotency gate, so the services behave identically
 * whether backed by Postgres or this fake.
 */

import type {
  CreatePaymentRequestRow,
  CreateTransactionRow,
  InsertWebhookEventRow,
  ListPaymentRequestsOptions,
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestPatch,
  PaymentRequestRecord,
  PaymentStore,
  PaymentTransactionRecord,
  PaymentWebhookEventRecord,
  WebhookEventPatch,
} from "./payments.types";

export interface InMemoryPaymentStore extends PaymentStore {
  /** Seed an active/inactive connection for a business. */
  seedConnection(connection: Partial<PaymentConnectionRecord> & {
    businessId: number;
    provider: PaymentProvider;
  }): PaymentConnectionRecord;
  readonly requests: PaymentRequestRecord[];
  readonly transactions: PaymentTransactionRecord[];
  readonly webhookEvents: PaymentWebhookEventRecord[];
}

export function createInMemoryPaymentStore(): InMemoryPaymentStore {
  const connections: PaymentConnectionRecord[] = [];
  const requests: PaymentRequestRecord[] = [];
  const transactions: PaymentTransactionRecord[] = [];
  const webhookEvents: PaymentWebhookEventRecord[] = [];

  let connectionSeq = 0;
  let requestSeq = 0;
  let transactionSeq = 0;
  let webhookSeq = 0;

  return {
    requests,
    transactions,
    webhookEvents,

    seedConnection(connection) {
      const record: PaymentConnectionRecord = {
        id: ++connectionSeq,
        businessId: connection.businessId,
        provider: connection.provider,
        merchantId: connection.merchantId ?? "test-merchant",
        credentialEncrypted: connection.credentialEncrypted ?? null,
        credentialIv: connection.credentialIv ?? null,
        credentialTag: connection.credentialTag ?? null,
        encryptionKeyId: connection.encryptionKeyId ?? null,
        isActive: connection.isActive ?? true,
      };
      connections.push(record);
      return record;
    },

    async findActiveConnection(businessId, provider) {
      const found = connections.find(
        (c) => c.businessId === businessId && c.provider === provider && c.isActive
      );
      return found ?? null;
    },

    async createPaymentRequest(row: CreatePaymentRequestRow) {
      const record: PaymentRequestRecord = {
        id: ++requestSeq,
        businessId: row.businessId,
        customerId: row.customerId,
        billingDocumentId: row.billingDocumentId,
        provider: row.provider,
        amount: row.amount,
        currency: row.currency,
        description: row.description,
        status: row.status,
        paymentUrl: null,
        providerRequestId: null,
        expiresAt: row.expiresAt,
        paidAt: null,
      };
      requests.push(record);
      return { ...record };
    },

    async updatePaymentRequest(id: number, patch: PaymentRequestPatch) {
      const record = requests.find((r) => r.id === id);
      if (!record) throw new Error(`PaymentRequest ${id} not found`);
      if (patch.status !== undefined) record.status = patch.status;
      if (patch.paymentUrl !== undefined) record.paymentUrl = patch.paymentUrl;
      if (patch.providerRequestId !== undefined)
        record.providerRequestId = patch.providerRequestId;
      if (patch.expiresAt !== undefined) record.expiresAt = patch.expiresAt;
      if (patch.paidAt !== undefined) record.paidAt = patch.paidAt;
      return { ...record };
    },

    async findPaymentRequestById(id: number) {
      const record = requests.find((r) => r.id === id);
      return record ? { ...record } : null;
    },

    async findPaymentRequestByProviderRequestId(provider, providerRequestId) {
      const record = [...requests]
        .reverse()
        .find(
          (r) => r.provider === provider && r.providerRequestId === providerRequestId
        );
      return record ? { ...record } : null;
    },

    async listPaymentRequests(
      businessId: number,
      options?: ListPaymentRequestsOptions
    ) {
      return requests
        .filter(
          (r) =>
            r.businessId === businessId &&
            (options?.status ? r.status === options.status : true)
        )
        .slice(-(options?.limit ?? 100))
        .reverse()
        .map((r) => ({ ...r }));
    },

    async createTransaction(row: CreateTransactionRow) {
      const record: PaymentTransactionRecord = {
        id: ++transactionSeq,
        paymentRequestId: row.paymentRequestId,
        provider: row.provider,
        providerTransactionId: row.providerTransactionId,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        rawPayload: row.rawPayload,
      };
      transactions.push(record);
      return { ...record };
    },

    async findTransactionByProviderTransactionId(provider, providerTransactionId) {
      const record = [...transactions]
        .reverse()
        .find(
          (t) =>
            t.provider === provider &&
            t.providerTransactionId === providerTransactionId
        );
      return record ? { ...record } : null;
    },

    async insertWebhookEventIfNew(row: InsertWebhookEventRow) {
      if (row.providerEventId != null) {
        const existing = webhookEvents.find(
          (e) =>
            e.provider === row.provider &&
            e.providerEventId === row.providerEventId
        );
        if (existing) {
          return { created: false, event: { ...existing } };
        }
      }
      const record: PaymentWebhookEventRecord = {
        id: ++webhookSeq,
        provider: row.provider,
        eventType: row.eventType,
        providerEventId: row.providerEventId,
        payload: row.payload,
        processingStatus: "RECEIVED",
        processedAt: null,
        error: null,
      };
      webhookEvents.push(record);
      return { created: true, event: { ...record } };
    },

    async updateWebhookEvent(id: number, patch: WebhookEventPatch) {
      const record = webhookEvents.find((e) => e.id === id);
      if (!record) throw new Error(`PaymentWebhookEvent ${id} not found`);
      if (patch.processingStatus !== undefined)
        record.processingStatus = patch.processingStatus;
      if (patch.processedAt !== undefined) record.processedAt = patch.processedAt;
      if (patch.error !== undefined) record.error = patch.error;
      return { ...record };
    },
  };
}
