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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const LIST_SELECT = {
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
  pdfRenderStatus: true,
  pdfTemplateVersion: true,
  pdfStorageKey: true,
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
      ...(customerId !== undefined ? { customerId } : {}),
      ...(cursor !== undefined ? { id: { lt: cursor } } : {}),
    };

    const documents = await prisma.billingDocument.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: LIST_SELECT,
    });

    const nextCursor =
      documents.length === limit
        ? documents[documents.length - 1].id
        : null;

    return NextResponse.json(
      { documents, nextCursor },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
