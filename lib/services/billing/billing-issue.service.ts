import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPaymentAllocation,
  BillingPdfRenderStatus,
  BillingReceiptPayment,
  Prisma,
} from "@prisma/client";
import { createHash } from "crypto";
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/services/audit.service";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import { createAuthoritySubmissionForIssuedDocumentTx } from "@/lib/services/billing/authority/billing-authority-issue.service";
import {
  assertCanReferenceSourceInvoice,
  assertCreditAmountWithinRemaining,
} from "@/lib/services/billing/billing-credit-reversal.service";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import {
  ensureBillingInvoicePostedEvent,
  ensureBillingPaymentPostedEvent,
} from "@/lib/services/financial-events/financial-event.service";
import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
import {
  assertReceiptTotalsReconcile,
  sumPaymentLineAmounts,
} from "@/lib/services/billing/receipt/billing-receipt-allocation.rules";
import {
  buildBillingCustomerSnapshot,
  type CustomerBillingIdentityRow,
} from "@/lib/billing/customer-tax-identity";
import { updateBillingDocuments } from "@/lib/services/billing/domain/billing-document-mutation.gateway";
import {
  parseBillingPdfTemplateStyle,
  type BillingPdfTemplateStyle,
} from "@/lib/billing/billing-pdf-template-style";

const SNAPSHOT_SCHEMA_VERSION = 1;
const DOCUMENT_NUMBER_PAD = 6;
const DEFAULT_LOCALE = "he-IL";
const DEFAULT_TIMEZONE = "Asia/Jerusalem";
const DEFAULT_VAT_MODE = "EXCLUSIVE";
const DEFAULT_SOURCE = "manual";
const DOCUMENT_ALREADY_HANDLED_MESSAGE =
  "המסמך כבר עודכן או הופק על ידי פעולה אחרת";

export type IssueBillingDocumentInput = {
  businessId: number;
  actorUserId: number;
  billingDocumentId: number;
};

type IssuerSnapshot = {
  id: number;
  name: string;
  legalName: string | null;
  taxId: string | null;
  vatRegistration: string | null;
  address: unknown | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
  bankDetails: unknown | null;
};

type CustomerSnapshot = {
  id: number | null;
  name: string;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: unknown | null;
};

type LineSnapshot = {
  lineIndex: number;
  description: string;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  vatAmount: string;
  lineTotal: string;
};

type PaymentLineSnapshot = {
  lineIndex: number;
  method: string;
  amount: string;
  currency: string;
  paymentDate: string;
  bankName: string | null;
  bankBranch: string | null;
  bankAccountNumber: string | null;
  checkNumber: string | null;
  checkDueDate: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  reference: string | null;
};

type AllocationSnapshot = {
  invoiceDocumentId: number;
  allocatedAmount: string;
  currency: string;
};

type IssuedSnapshot = {
  schemaVersion: number;
  issuedAt: string;
  document: {
    id: number;
    type: string;
    status: string;
    number: number;
    numberFormatted: string;
    currency: string;
    allocationNumber: string | null;
    referenceDocumentId: number | null;
  };
  issuer: IssuerSnapshot;
  customer: CustomerSnapshot;
  lines: LineSnapshot[];
  /** Present only for RECEIPT / TAX_INVOICE_RECEIPT (frozen D120 source). */
  payments?: PaymentLineSnapshot[];
  /** Present only for a pure RECEIPT — which invoices this receipt settles. */
  allocations?: AllocationSnapshot[];
  totals: {
    subtotal: string;
    vat: string;
    total: string;
  };
  tax: {
    currency: string;
    defaultVatRate: string | null;
    vatMode: string;
  };
  metadata: {
    locale: string;
    timezone: string;
    actorUserId: number;
    source: string;
  };
  /** Frozen layout preset at issue time (CLASSIC | MODERN | COMPACT). */
  pdfTemplateStyle: BillingPdfTemplateStyle;
  extensions: Record<string, unknown>;
};

type BusinessProfileForInvoice = {
  billingLegalName: string | null;
  billingBusinessKind: string | null;
  billingTaxId: string | null;
  billingVatNumber: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingPaymentNote: string | null;
  billingFooterNote: string | null;
  billingLogoDataUrl: string | null;
  billingPdfTemplateStyle?: string | null;
} | null;

function isValidBillingLogoDataUrl(value: string | null | undefined): boolean {
  if (!value || typeof value !== "string") return false;
  const t = value.trim();
  if (t.length > 500_000) return false;
  return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(t);
}

