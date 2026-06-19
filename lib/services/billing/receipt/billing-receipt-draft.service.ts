import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
  BillingReceiptPayment,
  Prisma,
} from "@prisma/client";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { assertBillingDocumentLinesMutable } from "@/lib/services/billing/domain/billing-immutability.guard";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import { validateAndParseLineInput } from "@/lib/services/billing/validation/billing-line.validation";
import type { BillingLineInputRaw } from "@/lib/services/billing/domain/billing.types";
import {
  validateAndParsePaymentLine,
  type PaymentLineInputRaw,
  type PaymentLineParsed,
} from "@/lib/services/billing/validation/billing-payment.validation";
import {
  assertReceiptTotalsReconcile,
  sumPaymentLineAmounts,
} from "@/lib/services/billing/receipt/billing-receipt-allocation.rules";

export type ReceiptDocumentType =
  | typeof BillingDocumentType.RECEIPT
  | typeof BillingDocumentType.TAX_INVOICE_RECEIPT;

export type CreateReceiptDraftInput = {
  businessId: number;
  actorUserId: number | null;
  documentType: ReceiptDocumentType;
  customerId?: number | null;
  customerNameSnapshot?: string | null;
  currency?: string;
  /** Goods/service lines — required for TAX_INVOICE_RECEIPT, rejected for RECEIPT. */
  goodsLines?: BillingLineInputRaw[];
  paymentLines: PaymentLineInputRaw[];
};

export type ReplaceReceiptPaymentLinesInput = {
  businessId: number;
  billingDocumentId: number;
  paymentLines: PaymentLineInputRaw[];
};

type ReceiptWithChildren = BillingDocument & {
  lines: BillingDocumentLine[];
  receiptPayments: BillingReceiptPayment[];
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }
}

function isReceiptDocumentType(value: unknown): value is ReceiptDocumentType {
  return (
    value === BillingDocumentType.RECEIPT ||
    value === BillingDocumentType.TAX_INVOICE_RECEIPT
  );
}

function parsePaymentLines(raw: PaymentLineInputRaw[]): PaymentLineParsed[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError("At least one payment line is required");
  }
  return raw.map((line, i) => validateAndParsePaymentLine(line, i + 1));
}

function paymentLineCreateData(
  parsed: PaymentLineParsed[]
): Omit<Prisma.BillingReceiptPaymentCreateManyInput, "billingDocumentId">[] {
  return parsed.map((line) => ({
    lineIndex: line.lineIndex,
    method: line.method,
    amount: line.amount,
    currency: line.currency,
    paymentDate: line.paymentDate,
    bankName: line.bankName,
    bankBranch: line.bankBranch,
    bankAccountNumber: line.bankAccountNumber,
    checkNumber: line.checkNumber,
    checkDueDate: line.checkDueDate,
    cardBrand: line.cardBrand,
    cardLast4: line.cardLast4,
    reference: line.reference,
  }));
}

