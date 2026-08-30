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
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import type { BillingLineInputRaw } from "@/lib/services/billing/domain/billing.types";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import {
  validateAndParseLineInput,
} from "@/lib/services/billing/validation/billing-line.validation";
import { billingTenantTx } from "./billing-tenant-tx";

export type BillingCreditState = {
  creditedAmount: Prisma.Decimal;
  remainingAmount: Prisma.Decimal;
  isPartiallyCredited: boolean;
  isFullyCredited: boolean;
  creditNoteCount: number;
};

export type CreateBillingCreditNoteDraftInput = {
  businessId: number;
  actorUserId: number | null;
  sourceBillingDocumentId: number;
  initialLines?: BillingLineInputRaw[];
};

type SourceInvoice = BillingDocument & { lines: BillingDocumentLine[] };

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }
}

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

function toLineInput(line: BillingDocumentLine): BillingLineInputRaw {
  return {
    description: line.description,
    quantity: line.quantity.toString(),
    unitPrice: line.unitPrice.toString(),
    vatRatePercent: line.vatRatePercent.toString(),
    lineIndex: line.lineIndex,
  };
}

export async function getBillingCreditState(
  tx: Prisma.TransactionClient,
  args: { businessId: number; sourceBillingDocumentId: number }
): Promise<BillingCreditState> {
  const aggregate = await tx.billingDocument.aggregate({
    where: {
      businessId: args.businessId,
      documentType: BillingDocumentType.CREDIT_NOTE,
      status: BillingDocumentStatus.ISSUED,
      referenceDocumentId: args.sourceBillingDocumentId,
    },
    _sum: { totalAmount: true },
    _count: { _all: true },
  });

  const creditedAmount =
    aggregate._sum.totalAmount ?? new Prisma.Decimal(0);

  const source = await tx.billingDocument.findFirst({
    where: {
      id: args.sourceBillingDocumentId,
      businessId: args.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
    },
    select: { totalAmount: true },
  });

  if (!source) {
    throw new NotFoundError("Source issued invoice not found");
  }

  const remainingAmount = source.totalAmount.minus(creditedAmount);

  return {
    creditedAmount,
    remainingAmount,
    isPartiallyCredited:
      creditedAmount.gt(0) && creditedAmount.lt(source.totalAmount),
    isFullyCredited: creditedAmount.gte(source.totalAmount),
    creditNoteCount: aggregate._count._all,
  };
}

export async function assertCanReferenceSourceInvoice(
  tx: Prisma.TransactionClient,
  args: {
    businessId: number;
    sourceBillingDocumentId: number;
    creditDocumentId?: number;
  }
): Promise<SourceInvoice> {
  if (args.creditDocumentId === args.sourceBillingDocumentId) {
    throw new ValidationError("Credit note cannot reference itself");
  }

  const source = await tx.billingDocument.findFirst({
    where: {
      id: args.sourceBillingDocumentId,
      businessId: args.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
    },
    include: { lines: { orderBy: { lineIndex: "asc" } } },
  });

  if (!source) {
    throw new NotFoundError("Source issued invoice not found");
  }

  return source;
}

export async function assertCreditAmountWithinRemaining(
  tx: Prisma.TransactionClient,
  args: {
    businessId: number;
    sourceBillingDocumentId: number;
    creditTotalAmount: Prisma.Decimal;
    currency: string;
  }
): Promise<BillingCreditState> {
  const source = await tx.billingDocument.findFirst({
    where: {
      id: args.sourceBillingDocumentId,
      businessId: args.businessId,
      documentType: BillingDocumentType.TAX_INVOICE,
      status: BillingDocumentStatus.ISSUED,
    },
    select: { currency: true },
  });

  if (!source) {
    throw new NotFoundError("Source issued invoice not found");
  }

  if (source.currency !== args.currency) {
    throw new ValidationError("Credit note currency must match source invoice");
  }

  const creditState = await getBillingCreditState(tx, args);
  if (args.creditTotalAmount.lte(0)) {
    throw new ValidationError("Credit amount must be greater than zero");
  }
  if (args.creditTotalAmount.gt(creditState.remainingAmount)) {
    throw new ForbiddenError("Credit amount exceeds remaining invoice amount");
  }

  return creditState;
}

export async function createBillingCreditNoteDraft(
  input: CreateBillingCreditNoteDraftInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  assertBusinessId(input.businessId);
  assertPositiveInteger(
    input.sourceBillingDocumentId,
    "sourceBillingDocumentId"
  );

  const result = await billingTenantTx(input.businessId, async (tx) => {
    const source = await assertCanReferenceSourceInvoice(tx, {
      businessId: input.businessId,
      sourceBillingDocumentId: input.sourceBillingDocumentId,
    });

    const creditState = await getBillingCreditState(tx, {
      businessId: input.businessId,
      sourceBillingDocumentId: source.id,
    });

    if (creditState.remainingAmount.lte(0)) {
      throw new ForbiddenError("Source invoice is already fully credited");
    }

    const rawLines =
      input.initialLines ??
      (creditState.creditedAmount.isZero()
        ? source.lines.map(toLineInput)
        : null);

    if (!rawLines || rawLines.length === 0) {
      throw new ValidationError(
        "initialLines are required when source invoice already has credits"
      );
    }

    const parsed = rawLines.map((raw, i) =>
      validateAndParseLineInput(raw, i + 1)
    );
    const { lines, totals } = recomputeAll(parsed);

    await assertCreditAmountWithinRemaining(tx, {
      businessId: input.businessId,
      sourceBillingDocumentId: source.id,
      creditTotalAmount: totals.totalAmount,
      currency: source.currency,
    });

    const created = await tx.billingDocument.create({
      data: {
        businessId: input.businessId,
        documentType: BillingDocumentType.CREDIT_NOTE,
        status: BillingDocumentStatus.DRAFT,
        currency: source.currency,
        customerId: source.customerId,
        customerNameSnapshot: source.customerNameSnapshot,
        referenceDocumentId: source.id,
        subtotalAmount: totals.subtotalAmount,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        pdfRenderStatus: BillingPdfRenderStatus.PENDING,
        createdByUserId: input.actorUserId,
      },
    });

    await tx.billingDocumentLine.createMany({
      data: lines.map((line) => ({
        billingDocumentId: created.id,
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

    const full = await tx.billingDocument.findFirstOrThrow({
      where: { id: created.id, businessId: input.businessId },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: full.id,
      actorUserId: input.actorUserId,
      eventType: "BILLING_CREDIT_NOTE_DRAFT_CREATED",
      summary: "Credit note draft created",
      metadata: {
        creditNoteId: full.id,
        sourceInvoiceId: source.id,
        lineCount: lines.length,
        subtotalAmount: totals.subtotalAmount.toString(),
        vatAmount: totals.vatAmount.toString(),
        totalAmount: totals.totalAmount.toString(),
        currency: full.currency,
        remainingAmountBeforeDraft: creditState.remainingAmount.toString(),
        actorUserId: input.actorUserId,
      },
    });

    return { full, source, lineCount: lines.length, totals };
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_CREDIT_NOTE_DRAFT_CREATED",
    entityType: "BILLING_DOCUMENT",
    entityId: result.full.id,
    payload: {
      creditNoteId: result.full.id,
      sourceInvoiceId: result.source.id,
      lineCount: result.lineCount,
      subtotalAmount: result.totals.subtotalAmount.toString(),
      vatAmount: result.totals.vatAmount.toString(),
      totalAmount: result.totals.totalAmount.toString(),
      actorUserId: input.actorUserId,
    },
  });

  return result.full;
}
