import {
  BillingDocumentType,
  BillingPaymentAllocation,
  Prisma,
} from "@prisma/client";
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { assertBillingDocumentLinesMutable } from "@/lib/services/billing/domain/billing-immutability.guard";
import { parseDecimalString } from "@/lib/services/billing/validation/billing-decimal.parse";
import {
  assertAllocationPositive,
  assertAllocationWithinRemaining,
  assertInvoiceAllocatable,
  assertSameBusiness,
  assertSameCurrency,
  computeRemainingAllocatable,
  sumAllocationAmounts,
} from "@/lib/services/billing/receipt/billing-receipt-allocation.rules";
import { billingTenantTx } from "../billing-tenant-tx";

const ALLOCATION_MAX_VALUE = "9999999999999999";

export type ReceiptAllocationInputRaw = {
  invoiceDocumentId: unknown;
  allocatedAmount: unknown;
};

export type SetReceiptAllocationsInput = {
  businessId: number;
  receiptDocumentId: number;
  allocations: ReceiptAllocationInputRaw[];
};

type ParsedAllocation = {
  invoiceDocumentId: number;
  allocatedAmount: Prisma.Decimal;
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError();
  }
}

function parseAllocations(raw: ReceiptAllocationInputRaw[]): ParsedAllocation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError("At least one allocation is required");
  }

  const seen = new Set<number>();
  return raw.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new ValidationError("allocation entry must be an object");
    }
    if (
      typeof entry.invoiceDocumentId !== "number" ||
      !Number.isInteger(entry.invoiceDocumentId) ||
      entry.invoiceDocumentId <= 0
    ) {
      throw new ValidationError("invoiceDocumentId must be a positive integer");
    }
    if (seen.has(entry.invoiceDocumentId)) {
      throw new ValidationError(
        "Each invoice may appear at most once in a receipt's allocations"
      );
    }
    seen.add(entry.invoiceDocumentId);

    const allocatedAmount = parseDecimalString(
      entry.allocatedAmount,
      "allocatedAmount",
      { min: "0", max: ALLOCATION_MAX_VALUE, maxScale: 2, allowNegative: false }
    );
    assertAllocationPositive(allocatedAmount);

    return { invoiceDocumentId: entry.invoiceDocumentId, allocatedAmount };
  });
}

/**
 * Replaces the allocations of a DRAFT pure-RECEIPT against ISSUED invoices.
 * Enforces: ISSUED TAX_INVOICE only, same business, same currency, no
 * over-allocation per invoice, and full allocation of the receipt amount.
 */
export async function setReceiptAllocations(
  input: SetReceiptAllocationsInput
): Promise<BillingPaymentAllocation[]> {
  assertBusinessId(input.businessId);
  const parsed = parseAllocations(input.allocations);

  return billingTenantTx(input.businessId, async (tx) => {
    const receipt = await tx.billingDocument.findFirst({
      where: { id: input.receiptDocumentId, businessId: input.businessId },
      select: {
        id: true,
        businessId: true,
        documentType: true,
        status: true,
        currency: true,
        totalAmount: true,
      },
    });
    if (!receipt) {
      throw new NotFoundError("Receipt document not found");
    }
    if (receipt.documentType !== BillingDocumentType.RECEIPT) {
      throw new ValidationError(
        "Allocations apply only to a pure RECEIPT (a tax-invoice-receipt settles itself)"
      );
    }
    // Mutable only before ISSUED.
    assertBillingDocumentLinesMutable(receipt.status);

    // The receipt's money must be fully allocated across invoices.
    const allocationsTotal = sumAllocationAmounts(parsed);
    if (!allocationsTotal.equals(receipt.totalAmount)) {
      throw new ValidationError(
        "Sum of allocations must equal the receipt total"
      );
    }

    for (const allocation of parsed) {
      const invoice = await tx.billingDocument.findFirst({
        where: {
          id: allocation.invoiceDocumentId,
          businessId: input.businessId,
        },
        select: {
          id: true,
          businessId: true,
          documentType: true,
          status: true,
          currency: true,
          totalAmount: true,
        },
      });
      if (!invoice) {
        throw new NotFoundError(
          `Invoice ${allocation.invoiceDocumentId} not found`
        );
      }

      assertInvoiceAllocatable(invoice);
      assertSameBusiness(receipt.businessId, invoice.businessId);
      assertSameCurrency(receipt.currency, invoice.currency);

      // Remaining = invoice total − allocations from OTHER receipts.
      const others = await tx.billingPaymentAllocation.aggregate({
        where: {
          businessId: input.businessId,
          invoiceDocumentId: invoice.id,
          receiptDocumentId: { not: receipt.id },
        },
        _sum: { allocatedAmount: true },
      });
      const othersAllocated = others._sum.allocatedAmount ?? new Prisma.Decimal(0);
      const remaining = computeRemainingAllocatable(
        invoice.totalAmount,
        othersAllocated
      );
      assertAllocationWithinRemaining(allocation.allocatedAmount, remaining);
    }

    await tx.billingPaymentAllocation.deleteMany({
      where: { businessId: input.businessId, receiptDocumentId: receipt.id },
    });
    await tx.billingPaymentAllocation.createMany({
      data: parsed.map((allocation) => ({
        businessId: input.businessId,
        receiptDocumentId: receipt.id,
        invoiceDocumentId: allocation.invoiceDocumentId,
        allocatedAmount: allocation.allocatedAmount,
        currency: receipt.currency,
      })),
    });

    return tx.billingPaymentAllocation.findMany({
      where: { businessId: input.businessId, receiptDocumentId: receipt.id },
      orderBy: { invoiceDocumentId: "asc" },
    });
  });
}
