import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { getOrRenderBillingPdf } from "@/lib/services/billing/billing-pdf.service";

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

    const result = await getOrRenderBillingPdf({
      businessId: user.businessId,
      actorUserId: user.id,
      billingDocumentId,
    });

    const etag = `"${result.pdfHash}"`;
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

    const headers = new Headers({
      "Content-Type": "application/pdf",
      "Content-Length": String(result.buffer.byteLength),
      "Content-Disposition": buildContentDisposition(result.documentNumberFormatted),
      ETag: etag,
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Billing-Pdf-Template-Version": result.pdfTemplateVersion,
    });

    // Copy bytes into a fresh, non-shared ArrayBuffer so the body is a
    // plain BufferSource (TypeScript 5.7+ tightened Uint8Array/Buffer typing
    // such that they're not directly assignable to BodyInit).
    const body = new ArrayBuffer(result.buffer.byteLength);
    new Uint8Array(body).set(result.buffer);
    return new NextResponse(body, { status: 200, headers });
  } catch (error) {
    return handleError(error);
  }
}
