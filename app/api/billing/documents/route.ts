import { NextRequest, NextResponse } from "next/server";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  Prisma,
} from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  createBillingDraft,
  CreateBillingDraftInput,
} from "@/lib/services/billing/billing-draft.service";
import { assertBillingIdentityReadyForTaxInvoice } from "@/lib/billing/business-identity";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Exported for the response-boundary regression test (see
// list-response.regression.test.ts). Export only — the runtime behaviour and
// the object contents (minus the removed pdfStorageKey) are unchanged.
export const LIST_SELECT = {
  id: true,
  businessId: true,
  documentType: true,
  status: true,
  documentNumber: true,
  documentNumberFormatted: true,
  customerId: true,
  customerNameSnapshot: true,
  subtotalAmount: true,
  vatAmount: true,
  totalAmount: true,
  currency: true,
  issuedAt: true,
  issuedByUserId: true,
  createdByUserId: true,
  convertedToInvoiceId: true,
  pdfRenderStatus: true,
  pdfTemplateVersion: true,
  // pdfStorageKey removed (M-3): internal R2 object-key must not egress via the
  // billing documents LIST response. pdfHash is intentionally retained (scope).
  pdfHash: true,
  pdfRenderedAt: true,
  pdfRenderError: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BillingDocumentSelect;

function parsePositiveInt(
  value: string | null,
  fieldName: string
): number | undefined {
  if (value === null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
  return num;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const documentTypeRaw = body.documentType;
    if (
      typeof documentTypeRaw !== "string" ||
      !Object.values(BillingDocumentType).includes(
        documentTypeRaw as BillingDocumentType
      )
    ) {
      throw new ValidationError(
        "documentType is required and must be a valid BillingDocumentType"
      );
    }

    const input: CreateBillingDraftInput = {
      businessId: user.businessId,
      actorUserId: user.id,
      documentType: documentTypeRaw as BillingDocumentType,
    };

    if (documentTypeRaw === BillingDocumentType.TAX_INVOICE) {
      const issuerProfile = await prisma.businessProfile.findUnique({
        where: { businessId: user.businessId },
        select: {
          billingLegalName: true,
          billingBusinessKind: true,
          billingTaxId: true,
          billingPhone: true,
          billingEmail: true,
          billingAddress: true,
        },
      });
      assertBillingIdentityReadyForTaxInvoice(issuerProfile);
    }

    if ("customerId" in body) {
      input.customerId = body.customerId;
    }
    if ("customerNameSnapshot" in body) {
      input.customerNameSnapshot = body.customerNameSnapshot;
    }
    if (Array.isArray(body.initialLines)) {
      input.initialLines = body.initialLines;
    }

    const document = await createBillingDraft(input);

    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const customerIdParam = searchParams.get("customerId");
    const limitParam = searchParams.get("limit");
    const cursorParam = searchParams.get("cursor");
    const searchRaw = (searchParams.get("search") ?? "").trim();
    const documentTypeParam = searchParams.get("documentType");

    let status: BillingDocumentStatus | undefined;
    if (statusParam !== null && statusParam !== "") {
      if (
        !Object.values(BillingDocumentStatus).includes(
          statusParam as BillingDocumentStatus
        )
      ) {
        throw new ValidationError("Invalid status filter");
      }
      status = statusParam as BillingDocumentStatus;
    }

    let documentTypeFilter: BillingDocumentType | undefined;
    if (documentTypeParam !== null && documentTypeParam !== "") {
      if (
        !Object.values(BillingDocumentType).includes(
          documentTypeParam as BillingDocumentType
        )
      ) {
        throw new ValidationError("Invalid documentType filter");
      }
      documentTypeFilter = documentTypeParam as BillingDocumentType;
    }

    const customerId = parsePositiveInt(customerIdParam, "customerId");

    let limit = DEFAULT_LIMIT;
    if (limitParam !== null && limitParam !== "") {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ValidationError("limit must be a positive integer");
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const cursor = parsePositiveInt(cursorParam, "cursor");

    const where: Prisma.BillingDocumentWhereInput = {
      businessId: user.businessId,
      ...(status !== undefined ? { status } : {}),
      ...(documentTypeFilter !== undefined ? { documentType: documentTypeFilter } : {}),
      ...(customerId !== undefined ? { customerId } : {}),
      ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
      ...(searchRaw.length > 0
        ? {
            OR: [
              {
                customerNameSnapshot: {
                  contains: searchRaw,
                  mode: "insensitive",
                },
              },
              {
                documentNumberFormatted: {
                  contains: searchRaw,
                },
              },
            ],
          }
        : {}),
    };

    const [documents, rawTotals] = await Promise.all([
      prisma.billingDocument.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: LIST_SELECT,
      }),
      prisma.billingDocument.groupBy({
        by: ["documentType", "status"],
        where: { businessId: user.businessId },
        _count: { _all: true },
      }),
    ]);

    const totals = {
      all: rawTotals.reduce((s, r) => s + r._count._all, 0),
      quotes: rawTotals
        .filter((r) => r.documentType === BillingDocumentType.QUOTE)
        .reduce((s, r) => s + r._count._all, 0),
      invoices: rawTotals
        .filter((r) => r.documentType === BillingDocumentType.TAX_INVOICE)
        .reduce((s, r) => s + r._count._all, 0),
      drafts: rawTotals
        .filter((r) => r.status === BillingDocumentStatus.DRAFT)
        .reduce((s, r) => s + r._count._all, 0),
      issued: rawTotals
        .filter((r) => r.status === BillingDocumentStatus.ISSUED)
        .reduce((s, r) => s + r._count._all, 0),
    };

    const nextCursor =
      documents.length === limit
        ? documents[documents.length - 1].id
        : null;

    return NextResponse.json(
      { documents, totals, nextCursor },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
