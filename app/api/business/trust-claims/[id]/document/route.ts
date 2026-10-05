import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { attachVerificationDocument, verificationDocumentRef } from "@/lib/services/trust/trust-claim.service";
import { MAX_TRUST_DOCUMENT_BYTES, prepareTrustDocument, putTrustDocument, readTrustDocument } from "@/lib/services/trust/trust-document-storage";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";

async function claimId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * P3-A — upload the PRIVATE supporting document of a verification-required claim (multipart field
 * "file"). The claim is checked to belong to the session's business BEFORE any byte is stored; the key,
 * sha256 and MIME are computed server-side from the real bytes; there is no public URL.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await claimId(params);
  if (id === null) return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  try {
    const owned = await tenantTx(user.businessId, (tx) =>
      tx.businessTrustClaim.findFirst({ where: { id, businessId: user.businessId, status: "ACTIVE" }, select: { id: true } }),
    );
    if (!owned) return NextResponse.json({ error: "Trust claim not found" }, { status: 404 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) return NextResponse.json({ error: "file is required" }, { status: 400 });
    if (file.size > MAX_TRUST_DOCUMENT_BYTES) return NextResponse.json({ error: "The file is too large (up to 10MB)" }, { status: 400 });
    const body = Buffer.from(await file.arrayBuffer());
    const doc = prepareTrustDocument({ businessId: user.businessId, claimId: id, mimeType: file.type, body });
    await putTrustDocument({ businessId: user.businessId, storageKey: doc.storageKey, body, mimeType: doc.mimeType });
    const claim = await tenantTx(user.businessId, (tx) =>
      attachVerificationDocument(
        { businessId: user.businessId, userId: user.id, claimId: id, storageKey: doc.storageKey, sha256: doc.sha256, mimeType: doc.mimeType },
        tx,
      ),
    );
    return NextResponse.json({ claim });
  } catch (error) {
    return trustErrorResponse(error, "POST /api/business/trust-claims/[id]/document");
  }
}

/** P3-A — the owner downloads their own private document. Streamed through the API; never a URL. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = await claimId(params);
  if (id === null) return NextResponse.json({ error: "Invalid claim id" }, { status: 400 });
  try {
    const ref = await tenantTx(user.businessId, (tx) => verificationDocumentRef({ businessId: user.businessId, claimId: id }, tx));
    if (!ref) return NextResponse.json({ error: "No document" }, { status: 404 });
    const doc = await readTrustDocument({ businessId: user.businessId, storageKey: ref.storageKey });
    return new NextResponse(new Uint8Array(doc.body), {
      headers: {
        "Content-Type": ref.mimeType,
        "Content-Disposition": "attachment",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return trustErrorResponse(error, "GET /api/business/trust-claims/[id]/document");
  }
}