export async function createReceiptDraft(
  input: CreateReceiptDraftInput
): Promise<ReceiptWithChildren> {
  assertBusinessId(input.businessId);

  if (!isReceiptDocumentType(input.documentType)) {
    throw new ValidationError(
      "documentType must be RECEIPT or TAX_INVOICE_RECEIPT"
    );
  }

  const currency = (input.currency ?? "ILS").trim().toUpperCase() || "ILS";
  const parsedPayments = parsePaymentLines(input.paymentLines);
  const paymentsTotal = sumPaymentLineAmounts(parsedPayments);

  let subtotalAmount = new Prisma.Decimal(0);
  let vatAmount = new Prisma.Decimal(0);
  let totalAmount = paymentsTotal;
  let goodsComputed: ReturnType<typeof recomputeAll>["lines"] = [];

  if (input.documentType === BillingDocumentType.TAX_INVOICE_RECEIPT) {
    if (!Array.isArray(input.goodsLines) || input.goodsLines.length === 0) {
      throw new ValidationError(
        "TAX_INVOICE_RECEIPT requires goods/service lines"
      );
    }
    const parsedGoods = input.goodsLines.map((raw, i) =>
      validateAndParseLineInput(raw, i + 1)
    );
    const { lines, totals } = recomputeAll(parsedGoods);
    goodsComputed = lines;
    subtotalAmount = totals.subtotalAmount;
    vatAmount = totals.vatAmount;
    totalAmount = totals.totalAmount;
  } else if (input.goodsLines && input.goodsLines.length > 0) {
    throw new ValidationError("RECEIPT must not contain goods/service lines");
  }

  // Payment lines must reconcile to the document total (identity for RECEIPT).
  assertReceiptTotalsReconcile({
    documentType: input.documentType,
    documentTotal: totalAmount,
    paymentsTotal,
  });

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.billingDocument.create({
      data: {
        businessId: input.businessId,
        documentType: input.documentType,
        status: BillingDocumentStatus.DRAFT,
        currency,
        customerId: input.customerId ?? null,
        customerNameSnapshot: input.customerNameSnapshot ?? null,
        subtotalAmount,
        vatAmount,
        totalAmount,
        pdfRenderStatus: BillingPdfRenderStatus.PENDING,
        createdByUserId: input.actorUserId,
      },
    });

    if (goodsComputed.length > 0) {
      await tx.billingDocumentLine.createMany({
        data: goodsComputed.map((line) => ({
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
    }

    await tx.billingReceiptPayment.createMany({
      data: paymentLineCreateData(parsedPayments).map((line) => ({
        ...line,
        billingDocumentId: created.id,
      })),
    });

    return tx.billingDocument.findFirstOrThrow({
      where: { id: created.id, businessId: input.businessId },
      include: {
        lines: { orderBy: { lineIndex: "asc" } },
        receiptPayments: { orderBy: { lineIndex: "asc" } },
      },
    });
  });

  return result;
}

export async function replaceReceiptPaymentLines(
  input: ReplaceReceiptPaymentLinesInput
): Promise<ReceiptWithChildren> {
  assertBusinessId(input.businessId);

  const parsedPayments = parsePaymentLines(input.paymentLines);
  const paymentsTotal = sumPaymentLineAmounts(parsedPayments);

  return prisma.$transaction(async (tx) => {
    const doc = await tx.billingDocument.findFirst({
      where: { id: input.billingDocumentId, businessId: input.businessId },
      select: { id: true, documentType: true, status: true, totalAmount: true },
    });
    if (!doc) {
      throw new NotFoundError("Receipt document not found");
    }
    if (!isReceiptDocumentType(doc.documentType)) {
      throw new ValidationError(
        "Document is not a RECEIPT or TAX_INVOICE_RECEIPT"
      );
    }
    // Mutable only before ISSUED.
    assertBillingDocumentLinesMutable(doc.status);

    if (doc.documentType === BillingDocumentType.TAX_INVOICE_RECEIPT) {
      // Goods total is fixed; payments must reconcile to the existing total.
      assertReceiptTotalsReconcile({
        documentType: doc.documentType,
        documentTotal: doc.totalAmount,
        paymentsTotal,
      });
    } else {
      // Pure RECEIPT: total tracks the payments sum.
      assertReceiptTotalsReconcile({
        documentType: doc.documentType,
        documentTotal: paymentsTotal,
        paymentsTotal,
      });
      await tx.billingDocument.update({
        where: { id: doc.id, businessId: input.businessId },
        data: { totalAmount: paymentsTotal },
      });
    }

    await tx.billingReceiptPayment.deleteMany({
      where: { billingDocumentId: doc.id },
    });
    await tx.billingReceiptPayment.createMany({
      data: paymentLineCreateData(parsedPayments).map((line) => ({
        ...line,
        billingDocumentId: doc.id,
      })),
    });

    return tx.billingDocument.findFirstOrThrow({
      where: { id: doc.id, businessId: input.businessId },
      include: {
        lines: { orderBy: { lineIndex: "asc" } },
        receiptPayments: { orderBy: { lineIndex: "asc" } },
      },
    });
  });
}
