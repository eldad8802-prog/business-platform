/**
 * Prisma-backed implementation of the `PaymentStore` port.
 *
 * This is the only payments file that touches Prisma. It maps between the
 * domain string-literal unions and the generated Prisma enums (identical
 * values by construction) and serializes Decimal amounts as strings.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantContext, runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { assertBusinessAcceptsWritesTx } from "@/lib/tenant/business-lifecycle";
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

// D2/P7-W4E: every tenant-owned payment table is FORCE-RLS'd, so each DB step
// runs on a short tenant transaction whenever a tenant context is established.
// Outside a context the step runs directly — that path exists ONLY for pure
// unit tests; there is NO global fallback under an established context.
async function dbStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx as unknown as typeof prisma));
  }
  return fn(prisma);
}

// D2/AD-2A: the same step, plus a race-safe account-deletion gate INSIDE the
// transaction. A webhook that resolved its tenant while the business was healthy can
// still be mid-flight when erasure begins; a pre-flight check would already be stale.
// The guard takes a row lock on Business, so it serialises against the quarantine
// transition: either this write commits first, or the transition did and this throws.
// Used for the two OPERATIONAL settlement writes — the money row and the request
// status. Reads stay ungated: a quarantined tenant may still be read, only not written.
async function guardedDbStep<T>(
  businessId: number,
  fn: (db: typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction(async (tx) => {
      await assertBusinessAcceptsWritesTx(tx, businessId);
      return fn(tx as unknown as typeof prisma);
    });
  }
  return fn(prisma);
}

// Explicit BOOTSTRAP boundary. These operations run before any tenant is known
// (a provider callback names only its own ids) and touch only tables that are
// deliberately outside tenant RLS: PaymentWebhookEvent (no businessId, DB-level
// idempotent on (provider, providerEventId)) and PaymentProviderRouting
// (routing columns only). Keeping them in a separate, named helper is what
// makes "no global fallback" auditable — CI-W4E-2 asserts that no OTHER call
// in this file reaches the global client.
function bootstrapStep<T>(fn: (db: typeof prisma) => Promise<T>): Promise<T> {
  return fn(prisma);
}

export function createPaymentPrismaStore(): PaymentStore {
  return {
    async findActiveConnection(businessId, provider) {
      const row = await dbStep((db) => db.businessPaymentConnection.findUnique({
        where: { businessId_provider: { businessId, provider } },
      }));
      if (!row || !row.isActive) return null;
      return toConnectionRecord(row);
    },

    async upsertConnection(row: UpsertConnectionRow) {
      const saved = await dbStep((db) => db.businessPaymentConnection.upsert({
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
      }));
      return toConnectionRecord(saved);
    },

    async listConnections(businessId: number) {
      const rows = await dbStep((db) => db.businessPaymentConnection.findMany({
        where: { businessId },
        orderBy: { id: "asc" },
      }));
      return rows.map(toConnectionRecord);
    },

    async createPaymentRequest(row: CreatePaymentRequestRow) {
      const created = await dbStep((db) => db.paymentRequest.create({
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
      }));
      return toRequestRecord(created);
    },

    async updatePaymentRequest(id: number, patch: PaymentRequestPatch) {
      const tenant = getTenantContext();
      const step = tenant
        ? <T,>(f: (db: typeof prisma) => Promise<T>) => guardedDbStep(tenant.businessId, f)
        : dbStep;
      const updated = await step((db) => db.paymentRequest.update({
        where: { id },
        data: {
          status: patch.status,
          paymentUrl: patch.paymentUrl,
          providerRequestId: patch.providerRequestId,
          expiresAt: patch.expiresAt,
          paidAt: patch.paidAt,
        },
      }));
      return toRequestRecord(updated);
    },

    async findPaymentRequestById(id: number) {
      const row = await dbStep((db) => db.paymentRequest.findUnique({ where: { id } }));
      return row ? toRequestRecord(row) : null;
    },

    // D2/P7-W4E — the ONLY tenant-resolution step, and what the whole
    // provider-callback trust model rests on. It runs pre-context by
    // construction: a webhook names its own (provider, providerRequestId) and
    // nothing else. PaymentRequest is FORCE-RLS'd, so this reads in TWO stages:
    //   1. BOOTSTRAP: the routing index (routing columns only) yields businessId.
    //   2. TENANT: the full request is then read under that derived context, so
    //      the row itself still comes back from an RLS-enforced query.
    // The payload never nominates the tenant; the routing row was written by
    // the owner-authenticated creation flow.
    async findPaymentRequestByProviderRequestId(provider, providerRequestId) {
      const route = await bootstrapStep((db) =>
        db.paymentProviderRouting.findUnique({
          where: {
            provider_providerRequestId: { provider, providerRequestId },
          },
          select: { paymentRequestId: true, businessId: true },
        })
      );
      if (!route) return null;

      // CONSISTENCY GATE. The routing row is a HINT, never the authority. The
      // stored PaymentRequest is the authority, so the parent is fetched with
      // BOTH the routed id AND the routed businessId in the predicate: a row
      // comes back only when
      //     PaymentRequest.businessId === PaymentProviderRouting.businessId
      // holds, which is exactly the equality this gate has to establish. A
      // corrupted routing row — pointing at a missing request, or at another
      // tenant's request in either direction — therefore yields nothing, and
      // nothing downstream ever runs. FORCE RLS makes this observable only as
      // "not found": under the candidate tenant's own GUC another tenant's row
      // is invisible by construction, which is the correct security posture but
      // means missing and mismatched are indistinguishable here — so both are
      // treated as the same hard failure and logged loudly.
      const row = await runWithTenantContext(
        { businessId: route.businessId },
        () =>
          withTenantTransaction((tx) =>
            tx.paymentRequest.findFirst({
              where: {
                id: route.paymentRequestId,
                businessId: route.businessId,
              },
            })
          )
      );
      if (!row) {
        console.error(
          "[payments-routing] INCONSISTENT ROUTING — refusing to resolve a tenant:",
          {
            provider,
            paymentRequestId: route.paymentRequestId,
            routedBusinessId: route.businessId,
            reason: "parent missing or owned by another business",
          }
        );
        return null;
      }
      // Belt and braces: the authority downstream is the STORED parent's own
      // businessId, never the routing hint. Identical by the predicate above —
      // asserted so a future refactor of the query cannot silently regress it.
      if (row.businessId !== route.businessId) {
        console.error(
          "[payments-routing] ROUTING/PARENT MISMATCH — refusing to resolve a tenant:",
          { provider, paymentRequestId: route.paymentRequestId }
        );
        return null;
      }
      return toRequestRecord(row);
    },

    // Routing rows are written by the owner-authenticated creation flow that
    // also stores providerRequestId. Idempotent on paymentRequestId so a
    // retried link creation cannot fork a request's routing, and unique on
    // (provider, providerRequestId) so two tenants can never claim the same
    // provider reference.
    async upsertProviderRouting(row) {
      await bootstrapStep((db) =>
        db.paymentProviderRouting.upsert({
          where: { paymentRequestId: row.paymentRequestId },
          create: {
            provider: row.provider,
            providerRequestId: row.providerRequestId,
            paymentRequestId: row.paymentRequestId,
            businessId: row.businessId,
          },
          update: {
            provider: row.provider,
            providerRequestId: row.providerRequestId,
          },
        })
      );
    },

    async listPaymentRequests(
      businessId: number,
      options?: ListPaymentRequestsOptions
    ) {
      const rows = await dbStep((db) => db.paymentRequest.findMany({
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
      }));
      return rows.map(toRequestRecord);
    },

    async listPaymentRequestsByStatuses(businessId, statuses, options) {
      const rows = await dbStep((db) => db.paymentRequest.findMany({
        where: { businessId, status: { in: statuses } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: options?.limit ?? 500,
      }));
      return rows.map(toRequestRecord);
    },

    async sumPaidBetween(businessId, from, to) {
      const agg = await dbStep((db) => db.paymentRequest.aggregate({
        where: { businessId, status: "PAID", paidAt: { gte: from, lt: to } },
        _sum: { amount: true },
        _count: { _all: true },
      }));
      return {
        amount: (agg._sum.amount ?? new Prisma.Decimal(0)).toString(),
        count: agg._count._all,
      };
    },

    async createTransaction(row: CreateTransactionRow) {
      const tenant = getTenantContext();
      const step = tenant
        ? <T,>(f: (db: typeof prisma) => Promise<T>) => guardedDbStep(tenant.businessId, f)
        : dbStep;
      const created = await step((db) => db.paymentTransaction.create({
        data: {
          paymentRequestId: row.paymentRequestId,
          provider: row.provider,
          providerTransactionId: row.providerTransactionId,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          rawPayload: toJsonInput(row.rawPayload),
        },
      }));
      return toTransactionRecord(created);
    },

    async findTransactionByProviderTransactionId(
      provider,
      providerTransactionId
    ) {
      const row = await dbStep((db) => db.paymentTransaction.findFirst({
        where: { provider, providerTransactionId },
        orderBy: { id: "desc" },
      }));
      return row ? toTransactionRecord(row) : null;
    },

    async listTransactionsByRequest(paymentRequestId: number) {
      const rows = await dbStep((db) => db.paymentTransaction.findMany({
        where: { paymentRequestId },
        orderBy: { id: "asc" },
      }));
      return rows.map(toTransactionRecord);
    },

    async insertWebhookEventIfNew(row: InsertWebhookEventRow) {
      try {
        const created = await bootstrapStep((db) => db.paymentWebhookEvent.create({
          data: {
            provider: row.provider,
            eventType: row.eventType,
            providerEventId: row.providerEventId,
            payload: toJsonInput(row.payload),
            processingStatus: "RECEIVED",
          },
        }));
        return { created: true, event: toWebhookRecord(created) };
      } catch (error) {
        // Unique (provider, providerEventId) violation => already ingested.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          row.providerEventId != null
        ) {
          const existing = await bootstrapStep((db) => db.paymentWebhookEvent.findFirst({
            where: {
              provider: row.provider,
              providerEventId: row.providerEventId,
            },
            orderBy: { id: "asc" },
          }));
          if (existing) {
            return { created: false, event: toWebhookRecord(existing) };
          }
        }
        throw error;
      }
    },

    async updateWebhookEvent(id: number, patch: WebhookEventPatch) {
      const updated = await bootstrapStep((db) => db.paymentWebhookEvent.update({
        where: { id },
        data: {
          processingStatus: patch.processingStatus,
          processedAt: patch.processedAt,
          error: patch.error,
        },
      }));
      return toWebhookRecord(updated);
    },

    async appendAuditEvent(row: AppendPaymentAuditEventRow) {
      const created = await dbStep((db) => db.paymentAuditEvent.create({
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
      }));
      return toAuditRecord(created);
    },

    async listAuditEvents(
      businessId: number,
      options?: ListPaymentAuditEventsOptions
    ) {
      const rows = await dbStep((db) => db.paymentAuditEvent.findMany({
        where: {
          businessId,
          ...(options?.paymentRequestId != null
            ? { paymentRequestId: options.paymentRequestId }
            : {}),
          ...(options?.eventType ? { eventType: options.eventType } : {}),
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: options?.limit ?? 100,
      }));
      return rows.map(toAuditRecord);
    },
  };
}
