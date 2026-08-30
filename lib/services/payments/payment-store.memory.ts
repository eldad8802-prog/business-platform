/**
 * In-memory `PaymentStore` — used by tests and local experiments.
 *
 * Mirrors the Prisma store's contract, including the (provider,
 * providerEventId) idempotency gate, so the services behave identically
 * whether backed by Postgres or this fake.
 */

import type {
  AppendPaymentAuditEventRow,
  CreatePaymentRequestRow,
  CreateTransactionRow,
  InsertWebhookEventRow,
  ListPaymentAuditEventsOptions,
  ListPaymentRequestsOptions,
  PaymentAuditEventRecord,
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestPatch,
  PaymentRequestRecord,
  PaymentStore,
  PaymentTransactionRecord,
  PaymentWebhookEventRecord,
  UpsertConnectionRow,
  UpsertProviderRoutingRow,
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
  readonly auditEvents: PaymentAuditEventRecord[];
}

export function createInMemoryPaymentStore(): InMemoryPaymentStore {
  const connections: PaymentConnectionRecord[] = [];
  const requests: PaymentRequestRecord[] = [];
  const transactions: PaymentTransactionRecord[] = [];
  const webhookEvents: PaymentWebhookEventRecord[] = [];
  const routing: UpsertProviderRoutingRow[] = [];
  const auditEvents: PaymentAuditEventRecord[] = [];

  let connectionSeq = 0;
  let requestSeq = 0;
  let transactionSeq = 0;
  let webhookSeq = 0;
  let auditSeq = 0;

  return {
    requests,
    transactions,
    webhookEvents,
    auditEvents,

    seedConnection(connection) {
      const now = new Date();
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
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
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

    async upsertConnection(row: UpsertConnectionRow) {
      const existing = connections.find(
        (c) => c.businessId === row.businessId && c.provider === row.provider
      );
      if (existing) {
        existing.merchantId = row.merchantId;
        existing.credentialEncrypted = row.credentialEncrypted;
        existing.credentialIv = row.credentialIv;
        existing.credentialTag = row.credentialTag;
        existing.encryptionKeyId = row.encryptionKeyId;
        existing.isActive = row.isActive;
        existing.updatedAt = new Date();
        return { ...existing };
      }
      const now = new Date();
      const record: PaymentConnectionRecord = {
        id: ++connectionSeq,
        businessId: row.businessId,
        provider: row.provider,
        merchantId: row.merchantId,
        credentialEncrypted: row.credentialEncrypted,
        credentialIv: row.credentialIv,
        credentialTag: row.credentialTag,
        encryptionKeyId: row.encryptionKeyId,
        isActive: row.isActive,
        createdAt: now,
        updatedAt: now,
      };
      connections.push(record);
      return { ...record };
    },

    async listConnections(businessId: number) {
      return connections
        .filter((c) => c.businessId === businessId)
        .map((c) => ({ ...c }));
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
        createdAt: new Date(),
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

    // D2/P7-W4E — the in-memory fake keeps the same routing contract as the
    // Prisma store so the pure unit tests exercise the real code path. The
    // routing table is the only thing a session-less callback may consult.
    async upsertProviderRouting(row) {
      const existing = routing.findIndex(
        (r) => r.paymentRequestId === row.paymentRequestId
      );
      if (existing >= 0) routing[existing] = { ...row };
      else routing.push({ ...row });
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
            (options?.status ? r.status === options.status : true) &&
            (options?.customerId != null
              ? r.customerId === options.customerId
              : true) &&
            (options?.billingDocumentId != null
              ? r.billingDocumentId === options.billingDocumentId
              : true)
        )
        .slice(-(options?.limit ?? 100))
        .reverse()
        .map((r) => ({ ...r }));
    },

    async listPaymentRequestsByStatuses(businessId, statuses, options) {
      const set = new Set<string>(statuses);
      return requests
        .filter((r) => r.businessId === businessId && set.has(r.status))
        .sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id
        )
        .slice(0, options?.limit ?? 500)
        .map((r) => ({ ...r }));
    },

    async sumPaidBetween(businessId, from, to) {
      const paid = requests.filter(
        (r) =>
          r.businessId === businessId &&
          r.status === "PAID" &&
          r.paidAt != null &&
          r.paidAt.getTime() >= from.getTime() &&
          r.paidAt.getTime() < to.getTime()
      );
      const amount = paid.reduce((sum, r) => sum + Number(r.amount), 0);
      return {
        amount: (Math.round(amount * 100) / 100).toFixed(2),
        count: paid.length,
      };
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
        createdAt: new Date(),
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

    async listTransactionsByRequest(paymentRequestId: number) {
      return transactions
        .filter((t) => t.paymentRequestId === paymentRequestId)
        .map((t) => ({ ...t }));
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

    async appendAuditEvent(row: AppendPaymentAuditEventRow) {
      const now = new Date();
      const record: PaymentAuditEventRecord = {
        id: ++auditSeq,
        businessId: row.businessId,
        paymentRequestId: row.paymentRequestId,
        actorUserId: row.actorUserId,
        eventType: row.eventType,
        source: row.source,
        summary: row.summary,
        metadata: row.metadata,
        eventHash: row.eventHash,
        occurredAt: row.occurredAt,
        createdAt: now,
      };
      auditEvents.push(record);
      return { ...record };
    },

    async listAuditEvents(
      businessId: number,
      options?: ListPaymentAuditEventsOptions
    ) {
      return auditEvents
        .filter(
          (e) =>
            e.businessId === businessId &&
            (options?.paymentRequestId != null
              ? e.paymentRequestId === options.paymentRequestId
              : true) &&
            (options?.eventType ? e.eventType === options.eventType : true)
        )
        .slice(0, options?.limit ?? 100)
        .map((e) => ({ ...e }));
    },
  };
}
