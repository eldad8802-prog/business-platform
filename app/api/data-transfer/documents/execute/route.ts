import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import { readDocumentBatchForm } from "@/lib/data-transfer/documents/documents-request";
import { executeDocumentImport } from "@/lib/data-transfer/documents/documents-execute";
import { readSessionIdFromRequest } from "@/lib/services/product-usage/record-product-usage-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Must stay a LITERAL — Next validates route-segment config statically.
 *
 * Extraction runs in `after()`, which keeps the invocation alive until it
 * settles, and a batch can queue up to 20 of them. This is the platform ceiling
 * and it is NOT a guarantee that every extraction finishes inside it: a batch of
 * slow OCRs can outlive the invocation. What that costs is bounded and is not an
 * ingestion failure — the documents and their markers are already committed, and
 * a document left in "processing" is recoverable through the existing reprocess
 * route. See the storage/processing split in the executor.
 */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Refusals that are the caller's fault, mapped to the status they deserve. */
const STATUS_BY_CODE: Record<string, number> = {
  NO_FILES: 400,
  TOO_MANY_FILES: 413,
  BATCH_TOO_LARGE: 413,
  TOKEN_MISSING: 400,
  TOKEN_MALFORMED: 400,
  TOKEN_BAD_SIGNATURE: 401,
  TOKEN_WRONG_PURPOSE: 401,
  TOKEN_EXPIRED: 410,
  TOKEN_WRONG_TENANT: 403,
  TOKEN_WRONG_USER: 403,
  TOKEN_WRONG_DOMAIN: 400,
  TOKEN_WRONG_MAPPING: 400,
  TOKEN_MISMATCH: 409,
  FILE_REJECTED: 409,
  DECISION_MISSING: 400,
  DECISION_NOT_PERMITTED: 409,
};

/**
 * The one endpoint that turns a confirmed Documents batch into documents.
 *
 * The files are sent again with the decisions and the attestation, because the
 * preview stored nothing. Everything is recomputed here: the per-file hashes,
 * the batch identity, the acceptance rules and the file signatures. Nothing in
 * the request is believed on its own.
 *
 * # Replay is safe by construction, not by check
 *
 * A retried, duplicated or double-clicked request resolves to the ImportRun
 * that already exists — unique on business, batch bytes, mapping sentinel and
 * decisions — and re-attempts only the positions with no marker. Each marker
 * commits in the SAME transaction as the Document row it describes, so a
 * committed document always has one. That is what makes this true for a
 * deliberate duplicate override as well, where duplicate detection is off.
 *
 * # Authorization
 *
 * Any authenticated user of the business may import, per the owner's decision
 * for this wave. The tenant is server-derived from the session and appears
 * nowhere in the request; a token minted for another business is rejected
 * before a single byte is hashed against it.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  // Before the body is read: a rejected request should cost nothing to serve.
  const decision = await checkRateLimit({
    bucket: "DATA_TRANSFER_DOCUMENTS_IMPORT",
    user: user.id,
    business: user.businessId,
    ip: getClientIp(req),
  });
  if (!decision.allowed) return buildRateLimitResponse(decision);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "בקשה לא תקינה", code: "INVALID_BODY" },
      { status: 400, headers: NO_STORE }
    );
  }

  const previewToken = form.get("previewToken");
  if (typeof previewToken !== "string" || previewToken.length === 0) {
    return NextResponse.json(
      { error: "חסר אישור בדיקה. יש להריץ בדיקה מחדש.", code: "TOKEN_MISSING" },
      { status: 400, headers: NO_STORE }
    );
  }

  const batch = await readDocumentBatchForm(form);
  if (!batch.ok) {
    return NextResponse.json(
      { error: batch.error, code: batch.code },
      { status: batch.status, headers: NO_STORE }
    );
  }
  if (!batch.decisions) {
    return NextResponse.json(
      { error: "חסרות הבחירות שאושרו", code: "DECISIONS_MALFORMED" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const result = await executeDocumentImport({
      // Server-derived. Neither appears in the request body.
      businessId: user.businessId,
      userId: user.id,
      files: batch.files,
      decisions: batch.decisions,
      previewToken,
      sessionId: readSessionIdFromRequest(req),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code, position: result.position },
        { status: STATUS_BY_CODE[result.code] ?? 400, headers: NO_STORE }
      );
    }

    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    // Never echo the thrown message: it can carry a filename.
    console.error("[data-transfer/documents/execute] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "קליטת הקבצים נכשלה. נסו שוב מאוחר יותר.", code: "EXECUTE_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
