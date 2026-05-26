import { createHash } from "crypto";
import { BillingAuditEvent, Prisma } from "@prisma/client";
import { UnauthorizedError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const BILLING_AUDIT_EVENT_TYPES = [
  "BILLING_DRAFT_CREATED",
  "BILLING_DRAFT_HEADER_UPDATED",
  "BILLING_DRAFT_LINES_REPLACED",
  "BILLING_DOC_SUBMITTED_FOR_REVIEW",
  "BILLING_DOC_REVERTED_TO_DRAFT",
  "BILLING_DOC_ISSUED",
  "BILLING_CREDIT_NOTE_ISSUED",
  "BILLING_QUOTE_CONVERTED_TO_INVOICE",
  "BILLING_CREDIT_NOTE_DRAFT_CREATED",
  "BILLING_PDF_RENDERED",
  "BILLING_PDF_RENDER_FAILED",
  "BILLING_QUOTE_PDF_RENDERED",
] as const;

export type BillingAuditEventType = (typeof BILLING_AUDIT_EVENT_TYPES)[number];

export const BILLING_AUDIT_SOURCES = [
  "USER",
  "SYSTEM",
  "JOB",
  "MIGRATION",
  "API",
] as const;

export type BillingAuditSource = (typeof BILLING_AUDIT_SOURCES)[number];

export type CreateBillingAuditEventInput = {
  businessId: number;
  billingDocumentId?: number | null;
  actorUserId?: number | null;
  eventType: BillingAuditEventType;
  source?: BillingAuditSource;
  summary: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

export type GetBillingDocumentAuditTimelineInput = {
  businessId: number;
  billingDocumentId: number;
};

function assertPositiveInteger(value: number, fieldName: string): void {
  if (
    !value ||
    Number.isNaN(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

function stableJsonStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function hashAuditEvent(input: {
  businessId: number;
  billingDocumentId: number | null;
  actorUserId: number | null;
  eventType: BillingAuditEventType;
  source: BillingAuditSource;
  summary: string;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
}): string {
  return createHash("sha256")
    .update(
      stableJsonStringify({
        businessId: input.businessId,
        billingDocumentId: input.billingDocumentId,
        actorUserId: input.actorUserId,
        eventType: input.eventType,
        source: input.source,
        summary: input.summary,
        metadata: input.metadata,
        occurredAt: input.occurredAt.toISOString(),
      })
    )
    .digest("hex");
}

function normalizeAuditEventInput(input: CreateBillingAuditEventInput): {
  businessId: number;
  billingDocumentId: number | null;
  actorUserId: number | null;
  eventType: BillingAuditEventType;
  source: BillingAuditSource;
  summary: string;
  metadata: Record<string, unknown> | null;
  occurredAt: Date;
  eventHash: string;
} {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new UnauthorizedError();
  }
  assertPositiveInteger(input.businessId, "businessId");

  const source = input.source ?? "USER";
  if (!BILLING_AUDIT_SOURCES.includes(source)) {
    throw new ValidationError("Invalid billing audit source");
  }

  if (!BILLING_AUDIT_EVENT_TYPES.includes(input.eventType)) {
    throw new ValidationError("Invalid billing audit eventType");
  }

  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new ValidationError("Billing audit summary is required");
  }

  const billingDocumentId = input.billingDocumentId ?? null;
  if (billingDocumentId !== null) {
    assertPositiveInteger(billingDocumentId, "billingDocumentId");
  }

  const actorUserId = input.actorUserId ?? null;
  if (actorUserId !== null) {
    assertPositiveInteger(actorUserId, "actorUserId");
  }

  if (source === "USER" && actorUserId === null) {
    throw new ValidationError("actorUserId is required for user audit events");
  }

  if (input.eventType.startsWith("BILLING_") && billingDocumentId === null) {
    throw new ValidationError(
      "billingDocumentId is required for billing document audit events"
    );
  }

  const metadata = input.metadata ?? null;
  if (metadata !== null && typeof metadata !== "object") {
    throw new ValidationError("Billing audit metadata must be an object");
  }

  const occurredAt = input.occurredAt ?? new Date();
  if (Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError("occurredAt must be a valid date");
  }

  const hashInput = {
    businessId: input.businessId,
    billingDocumentId,
    actorUserId,
    eventType: input.eventType,
    source,
    summary,
    metadata,
    occurredAt,
  };

  return {
    ...hashInput,
    eventHash: hashAuditEvent(hashInput),
  };
}

export async function createBillingAuditEventTx(
  tx: Prisma.TransactionClient,
  input: CreateBillingAuditEventInput
): Promise<void> {
  const normalized = normalizeAuditEventInput(input);

  await tx.billingAuditEvent.create({
    data: {
      businessId: normalized.businessId,
      billingDocumentId: normalized.billingDocumentId,
      actorUserId: normalized.actorUserId,
      eventType: normalized.eventType,
      source: normalized.source,
      summary: normalized.summary,
      metadata:
        normalized.metadata === null
          ? Prisma.JsonNull
          : (normalized.metadata as Prisma.InputJsonValue),
      eventHash: normalized.eventHash,
      occurredAt: normalized.occurredAt,
    },
  });
}

export async function createBillingAuditEventBestEffort(
  input: CreateBillingAuditEventInput
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await createBillingAuditEventTx(tx, input);
    });
  } catch (error) {
    console.error("createBillingAuditEventBestEffort error:", error);
  }
}

export async function getBillingDocumentAuditTimeline(
  input: GetBillingDocumentAuditTimelineInput
): Promise<BillingAuditEvent[]> {
  assertPositiveInteger(input.businessId, "businessId");
  assertPositiveInteger(input.billingDocumentId, "billingDocumentId");

  return prisma.billingAuditEvent.findMany({
    where: {
      businessId: input.businessId,
      billingDocumentId: input.billingDocumentId,
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
}
