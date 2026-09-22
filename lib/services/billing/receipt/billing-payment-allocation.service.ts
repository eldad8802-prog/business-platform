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
  sumAllocationAmounts,
} from "@/lib/services/billing/receipt/billing-receipt-allocation.rules";
import { loadInvoiceEconomicStateTx } from "@/lib/services/billing/domain/billing-invoice-economic-remaining";
import { lockBillingDocumentRowsTx } from "@/lib/services/billing/receipt/billing-receipt-issuance-integrity";
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
 * over-allocation per invoice against ISSUED settlements, and full allocation
 * of the receipt amount. The binding checks repeat at issuance (C2.5).
 */
export async function setReceiptAllocations(
  input: SetReceiptAllocationsInput
): Promise<BillingPaymentAllocation[]> {
  assertBusinessId(input.businessId);
  parseAllocations(input.allocations);
  return billingTenantTx(input.businessId, (tx) =>
    setReceiptAllocationsTx(tx, input)
  );
}

/**
 * The same operation inside a caller's transaction. C3 payment settlement uses
 * it so a system receipt's allocation goes through exactly the checks a manual
 * one does — there is one allocation write path, not two.
 */
export async function setReceiptAllocationsTx(
  tx: Prisma.TransactionClient,
  input: SetReceiptAllocationsInput
): Promise<BillingPaymentAllocation[]> {
  assertBusinessId(input.businessId);
  const parsed = parseAllocations(input.allocations);
  {
    // C2.5 — serialise with issuance of this same receipt. Without the lock,
    // allocations could be rewritten between issuance validating them and
    // issuance committing; with it, whichever runs second reads the other's
    // result (and this path then sees ISSUED and refuses).
    await lockBillingDocumentRowsTx(tx, input.businessId, [
      input.receiptDocumentId,
    ]);

    const receipt = await tx.billingDocument.findFirst({
      where: { id: input.receiptDocumentId, businessId: input.businessId },
      select: {
        id: true,
        businessId: true,
        documentType: true,
        status: true,
        currency: true,
        totalAmount: true,
        unappliedAmount: true,
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

    // The receipt's money must be fully accounted for: allocated across
    // invoices, plus any unapplied excess the receipt states (C3; always 0 on a
    // manual receipt, which cannot set it).
    const allocationsTotal = sumAllocationAmounts(parsed);
    if (!allocationsTotal.plus(receipt.unappliedAmount).equals(receipt.totalAmount)) {
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

      // Remaining = the invoice's economic remaining, excluding this receipt:
      // total − OTHER receipts' ISSUED allocations − ISSUED credit notes.
      // C2.5: an unissued receipt's allocation is a plan, so it reserves
      // nothing — an abandoned draft must not block a real payment. This is
      // early feedback only; the binding check runs at issuance, under the
      // invoice's lock.
      const state = await loadInvoiceEconomicStateTx(tx, {
        businessId: input.businessId,
        invoiceDocumentId: invoice.id,
        totalAmount: invoice.totalAmount,
        excludeReceiptDocumentId: receipt.id,
      });
      assertAllocationWithinRemaining(
        allocation.allocatedAmount,
        state.economicRemaining
      );
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
  }
}
