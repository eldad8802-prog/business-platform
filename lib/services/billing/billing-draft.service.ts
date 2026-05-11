import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
  Prisma,
} from "@prisma/client";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { canEditDraft } from "@/lib/services/billing/domain/billing-status.machine";
import type { BillingLineInputRaw } from "@/lib/services/billing/domain/billing.types";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import {
  validateAndParseLineInput,
  validateDraftHeaderInput,
} from "@/lib/services/billing/validation/billing-line.validation";

export type CreateBillingDraftInput = {
  businessId: number;
  actorUserId: number | null;
  documentType: BillingDocumentType;
  customerId?: number | null;
  customerNameSnapshot?: string | null;
  initialLines?: BillingLineInputRaw[];
};

export type UpdateBillingDraftHeaderInput = {
  businessId: number;
  actorUserId: number | null;
  billingDocumentId: number;
  customerId?: number | null;
  customerNameSnapshot?: string | null;
  /** ISO date string (yyyy-mm-dd) or full ISO datetime; null clears */
  validUntil?: string | null;
};

export type ReplaceBillingDraftLinesInput = {
  businessId: number;
  actorUserId: number | null;
  billingDocumentId: number;
  lines: BillingLineInputRaw[];
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }
}

async function resolveCustomerForCreate(
  businessId: number,
  customerId?: number | null,
  customerNameSnapshot?: string | null
): Promise<{ customerId: number | null; customerNameSnapshot: string | null }> {
  const parsed = validateDraftHeaderInput({
    customerId: customerId ?? undefined,
    customerNameSnapshot: customerNameSnapshot ?? undefined,
  });

  if (parsed.customerId !== null) {
    const customer = await prisma.customer.findFirst({
      where: { id: parsed.customerId, businessId },
      select: { id: true, name: true },
    });
    if (!customer) {
      throw new ValidationError(
        "customerId does not belong to this business"
      );
    }
    const snapshot =
      parsed.customerNameSnapshot !== null
        ? parsed.customerNameSnapshot
        : customer.name;
    return { customerId: customer.id, customerNameSnapshot: snapshot };
  }

  return {
    customerId: null,
    customerNameSnapshot: parsed.customerNameSnapshot,
  };
}

async function persistLinesAndTotals(
  tx: Prisma.TransactionClient,
  billingDocumentId: number,
  businessId: number,
  lines: BillingLineInputRaw[]
): Promise<{
  totals: [Prisma.Decimal, Prisma.Decimal, Prisma.Decimal];
  lineCount: number;
}> {
  const parsed = lines.map((raw, i) =>
    validateAndParseLineInput(
      {
        description: raw.description,
        quantity: raw.quantity,
        unitPrice: raw.unitPrice,
        vatRatePercent: raw.vatRatePercent,
      },
      i + 1
    )
  );

  const { lines: computed, totals } = recomputeAll(parsed);

  await tx.billingDocumentLine.deleteMany({
    where: { billingDocumentId },
  });

  if (computed.length > 0) {
    await tx.billingDocumentLine.createMany({
      data: computed.map((line) => ({
        billingDocumentId,
        lineIndex: line.lineIndex,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        vatRatePercent: line.vatRatePercent,
        lineSubtotal: line.lineSubtotal,
        vatAmount: line.vatAmount,
        lineTotal: line.lineTotal,
      })),
    });
  }

  const updated = await tx.billingDocument.updateMany({
    where: {
      id: billingDocumentId,
      businessId,
      status: {
        in: [
          BillingDocumentStatus.DRAFT,
          BillingDocumentStatus.PENDING_REVIEW,
        ],
      },
    },
    data: {
      subtotalAmount: totals.subtotalAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
    },
  });

  if (updated.count !== 1) {
    throw new ForbiddenError(
      "Document state changed during line replacement"
    );
  }

  return {
    totals: [
      totals.subtotalAmount,
      totals.vatAmount,
      totals.totalAmount,
    ],
    lineCount: computed.length,
  };
}

export async function createBillingDraft(
  input: CreateBillingDraftInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  assertBusinessId(input.businessId);

  const { customerId, customerNameSnapshot } = await resolveCustomerForCreate(
    input.businessId,
    input.customerId,
    input.customerNameSnapshot
  );

  const initialLines = input.initialLines ?? [];

  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.billingDocument.create({
      data: {
        businessId: input.businessId,
        documentType: input.documentType,
        status: BillingDocumentStatus.DRAFT,
        currency: "ILS",
        pdfRenderStatus: BillingPdfRenderStatus.PENDING,
        createdByUserId: input.actorUserId,
        customerId,
        customerNameSnapshot,
        subtotalAmount: new Prisma.Decimal(0),
        vatAmount: new Prisma.Decimal(0),
        totalAmount: new Prisma.Decimal(0),
      },
    });

    if (initialLines.length > 0) {
      await persistLinesAndTotals(tx, created.id, input.businessId, initialLines);
    }

    return tx.billingDocument.findFirstOrThrow({
      where: { id: created.id, businessId: input.businessId },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DRAFT_CREATED",
    entityType: "BILLING_DOCUMENT",
    entityId: doc.id,
    payload: {
      documentId: doc.id,
      documentType: input.documentType,
      customerId: doc.customerId,
      lineCount: doc.lines.length,
      actorUserId: input.actorUserId,
    },
  });

  return doc;
}

