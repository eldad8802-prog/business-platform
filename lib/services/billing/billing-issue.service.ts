import {
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
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
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";

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
  extensions: Record<string, unknown>;
};

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

function buildIssuedSnapshot(args: {
  document: BillingDocument;
  lines: BillingDocumentLine[];
  business: { id: number; name: string };
  customer: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    city: string | null;
  } | null;
  documentNumber: number;
  documentNumberFormatted: string;
  issuedAt: Date;
  actorUserId: number;
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
    totals,
  } = args;

  const customerNameSnapshot = (document.customerNameSnapshot ?? "").trim();
  if (customerNameSnapshot.length === 0) {
    throw new ValidationError(
      "customerNameSnapshot is required to issue a document"
    );
  }

  const customerSnapshot: CustomerSnapshot = {
    id: customer?.id ?? null,
    name: customerNameSnapshot,
    legalName: null,
    taxId: null,
    phone: customer?.phone ?? null,
    email: customer?.email ?? null,
    city: customer?.city ?? null,
    address: null,
  };

  const issuerSnapshot: IssuerSnapshot = {
    id: business.id,
    name: business.name,
    legalName: null,
    taxId: null,
    vatRegistration: null,
    address: null,
    phone: null,
    email: null,
    logoUrl: null,
    bankDetails: null,
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
      referenceDocumentId: null,
    },
    issuer: issuerSnapshot,
    customer: customerSnapshot,
    lines: lineSnapshots,
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
    extensions: {},
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
      include: { lines: { orderBy: { lineIndex: "asc" } } },
    });

    if (!doc) {
      throw new NotFoundError("Billing document not found");
    }

    if (doc.status !== BillingDocumentStatus.PENDING_REVIEW) {
      throw new ForbiddenError(DOCUMENT_ALREADY_HANDLED_MESSAGE);
    }

    const customerNameSnapshot = (doc.customerNameSnapshot ?? "").trim();
    if (customerNameSnapshot.length === 0) {
      throw new ValidationError(
        "customerNameSnapshot is required to issue a document"
      );
    }

    if (doc.lines.length === 0) {
      throw new ValidationError(
        "Cannot issue a document with no lines"
      );
    }

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

    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, name: true },
    });

    if (!business) {
      throw new NotFoundError("Business not found");
    }

    let customerData:
      | {
          id: number;
          name: string;
          phone: string | null;
          email: string | null;
          city: string | null;
        }
      | null = null;

    if (doc.customerId !== null) {
      const customer = await tx.customer.findFirst({
        where: { id: doc.customerId, businessId: input.businessId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          city: true,
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
      totals: recomputed.totals,
    });

    const updated = await tx.billingDocument.updateMany({
      where: {
        id: input.billingDocumentId,
        businessId: input.businessId,
        status: BillingDocumentStatus.PENDING_REVIEW,
      },
      data: {
        status: BillingDocumentStatus.ISSUED,
        documentNumber,
        documentNumberFormatted,
        issuedAt,
        issuedByUserId: input.actorUserId,
        issuedSnapshot: snapshot as unknown as Prisma.InputJsonValue,
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

    return {
      issued,
      documentNumber,
      documentNumberFormatted,
      totals: recomputed.totals,
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
      subtotalAmount: result.totals.subtotalAmount.toString(),
      vatAmount: result.totals.vatAmount.toString(),
      totalAmount: result.totals.totalAmount.toString(),
      lineCount: result.issued.lines.length,
      snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
      actorUserId: input.actorUserId,
    },
  });

  return result.issued;
}
