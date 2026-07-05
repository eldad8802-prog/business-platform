/**
 * Prisma-backed implementation of the `PaymentStore` port.
 *
 * This is the only payments file that touches Prisma. It maps between the
 * domain string-literal unions and the generated Prisma enums (identical
 * values by construction) and serializes Decimal amounts as strings.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  AppendPaymentAuditEventRow,
  CreatePaymentRequestRow,
  CreateTransactionRow,
  InsertWebhookEventRow,
  ListPaymentAuditEventsOptions,
  ListPaymentRequestsOptions,
  PaymentAuditEventRecord,
  PaymentAuditSource,
  PaymentConnectionRecord,
  PaymentProvider,
  PaymentRequestPatch,
  PaymentRequestRecord,
  PaymentStore,
  PaymentTransactionRecord,
  PaymentWebhookEventRecord,
  UpsertConnectionRow,
  WebhookEventPatch,
} from "./payments.types";

type ConnectionRow = {
  id: number;
  businessId: number;
  provider: string;
  merchantId: string | null;
  credentialEncrypted: string | null;
  credentialIv: string | null;
  credentialTag: string | null;
  encryptionKeyId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type RequestRow = {
  id: number;
  businessId: number;
  customerId: number | null;
  billingDocumentId: number | null;
  provider: string;
  amount: Prisma.Decimal;
  currency: string;
  description: string | null;
  status: string;
  paymentUrl: string | null;
  providerRequestId: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
};

type TransactionRow = {
  id: number;
  paymentRequestId: number;
  provider: string;
  providerTransactionId: string | null;
  amount: Prisma.Decimal;
  currency: string;
  status: string;
  rawPayload: Prisma.JsonValue | null;
  createdAt: Date;
};

type WebhookRow = {
  id: number;
  provider: string;
  eventType: string | null;
  providerEventId: string | null;
  payload: Prisma.JsonValue;
  processingStatus: string;
  processedAt: Date | null;
  error: string | null;
};

function toConnectionRecord(row: ConnectionRow): PaymentConnectionRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    provider: row.provider as PaymentProvider,
    merchantId: row.merchantId,
    credentialEncrypted: row.credentialEncrypted,
    credentialIv: row.credentialIv,
    credentialTag: row.credentialTag,
    encryptionKeyId: row.encryptionKeyId,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRequestRecord(row: RequestRow): PaymentRequestRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    customerId: row.customerId,
    billingDocumentId: row.billingDocumentId,
    provider: row.provider as PaymentProvider,
    amount: row.amount.toString(),
    currency: row.currency,
    description: row.description,
    status: row.status as PaymentRequestRecord["status"],
    paymentUrl: row.paymentUrl,
    providerRequestId: row.providerRequestId,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

function toTransactionRecord(row: TransactionRow): PaymentTransactionRecord {
  return {
    id: row.id,
    paymentRequestId: row.paymentRequestId,
    provider: row.provider as PaymentProvider,
    providerTransactionId: row.providerTransactionId,
    amount: row.amount.toString(),
    currency: row.currency,
    status: row.status as PaymentTransactionRecord["status"],
    rawPayload: row.rawPayload,
    createdAt: row.createdAt,
  };
}

type AuditRow = {
  id: number;
  businessId: number;
  paymentRequestId: number | null;
  actorUserId: number | null;
  eventType: string;
  source: string;
  summary: string;
  metadata: Prisma.JsonValue | null;
  eventHash: string;
  occurredAt: Date;
  createdAt: Date;
};

function toAuditRecord(row: AuditRow): PaymentAuditEventRecord {
  return {
    id: row.id,
    businessId: row.businessId,
    paymentRequestId: row.paymentRequestId,
    actorUserId: row.actorUserId,
    eventType: row.eventType,
    source: row.source as PaymentAuditSource,
    summary: row.summary,
    metadata: row.metadata,
    eventHash: row.eventHash,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function toWebhookRecord(row: WebhookRow): PaymentWebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider as PaymentProvider,
    eventType: row.eventType,
    providerEventId: row.providerEventId,
    payload: row.payload,
    processingStatus:
      row.processingStatus as PaymentWebhookEventRecord["processingStatus"],
    processedAt: row.processedAt,
    error: row.error,
  };
}

function toJsonInput(value: unknown): Prisma.InputJsonValue {
  // Strings/objects/numbers are all valid JSON column values. Undefined is
  // not, so coalesce to null wrapped as JSON.
  return (value ?? null) as Prisma.InputJsonValue;
}

export function createPaymentPrismaStore(): PaymentStore {
  return {
    async findActiveConnection(businessId, provider) {
      const row = await prisma.businessPaymentConnection.findUnique({
        where: { businessId_provider: { businessId, provider } },
      });
      if (!row || !row.isActive) return null;
      return toConnectionRecord(row);
    },

    async upsertConnection(row: UpsertConnectionRow) {
      const saved = await prisma.businessPaymentConnection.upsert({
        where: {
          businessId_provider: {
            businessId: row.businessId,
            provider: row.provider,
          },
        },
        create: {
          businessId: row.businessId,
          provider: row.provider,
          merchantId: row.merchantId,
          credentialEncrypted: row.credentialEncrypted,
          credentialIv: row.credentialIv,
          credentialTag: row.credentialTag,
          encryptionKeyId: row.encryptionKeyId,
          isActive: row.isActive,
        },
        update: {
          merchantId: row.merchantId,
          credentialEncrypted: row.credentialEncrypted,
          credentialIv: row.credentialIv,
          credentialTag: row.credentialTag,
          encryptionKeyId: row.encryptionKeyId,
          isActive: row.isActive,
        },
      });
      return toConnectionRecord(saved);
    },

    async listConnections(businessId: number) {
      const rows = await prisma.businessPaymentConnection.findMany({
        where: { businessId },
        orderBy: { id: "asc" },
      });
      return rows.map(toConnectionRecord);
    },

    async createPaymentRequest(row: CreatePaymentRequestRow) {
      const created = await prisma.paymentRequest.create({
        data: {
          businessId: row.businessId,
          customerId: row.customerId,
          billingDocumentId: row.billingDocumentId,
          provider: row.provider,
          amount: row.amount,
          currency: row.currency,
          description: row.description,
          status: row.status,
          expiresAt: row.expiresAt,
        },
      });
      return toRequestRecord(created);
    },

    async updatePaymentRequest(id: number, patch: PaymentRequestPatch) {
      const updated = await prisma.paymentRequest.update({
        where: { id },
        data: {
          status: patch.status,
          paymentUrl: patch.paymentUrl,
          providerRequestId: patch.providerRequestId,
          expiresAt: patch.expiresAt,
          paidAt: patch.paidAt,
        },
      });
      return toRequestRecord(updated);
    },

    async findPaymentRequestById(id: number) {
      const row = await prisma.paymentRequest.findUnique({ where: { id } });
      return row ? toRequestRecord(row) : null;
    },

    async findPaymentRequestByProviderRequestId(provider, providerRequestId) {
      const row = await prisma.paymentRequest.findFirst({
        where: { provider, providerRequestId },
        orderBy: { id: "desc" },
      });
      return row ? toRequestRecord(row) : null;
    },

    async listPaymentRequests(
      businessId: number,
      options?: ListPaymentRequestsOptions
    ) {
      const rows = await prisma.paymentRequest.findMany({
        where: {
          businessId,
          ...(options?.status ? { status: options.status } : {}),
          ...(options?.customerId != null
            ? { customerId: options.customerId }
            : {}),
          ...(options?.billingDocumentId != null
            ? { billingDocumentId: options.billingDocumentId }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: options?.limit ?? 100,
      });
      return rows.map(toRequestRecord);
    },

    async listPaymentRequestsByStatuses(businessId, statuses, options) {
      const rows = await prisma.paymentRequest.findMany({
        where: { businessId, status: { in: statuses } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: options?.limit ?? 500,
      });
      return rows.map(toRequestRecord);
    },

    async sumPaidBetween(businessId, from, to) {
      const agg = await prisma.paymentRequest.aggregate({
        where: { businessId, status: "PAID", paidAt: { gte: from, lt: to } },
        _sum: { amount: true },
        _count: { _all: true },
      });
      return {
        amount: (agg._sum.amount ?? new Prisma.Decimal(0)).toString(),
        count: agg._count._all,
      };
    },

    async createTransaction(row: CreateTransactionRow) {
      const created = await prisma.paymentTransaction.create({
        data: {
          paymentRequestId: row.paymentRequestId,
          provider: row.provider,
          providerTransactionId: row.providerTransactionId,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          rawPayload: toJsonInput(row.rawPayload),
        },
      });
      return toTransactionRecord(created);
    },

    async findTransactionByProviderTransactionId(
      provider,
      providerTransactionId
    ) {
      const row = await prisma.paymentTransaction.findFirst({
        where: { provider, providerTransactionId },
        orderBy: { id: "desc" },
      });
      return row ? toTransactionRecord(row) : null;
    },

    async listTransactionsByRequest(paymentRequestId: number) {
      const rows = await prisma.paymentTransaction.findMany({
        where: { paymentRequestId },
        orderBy: { id: "asc" },
      });
      return rows.map(toTransactionRecord);
    },

    async insertWebhookEventIfNew(row: InsertWebhookEventRow) {
      try {
        const created = await prisma.paymentWebhookEvent.create({
          data: {
            provider: row.provider,
            eventType: row.eventType,
            providerEventId: row.providerEventId,
            payload: toJsonInput(row.payload),
            processingStatus: "RECEIVED",
          },
        });
        return { created: true, event: toWebhookRecord(created) };
      } catch (error) {
        // Unique (provider, providerEventId) violation => already ingested.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          row.providerEventId != null
        ) {
          const existing = await prisma.paymentWebhookEvent.findFirst({
            where: {
              provider: row.provider,
              providerEventId: row.providerEventId,
            },
            orderBy: { id: "asc" },
          });
          if (existing) {
            return { created: false, event: toWebhookRecord(existing) };
          }
        }
        throw error;
      }
    },

    async updateWebhookEvent(id: number, patch: WebhookEventPatch) {
      const updated = await prisma.paymentWebhookEvent.update({
        where: { id },
        data: {
          processingStatus: patch.processingStatus,
          processedAt: patch.processedAt,
          error: patch.error,
        },
      });
      return toWebhookRecord(updated);
    },

    async appendAuditEvent(row: AppendPaymentAuditEventRow) {
      const created = await prisma.paymentAuditEvent.create({
        data: {
          businessId: row.businessId,
          paymentRequestId: row.paymentRequestId,
          actorUserId: row.actorUserId,
          eventType: row.eventType,
          source: row.source,
          summary: row.summary,
          metadata:
            row.metadata === null
              ? Prisma.JsonNull
              : (row.metadata as Prisma.InputJsonValue),
          eventHash: row.eventHash,
          occurredAt: row.occurredAt,
        },
      });
      return toAuditRecord(created);
    },

    async listAuditEvents(
      businessId: number,
      options?: ListPaymentAuditEventsOptions
    ) {
      const rows = await prisma.paymentAuditEvent.findMany({
        where: {
          businessId,
          ...(options?.paymentRequestId != null
            ? { paymentRequestId: options.paymentRequestId }
            : {}),
          ...(options?.eventType ? { eventType: options.eventType } : {}),
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: options?.limit ?? 100,
      });
      return rows.map(toAuditRecord);
    },
  };
}