export async function updateBillingDraftHeader(
  input: UpdateBillingDraftHeaderInput
): Promise<BillingDocument> {
  assertBusinessId(input.businessId);

  const existing = await prisma.billingDocument.findFirst({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
    },
  });

  if (!existing) {
    throw new NotFoundError("Billing document not found");
  }

  if (!canEditDraft(existing.status)) {
    throw new ForbiddenError("Document is not editable");
  }

  if (existing.convertedToInvoiceId !== null) {
    throw new ForbiddenError("לא ניתן לערוך הצעה שכבר הומרה לחשבונית");
  }

  const data: Prisma.BillingDocumentUncheckedUpdateManyInput = {};

  if (input.customerId !== undefined) {
    if (input.customerId === null) {
      data.customerId = null;
      data.customerNameSnapshot = null;
    } else {
      const customer = await prisma.customer.findFirst({
        where: { id: input.customerId, businessId: input.businessId },
        select: { id: true, name: true },
      });
      if (!customer) {
        throw new ValidationError(
          "customerId does not belong to this business"
        );
      }
      data.customerId = customer.id;
      if (
        input.customerNameSnapshot !== undefined &&
        input.customerNameSnapshot !== null
      ) {
        const parsed = validateDraftHeaderInput({
          customerId: customer.id,
          customerNameSnapshot: input.customerNameSnapshot,
        });
        data.customerNameSnapshot = parsed.customerNameSnapshot;
      } else {
        data.customerNameSnapshot = customer.name;
      }
    }
  } else if (input.customerNameSnapshot !== undefined) {
    const parsed = validateDraftHeaderInput({
      customerId: existing.customerId ?? undefined,
      customerNameSnapshot: input.customerNameSnapshot,
    });
    data.customerNameSnapshot = parsed.customerNameSnapshot;
  }

  if (input.validUntil !== undefined) {
    if (existing.documentType !== BillingDocumentType.QUOTE) {
      throw new ValidationError("validUntil applies only to quote documents");
    }
    if (input.validUntil === null || input.validUntil === "") {
      data.validUntil = null;
    } else {
      const d = new Date(input.validUntil);
      if (Number.isNaN(d.getTime())) {
        throw new ValidationError("validUntil must be a valid date");
      }
      data.validUntil = d;
    }
  }

  if (Object.keys(data).length === 0) {
    return prisma.billingDocument.findFirstOrThrow({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
    });
  }

  const result = await prisma.billingDocument.updateMany({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
      status: {
        in: [
          BillingDocumentStatus.DRAFT,
          BillingDocumentStatus.PENDING_REVIEW,
        ],
      },
    },
    data,
  });

  if (result.count !== 1) {
    throw new ForbiddenError("Document state changed during header update");
  }

  const doc = await prisma.billingDocument.findFirstOrThrow({
    where: {
      id: input.billingDocumentId,
      businessId: input.businessId,
    },
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DRAFT_HEADER_UPDATED",
    entityType: "BILLING_DOCUMENT",
    entityId: doc.id,
    payload: {
      documentId: doc.id,
      customerId: doc.customerId,
      customerNameSnapshot: doc.customerNameSnapshot,
      actorUserId: input.actorUserId,
    },
  });

  return doc;
}

export async function replaceBillingDraftLines(
  input: ReplaceBillingDraftLinesInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  assertBusinessId(input.businessId);

  const doc = await prisma.$transaction(async (tx) => {
    const found = await tx.billingDocument.findFirst({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
      select: { id: true, status: true, convertedToInvoiceId: true },
    });

    if (!found) {
      throw new NotFoundError("Billing document not found");
    }

    if (!canEditDraft(found.status)) {
      throw new ForbiddenError("Document is not editable");
    }

    if (found.convertedToInvoiceId !== null) {
      throw new ForbiddenError("לא ניתן לערוך הצעה שכבר הומרה לחשבונית");
    }

    const { lineCount, totals } = await persistLinesAndTotals(
      tx,
      input.billingDocumentId,
      input.businessId,
      input.lines
    );

    const full = await tx.billingDocument.findFirstOrThrow({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    return { full, lineCount, totals };
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DRAFT_LINES_REPLACED",
    entityType: "BILLING_DOCUMENT",
    entityId: doc.full.id,
    payload: {
      documentId: doc.full.id,
      lineCount: doc.lineCount,
      subtotalAmount: doc.totals[0].toString(),
      vatAmount: doc.totals[1].toString(),
      totalAmount: doc.totals[2].toString(),
      actorUserId: input.actorUserId,
    },
  });

  return doc.full;
}
