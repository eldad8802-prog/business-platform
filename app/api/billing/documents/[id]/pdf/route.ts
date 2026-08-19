import { NextRequest, NextResponse } from "next/server";
import { BillingDocumentType } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getOrRenderQuotePdf } from "@/lib/services/billing/quote-pdf.service";
import { getFiscalBillingPdfForDelivery } from "@/lib/services/billing/signed-pdf-delivery.wiring";

// pdfmake is a Node-only dependency (CJS, uses Buffer + fs internally via
// pdfkit). Pinning the route to the Node runtime is mandatory.
export const runtime = "nodejs";

// PDF responses are never statically optimizable; opt out of any framework
// caching so we always go through the cache-or-render decision in the service.
export const dynamic = "force-dynamic";

function parseBillingDocumentId(value: string): number {
  const num = Number(value);
  if (
    !num ||
    Number.isNaN(num) ||
    !Number.isInteger(num) ||
    num <= 0
  ) {
    throw new ValidationError("Invalid billing document id");
  }
  return num;
}

function buildContentDisposition(documentNumberFormatted: string): string {
  const asciiName = `invoice-${documentNumberFormatted}.pdf`;
  const utf8Name = encodeURIComponent(`חשבונית-${documentNumberFormatted}.pdf`);
  // RFC 5987: filename* fallback for non-ASCII (Hebrew) names. Browsers that
  // understand it use it, others use the ASCII filename.
  return `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}

function buildQuoteContentDisposition(documentNumberFormatted: string): string {
  const asciiName = `quote-${documentNumberFormatted}.pdf`;
  const utf8Name = encodeURIComponent(`הצעת-מחיר-${documentNumberFormatted}.pdf`);
  return `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const billingDocumentId = parseBillingDocumentId(id);

    const meta = await prisma.billingDocument.findFirst({
      where: { id: billingDocumentId, businessId: user.businessId },
      select: { documentType: true },
    });

    if (!meta) {
      throw new NotFoundError("Billing document not found");
    }

    // Quotes: unchanged (mutable lifecycle, out of scope for signing). Fiscal ISSUED
    // documents: go through the delivery orchestrator, which serves the canonical
    // signed artifact when signing is active and is a byte-for-byte passthrough of the
    // unsigned pipeline when it is OFF (the default). `servedHash` is the ETag hash:
    // the unsigned pdfHash when OFF/unsigned, the signedPdfHash when signed.
    let buffer: Buffer;
    let etagHash: string;
    let pdfTemplateVersion: string;
    let documentNumberFormatted: string;
    if (meta.documentType === BillingDocumentType.QUOTE) {
      const result = await getOrRenderQuotePdf({
        businessId: user.businessId,
        actorUserId: user.id,
        billingDocumentId,
      });
      buffer = result.buffer;
      etagHash = result.pdfHash;
      pdfTemplateVersion = result.pdfTemplateVersion;
      documentNumberFormatted = result.documentNumberFormatted;
    } else {
      const result = await getFiscalBillingPdfForDelivery({
        businessId: user.businessId,
        actorUserId: user.id,
        billingDocumentId,
      });
      buffer = result.buffer;
      etagHash = result.servedHash;
      pdfTemplateVersion = result.pdfTemplateVersion;
      documentNumberFormatted = result.documentNumberFormatted;
    }

    const etag = `"${etagHash}"`;
    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, max-age=0, must-revalidate",
        },
      });
    }

    const contentDisposition =
      meta.documentType === BillingDocumentType.QUOTE
        ? buildQuoteContentDisposition(documentNumberFormatted)
        : buildContentDisposition(documentNumberFormatted);

    const headers = new Headers({
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": contentDisposition,
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Billing-Pdf-Template-Version": pdfTemplateVersion,
    });

    // Copy bytes into a fresh, non-shared ArrayBuffer so the body is a
    // plain BufferSource (TypeScript 5.7+ tightened Uint8Array/Buffer typing
    // such that they're not directly assignable to BodyInit).
    const body = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(body).set(buffer);
    return new NextResponse(body, { status: 200, headers });
  } catch (error) {
    return handleError(error);
  }
}
