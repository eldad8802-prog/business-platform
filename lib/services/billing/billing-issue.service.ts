import {
  BillingAuthoritySubmissionStatus,
  BillingDocument,
  BillingDocumentLine,
  BillingDocumentStatus,
  BillingDocumentType,
  BillingPdfRenderStatus,
  CustomerTaxIdType,
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
import {
  createAuthoritySubmissionForIssuedDocumentTx,
  type CreateAuthoritySubmissionAtIssueResult,
} from "@/lib/services/billing/authority/billing-authority-issue.service";
import {
  executeAuthorityApproval,
  type ExecutionResult,
} from "@/lib/services/billing/authority/billing-authority-submission-execution.service";
import {
  AUTHORITY_ISSUE_NOT_REQUIRED,
  mapExecutionResultToAuthorityOutcome,
  type AuthorityIssueOutcome,
} from "@/lib/services/billing/authority/billing-authority-issue-outcome";
import {
  assertCanReferenceSourceInvoice,
  assertCreditAmountWithinRemaining,
} from "@/lib/services/billing/billing-credit-reversal.service";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";
import { ensureBillingInvoicePostedEvent } from "@/lib/services/financial-events/financial-event.service";
import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";
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

export function hashIssuedSnapshot(snapshot: IssuedSnapshot): string {
  return createHash("sha256")
    .update(stableJsonStringify(snapshot))
    .digest("hex");
}

export function buildIssuedSnapshot(args: {
  document: BillingDocument;
  lines: BillingDocumentLine[];
  business: { id: number; name: string; profile: BusinessProfileForInvoice };
  customer: {
    id: number;
    name: string;
    phone: string | null;
    email: string | null;
    city: string | null;
    taxId: string | null;
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

  const customerSnapshot: CustomerSnapshot = {
    id: customer?.id ?? null,
    name: customerNameSnapshot,
    legalName: null,
    taxId: customer?.taxId ?? null,
    phone: customer?.phone ?? null,
    email: customer?.email ?? null,
    city: customer?.city ?? null,
    address: null,
  };

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

/** Result of issuance: the document plus the resolved authority outcome. */
export type IssueBillingDocumentResult = {
  document: BillingDocument & { lines: BillingDocumentLine[] };
  authority: AuthorityIssueOutcome;
};

/** Injectable authority execution — swapped in tests; real path calls the Execution Service. */
export type IssueAuthorityDeps = {
  executeApproval: (input: {
    businessId: number;
    billingDocumentId: number;
    actorUserId: number;
  }) => Promise<ExecutionResult>;
};

export const defaultIssueAuthorityDeps: IssueAuthorityDeps = {
  executeApproval: (input) => executeAuthorityApproval(input),
};

/**
 * Post-commit authority resolution. MUST run only after the issue transaction
 * has committed — it performs the external Approval HTTP call via the Execution
 * Service (never inside a Prisma transaction).
 *
 * - No submission / NOT_REQUIRED → `not_required` (no HTTP).
 * - READY → execute ONE approval attempt, map the result.
 * - Any other status → defensive `in_progress` (no HTTP).
 *
 * A late/unexpected throw is contained: the document is already ISSUED and must
 * NOT be reported as a failed issuance. It is surfaced as `execution_error`
 * with a filtered code; nothing sensitive is logged.
 */
export async function resolveAuthorityOutcomeAfterIssue(
  args: {
    businessId: number;
    billingDocumentId: number;
    actorUserId: number;
    submission: CreateAuthoritySubmissionAtIssueResult | null;
  },
  deps: IssueAuthorityDeps = defaultIssueAuthorityDeps
): Promise<AuthorityIssueOutcome> {
  const { submission } = args;

  if (submission === null) {
    return AUTHORITY_ISSUE_NOT_REQUIRED;
  }
  if (submission.status === BillingAuthoritySubmissionStatus.NOT_REQUIRED) {
    return { status: "not_required", submissionId: submission.submissionId };
  }
  if (submission.status !== BillingAuthoritySubmissionStatus.READY) {
    // Defensive: at issue time a submission is only ever READY or NOT_REQUIRED.
    return { status: "in_progress", submissionId: submission.submissionId, safeToRetry: false };
  }

  try {
    const result = await deps.executeApproval({
      businessId: args.businessId,
      billingDocumentId: args.billingDocumentId,
      actorUserId: args.actorUserId,
    });
    return mapExecutionResultToAuthorityOutcome(result);
  } catch {
    // Filtered log only — no token / runtime context / payload / raw response.
    console.error("billing-issue: authority approval threw after commit", {
      businessId: args.businessId,
      billingDocumentId: args.billingDocumentId,
      submissionId: submission.submissionId,
      errorCode: "AUTHORITY_EXECUTION_UNEXPECTED",
    });
    return {
      status: "execution_error",
      submissionId: submission.submissionId,
      errorCode: "AUTHORITY_EXECUTION_UNEXPECTED",
      safeToRetry: "manual",
    };
  }
}

export async function issueBillingDocument(
  input: IssueBillingDocumentInput,
  authorityDeps: IssueAuthorityDeps = defaultIssueAuthorityDeps
): Promise<IssueBillingDocumentResult> {
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
        creditTotalAmount: recomputed.totals.totalAmount,
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

    let customerData:
      | {
          id: number;
          name: string;
          phone: string | null;
          email: string | null;
          city: string | null;
          taxId: string | null;
          taxIdType: CustomerTaxIdType | null;
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
          taxId: true,
          // Needed for authority readiness (licensed-dealer check). Not part of
          // the issued snapshot; used only to evaluate submission readiness.
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
      totals: recomputed.totals,
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

    await ensureBillingInvoicePostedEvent(tx, issued);
    await createBillingAuditEventTx(tx, {
      businessId: input.businessId,
      billingDocumentId: issued.id,
      actorUserId: input.actorUserId,
      eventType:
        issued.documentType === BillingDocumentType.CREDIT_NOTE
          ? "BILLING_CREDIT_NOTE_ISSUED"
          : "BILLING_DOC_ISSUED",
      summary:
        issued.documentType === BillingDocumentType.CREDIT_NOTE
          ? "Credit note issued"
          : "Billing document issued",
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
        subtotalAmount: recomputed.totals.subtotalAmount.toString(),
        vatAmount: recomputed.totals.vatAmount.toString(),
        totalAmount: recomputed.totals.totalAmount.toString(),
        currency: issued.currency,
        lineCount: issued.lines.length,
        snapshotSchemaVersion: SNAPSHOT_SCHEMA_VERSION,
        actorUserId: input.actorUserId,
      },
      occurredAt: issuedAt,
    });

    // Atomic with issuance: create the authority submission (READY / NOT_REQUIRED)
    // for the now-ISSUED document. Returns null for non-eligible document types.
    // Any failure here rolls back the whole issue transaction (no ISSUED document
    // without a resolved authority readiness when the type is relevant).
    const authoritySubmission = await createAuthoritySubmissionForIssuedDocumentTx(
      tx,
      {
        businessId: input.businessId,
        billingDocumentId: issued.id,
        actorUserId: input.actorUserId,
        documentType: issued.documentType,
        legalSnapshotHash,
        vatAmount: recomputed.totals.vatAmount,
        subtotalAmount: recomputed.totals.subtotalAmount,
        currency: issued.currency,
        customerTaxId: customerData?.taxId ?? null,
        customerTaxIdType: customerData?.taxIdType ?? null,
        issuedAt,
      }
    );

    return {
      issued,
      documentNumber,
      documentNumberFormatted,
      totals: recomputed.totals,
      authoritySubmission,
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

  // Post-commit ONLY: the external Approval call happens outside any transaction.
  const authority = await resolveAuthorityOutcomeAfterIssue(
    {
      businessId: input.businessId,
      billingDocumentId: result.issued.id,
      actorUserId: input.actorUserId,
      submission: result.authoritySubmission,
    },
    authorityDeps
  );

  return { document: result.issued, authority };
}