function formatDocumentNumber(value: number): string {
  return String(value).padStart(DOCUMENT_NUMBER_PAD, "0");
}

function formatMoney(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function formatQuantityLike(value: Prisma.Decimal): string {
  return value.toFixed(4);
}

function formatPercent(value: Prisma.Decimal): string {
  return value.toFixed(2);
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

function hashIssuedSnapshot(snapshot: IssuedSnapshot): string {
  return createHash("sha256")
    .update(stableJsonStringify(snapshot))
    .digest("hex");
}

function buildIssuedSnapshot(args: {
  document: BillingDocument;
  lines: BillingDocumentLine[];
  business: { id: number; name: string; profile: BusinessProfileForInvoice };
  customer: CustomerBillingIdentityRow | null;
  documentNumber: number;
  documentNumberFormatted: string;
  issuedAt: Date;
  actorUserId: number;
  receiptPayments: BillingReceiptPayment[];
  allocations: BillingPaymentAllocation[];
  totals: {
    subtotalAmount: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    totalAmount: Prisma.Decimal;
  };
}): IssuedSnapshot {
  const {
    document,
    lines,
    business,
    customer,
    documentNumber,
    documentNumberFormatted,
    issuedAt,
    actorUserId,
    receiptPayments,
    allocations,
    totals,
  } = args;

  const profile = business.profile;
  const displayName = (profile?.billingLegalName ?? "").trim() || business.name;
  const taxId = (profile?.billingTaxId ?? "").trim() || null;
  const vatReg = (profile?.billingVatNumber ?? "").trim() || null;
  const phone = (profile?.billingPhone ?? "").trim() || null;
  const email = (profile?.billingEmail ?? "").trim() || null;
  const addressRaw = (profile?.billingAddress ?? "").trim() || null;
  const paymentNote = (profile?.billingPaymentNote ?? "").trim() || null;
  const footerNote = (profile?.billingFooterNote ?? "").trim() || null;
  const businessKind = (profile?.billingBusinessKind ?? "").trim() || null;
  const logoUrl =
    profile && isValidBillingLogoDataUrl(profile.billingLogoDataUrl)
      ? profile.billingLogoDataUrl!.trim()
      : null;

  const pdfTemplateStyle = parseBillingPdfTemplateStyle(
    profile?.billingPdfTemplateStyle
  );

  const customerNameSnapshot = (document.customerNameSnapshot ?? "").trim();
  if (customerNameSnapshot.length === 0) {
    throw new ValidationError(
      "customerNameSnapshot is required to issue a document"
    );
  }

  const customerSnapshot: CustomerSnapshot = buildBillingCustomerSnapshot({
    customerNameSnapshot,
    customer,
  });

  const issuerSnapshot: IssuerSnapshot = {
    id: business.id,
    name: displayName,
    legalName: (profile?.billingLegalName ?? "").trim() || null,
    taxId: taxId,
    vatRegistration: vatReg,
    address: addressRaw,
    phone: phone,
    email: email,
    logoUrl: logoUrl,
    bankDetails: paymentNote,
  };

  const lineSnapshots: LineSnapshot[] = lines.map((line) => ({
    lineIndex: line.lineIndex,
    description: line.description,
    quantity: formatQuantityLike(line.quantity),
    unitPrice: formatQuantityLike(line.unitPrice),
    vatRatePercent: formatPercent(line.vatRatePercent),
    lineSubtotal: formatMoney(line.lineSubtotal),
    vatAmount: formatMoney(line.vatAmount),
    lineTotal: formatMoney(line.lineTotal),
  }));

  const paymentSnapshots: PaymentLineSnapshot[] = receiptPayments.map((p) => ({
    lineIndex: p.lineIndex,
    method: p.method,
    amount: formatMoney(p.amount),
    currency: p.currency,
    paymentDate: p.paymentDate.toISOString(),
    bankName: p.bankName,
    bankBranch: p.bankBranch,
    bankAccountNumber: p.bankAccountNumber,
    checkNumber: p.checkNumber,
    checkDueDate: p.checkDueDate ? p.checkDueDate.toISOString() : null,
    cardBrand: p.cardBrand,
    cardLast4: p.cardLast4,
    reference: p.reference,
  }));

  const allocationSnapshots: AllocationSnapshot[] = allocations.map((a) => ({
    invoiceDocumentId: a.invoiceDocumentId,
    allocatedAmount: formatMoney(a.allocatedAmount),
    currency: a.currency,
  }));

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    issuedAt: issuedAt.toISOString(),
    document: {
      id: document.id,
      type: document.documentType,
      status: BillingDocumentStatus.ISSUED,
      number: documentNumber,
      numberFormatted: documentNumberFormatted,
      currency: document.currency,
      allocationNumber: null,
      referenceDocumentId: document.referenceDocumentId,
    },
    issuer: issuerSnapshot,
    customer: customerSnapshot,
    lines: lineSnapshots,
    ...(paymentSnapshots.length > 0 ? { payments: paymentSnapshots } : {}),
    ...(allocationSnapshots.length > 0
      ? { allocations: allocationSnapshots }
      : {}),
    totals: {
      subtotal: formatMoney(totals.subtotalAmount),
      vat: formatMoney(totals.vatAmount),
      total: formatMoney(totals.totalAmount),
    },
    tax: {
      currency: document.currency,
      defaultVatRate: null,
      vatMode: DEFAULT_VAT_MODE,
    },
    metadata: {
      locale: DEFAULT_LOCALE,
      timezone: DEFAULT_TIMEZONE,
      actorUserId,
      source: DEFAULT_SOURCE,
    },
    pdfTemplateStyle,
    extensions: {
      billingFooterNote: footerNote,
      billingBusinessKind: businessKind,
    },
  };
}

export async function issueBillingDocument(
  input: IssueBillingDocumentInput
): Promise<BillingDocument & { lines: BillingDocumentLine[] }> {
  if (!input.businessId || Number.isNaN(input.businessId)) {
    throw new UnauthorizedError();
  }

  if (
    !input.actorUserId ||
    Number.isNaN(input.actorUserId) ||
    !Number.isInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    throw new UnauthorizedError();
  }

  if (
    !input.billingDocumentId ||
    Number.isNaN(input.billingDocumentId) ||
    !Number.isInteger(input.billingDocumentId) ||
    input.billingDocumentId <= 0
  ) {
    throw new ValidationError("billingDocumentId must be a positive integer");
  }

  const issuedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const doc = await tx.billingDocument.findFirst({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
      include: {
        lines: { orderBy: { lineIndex: "asc" } },
        receiptPayments: { orderBy: { lineIndex: "asc" } },
      },
    });

    if (!doc) {
      throw new NotFoundError("Billing document not found");
    }

    if (doc.documentType === BillingDocumentType.QUOTE) {
      throw new ValidationError(
        "לא ניתן להפיק חשבונית מס ישירות מהצעת מחיר — יש להשתמש ב\"הפוך לחשבונית\""
      );
    }

    if (
      doc.status !== BillingDocumentStatus.PENDING_REVIEW &&
      doc.status !== BillingDocumentStatus.DRAFT
    ) {
      throw new ForbiddenError(DOCUMENT_ALREADY_HANDLED_MESSAGE);
    }

    const customerNameSnapshot = (doc.customerNameSnapshot ?? "").trim();
    if (customerNameSnapshot.length === 0) {
      throw new ValidationError(
        "customerNameSnapshot is required to issue a document"
      );
    }

    const isReceiptType =
      doc.documentType === BillingDocumentType.RECEIPT ||
      doc.documentType === BillingDocumentType.TAX_INVOICE_RECEIPT;
    const hasGoodsLines = doc.documentType !== BillingDocumentType.RECEIPT;

    if (hasGoodsLines && doc.lines.length === 0) {
      throw new ValidationError("Cannot issue a document with no lines");
    }
    if (isReceiptType && doc.receiptPayments.length === 0) {
      throw new ValidationError("Cannot issue a receipt with no payment lines");
    }

    let totals: {
      subtotalAmount: Prisma.Decimal;
      vatAmount: Prisma.Decimal;
      totalAmount: Prisma.Decimal;
    };

    if (hasGoodsLines) {
      const recomputed = recomputeAll(
        doc.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          vatRatePercent: line.vatRatePercent,
          lineIndex: line.lineIndex,
        }))
      );

      if (
        !recomputed.totals.subtotalAmount.equals(doc.subtotalAmount) ||
        !recomputed.totals.vatAmount.equals(doc.vatAmount) ||
        !recomputed.totals.totalAmount.equals(doc.totalAmount)
      ) {
        throw new ValidationError(
          "Document totals are inconsistent with line items"
        );
      }
      totals = recomputed.totals;
    } else {
      // Pure RECEIPT carries no goods lines: subtotal/VAT are zero and the
      // total is the sum of payment lines (reconciled below).
      if (!doc.subtotalAmount.isZero() || !doc.vatAmount.isZero()) {
        throw new ValidationError("A RECEIPT must have zero subtotal and VAT");
      }
      totals = {
        subtotalAmount: doc.subtotalAmount,
        vatAmount: doc.vatAmount,
        totalAmount: doc.totalAmount,
      };
    }

    // Freeze payment lines / allocations for receipt-type documents and verify
    // the regulation-critical reconciliation (payments sum == document total).
    let receiptPayments: BillingReceiptPayment[] = [];
    let paymentAllocations: BillingPaymentAllocation[] = [];
    if (isReceiptType) {
      receiptPayments = doc.receiptPayments;
      assertReceiptTotalsReconcile({
        documentType: doc.documentType,
        documentTotal: totals.totalAmount,
        paymentsTotal: sumPaymentLineAmounts(receiptPayments),
      });
      if (doc.documentType === BillingDocumentType.RECEIPT) {
        paymentAllocations = await tx.billingPaymentAllocation.findMany({
          where: { businessId: input.businessId, receiptDocumentId: doc.id },
          orderBy: { invoiceDocumentId: "asc" },
        });
        if (paymentAllocations.length === 0) {
          throw new ValidationError(
            "Cannot issue a RECEIPT with no payment allocations"
          );
        }
      }
    }

    if (doc.documentType === BillingDocumentType.CREDIT_NOTE) {
      if (doc.referenceDocumentId === null) {
        throw new ValidationError(
          "Credit note must reference an issued source invoice"
        );
      }
      await assertCanReferenceSourceInvoice(tx, {
        businessId: input.businessId,
        sourceBillingDocumentId: doc.referenceDocumentId,
        creditDocumentId: doc.id,
      });
      await assertCreditAmountWithinRemaining(tx, {
        businessId: input.businessId,
        sourceBillingDocumentId: doc.referenceDocumentId,
        creditTotalAmount: totals.totalAmount,
        currency: doc.currency,
      });
    }

    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: {
        id: true,
        name: true,
        profile: {
          select: {
            billingLegalName: true,
            billingBusinessKind: true,
            billingTaxId: true,
            billingVatNumber: true,
            billingPhone: true,
            billingEmail: true,
            billingAddress: true,
            billingPaymentNote: true,
            billingFooterNote: true,
            billingLogoDataUrl: true,
            billingPdfTemplateStyle: true,
          },
        },
      },
    });

    if (!business) {
      throw new NotFoundError("Business not found");
    }

    assertBillingIdentityReadyForTaxInvoice(business.profile);

    let customerData: CustomerBillingIdentityRow | null = null;

    if (doc.customerId !== null) {
      const customer = await tx.customer.findFirst({
        where: { id: doc.customerId, businessId: input.businessId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
          legalName: true,
          taxId: true,
          taxIdType: true,
        },
      });
      if (customer) {
        customerData = customer;
      }
    }

    const sequence = await tx.billingDocumentNumberSequence.upsert({
      where: {
        businessId_documentType: {
          businessId: input.businessId,
          documentType: doc.documentType,
        },
      },
      create: {
        businessId: input.businessId,
        documentType: doc.documentType,
        nextNumber: 2,
      },
      update: {
        nextNumber: { increment: 1 },
      },
    });

    const documentNumber = sequence.nextNumber - 1;
    const documentNumberFormatted = formatDocumentNumber(documentNumber);

    const snapshot = buildIssuedSnapshot({
      document: doc,
      lines: doc.lines,
      business,
      customer: customerData,
      documentNumber,
      documentNumberFormatted,
      issuedAt,
      actorUserId: input.actorUserId,
      receiptPayments,
      allocations: paymentAllocations,
      totals,
    });
    const legalSnapshotHash = hashIssuedSnapshot(snapshot);

    const updated = await updateBillingDocuments(tx, {
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
      intent: "issue_to_issued",
      data: {
        status: BillingDocumentStatus.ISSUED,
        documentNumber,
        documentNumberFormatted,
        issuedAt,
        issuedByUserId: input.actorUserId,
        issuedSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        lockedAt: issuedAt,
        legalSnapshotHash,
        pdfRenderStatus: BillingPdfRenderStatus.PENDING,
      },
    });

    if (updated.count !== 1) {
      throw new ForbiddenError(DOCUMENT_ALREADY_HANDLED_MESSAGE);
    }

    const issued = await tx.billingDocument.findFirstOrThrow({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
      },
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    // Revenue recognition: TAX_INVOICE + TAX_INVOICE_RECEIPT only (self-guarded).
    await ensureBillingInvoicePostedEvent(tx, issued);
    // Cash received: RECEIPT + TAX_INVOICE_RECEIPT only (self-guarded).
    await ensureBillingPaymentPostedEvent(tx, issued);

    const issuedEventType =
      issued.documentType === BillingDocumentType.CREDIT_NOTE
        ? "BILLING_CREDIT_NOTE_ISSUED"
        : issued.documentType === BillingDocumentType.RECEIPT
          ? "BILLING_RECEIPT_ISSUED"
          : issued.documentType === BillingDocumentType.TAX_INVOICE_RECEIPT
            ? "BILLING_TAX_INVOICE_RECEIPT_ISSUED"
            : "BILLING_DOC_ISSUED";

    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: issued.id,
      actorUserId: input.actorUserId,
      eventType: issuedEventType,
      summary: "Billing document issued",
      metadata: {
        documentId: issued.id,
        documentType: issued.documentType,
        documentNumber,
        documentNumberFormatted,
        issuedAt: issuedAt.toISOString(),
        lockedAt: issued.lockedAt?.toISOString() ?? null,
        legalSnapshotHash: issued.legalSnapshotHash,
        customerId: issued.customerId,
        referenceDocumentId: issued.referenceDocumentId,
        sourceInvoiceId: issued.referenceDocumentId,
        subtotalAmount: totals.subtotalAmount.toString(),
        vatAmount: totals.vatAmount.toString(),
        totalAmount: totals.totalAmount.toString(),
        currency: issued.currency,
        lineCount: issued.lines.length,
        paymentLineCount: receiptPayments.length,
        allocationCount: paymentAllocations.length,
        snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
        actorUserId: input.actorUserId,
      },
      occurredAt: issuedAt,
    });

    // Cash-received audit entry for receipt-type documents.
    if (isReceiptType) {
      await createBillingAuditEventTx(tx, {
        businessId: input.businessId,
        billingDocumentId: issued.id,
        actorUserId: input.actorUserId,
        eventType: "BILLING_PAYMENT_RECORDED",
        summary: "Payment recorded on issued receipt",
        metadata: {
          documentId: issued.id,
          documentType: issued.documentType,
          totalAmount: totals.totalAmount.toString(),
          currency: issued.currency,
          paymentLineCount: receiptPayments.length,
          allocationCount: paymentAllocations.length,
          actorUserId: input.actorUserId,
        },
        occurredAt: issuedAt,
      });
    }

    await createAuthoritySubmissionForIssuedDocumentTx(tx, {
      businessId: input.businessId,
      billingDocumentId: issued.id,
      actorUserId: input.actorUserId,
      documentType: issued.documentType,
      legalSnapshotHash: issued.legalSnapshotHash ?? legalSnapshotHash,
      vatAmount: totals.vatAmount,
      subtotalAmount: totals.subtotalAmount,
      currency: issued.currency,
      customerTaxIdType: customerData?.taxIdType ?? null,
      customerTaxId: customerData?.taxId ?? null,
      issuedAt,
    });

    return {
      issued,
      documentNumber,
      documentNumberFormatted,
      totals,
    };
  });

  await logAuditEvent({
    businessId: input.businessId,
    eventType: "BILLING_DOC_ISSUED",
    entityType: "BILLING_DOCUMENT",
    entityId: result.issued.id,
    payload: {
      documentId: result.issued.id,
      documentType: result.issued.documentType,
      documentNumber: result.documentNumber,
      documentNumberFormatted: result.documentNumberFormatted,
      issuedAt: issuedAt.toISOString(),
      customerId: result.issued.customerId,
      referenceDocumentId: result.issued.referenceDocumentId,
      subtotalAmount: result.totals.subtotalAmount.toString(),
      vatAmount: result.totals.vatAmount.toString(),
      totalAmount: result.totals.totalAmount.toString(),
      lineCount: result.issued.lines.length,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      legalSnapshotHash: result.issued.legalSnapshotHash,
      actorUserId: input.actorUserId,
    },
  });

  return result.issued;
}
