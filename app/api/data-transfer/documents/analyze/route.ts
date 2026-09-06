import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import {
  DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
  DOCUMENTS_IMPORT_MAX_FILES,
  documentsBatchContentHash,
  documentsMappingHash,
} from "@/lib/data-transfer/documents/documents-import-config";
import {
  analyzeDocumentBatch,
  defaultDocumentDecisions,
  documentDecisionsHash,
  isDecisionPermitted,
} from "@/lib/data-transfer/documents/batch-analyze";
import { readDocumentBatchForm } from "@/lib/data-transfer/documents/documents-request";
import { issuePreviewToken } from "@/lib/data-transfer/import/preview/preview-token";
import { IMPORT_PREVIEW_TTL_SECONDS } from "@/lib/data-transfer/import/import-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Documents import — batch triage. READ ONLY.
 *
 * # Why there is one endpoint here and two for the tabular domains
 *
 * The tabular flow needs `analyze` to propose a column mapping and `preview` to
 * evaluate the owner's edit of it. Documents have no columns, so there is no
 * mapping step and nothing to propose — the analysis IS the preview. A second
 * endpoint would exist only to look symmetrical.
 *
 * It is still called twice, exactly like I-6: once with no decisions, which
 * returns the server's defaults and a token; then again with the owner's
 * choices, which re-derives everything from the same bytes, re-checks that each
 * choice is one it would actually offer, and issues a token bound to those
 * choices. Execute demands that token.
 *
 * # Zero writes
 *
 * Nothing in this handler or anything it calls creates a Document, a storage
 * object, a processing job, an ImportRun or an ImportRunRow. The only database
 * access is one tenant-scoped read of existing content hashes. That property is
 * asserted structurally by the verifier.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  // Reading and hashing a batch is real work. Gate it before the body is read,
  // and fail closed. Analyze and Execute share this bucket on purpose: the
  // ceiling is meant to bound documents ingested per day, and a caller who
  // could analyze without limit could still not execute, but would be free to
  // spend the server's time hashing.
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

  const batch = await readDocumentBatchForm(form);
  if (!batch.ok) {
    return NextResponse.json(
      { error: batch.error, code: batch.code },
      { status: batch.status, headers: NO_STORE }
    );
  }

  try {
    const analyzed = await analyzeDocumentBatch({
      // Server-derived. There is no businessId field in this request.
      businessId: user.businessId,
      files: batch.files,
    });

    const decisions = defaultDocumentDecisions(analyzed.files);
    if (batch.decisions) {
      const byIndex = new Map(analyzed.files.map((f) => [f.index, f]));
      for (const [rawIndex, action] of Object.entries(batch.decisions)) {
        const index = Number(rawIndex);
        const file = byIndex.get(index);
        if (!file) {
          return NextResponse.json(
            { error: "בחירה עבור קובץ שאינו בקבוצה", code: "UNKNOWN_FILE" },
            { status: 400, headers: NO_STORE }
          );
        }
        if (!isDecisionPermitted(file, action)) {
          return NextResponse.json(
            {
              error: "לא ניתן לקלוט את הקובץ הזה",
              code: "DECISION_NOT_PERMITTED",
              index,
            },
            { status: 409, headers: NO_STORE }
          );
        }
        decisions[index] = action;
      }
    }

    const issuedAt = new Date();
    const previewToken = issuePreviewToken(
      {
        businessId: user.businessId,
        userId: user.id,
        domain: "documents",
        // The batch's identity: the ordered per-file content hashes. The files
        // themselves, and their names, stay out of the signed payload.
        contentHash: documentsBatchContentHash(analyzed.contentHashes),
        mappingHash: documentsMappingHash(),
        decisionsHash: documentDecisionsHash(decisions),
        sheetName: null,
        rowCount: analyzed.files.length,
      },
      issuedAt
    );

    return NextResponse.json(
      {
        ok: true,
        summary: analyzed.summary,
        files: analyzed.files,
        decisions,
        limits: {
          maxFiles: DOCUMENTS_IMPORT_MAX_FILES,
          maxBatchBytes: DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
        },
        previewToken,
        expiresAt: new Date(
          issuedAt.getTime() + IMPORT_PREVIEW_TTL_SECONDS * 1000
        ).toISOString(),
      },
      { status: 200, headers: NO_STORE }
    );
  } catch (error) {
    // Never echo the thrown message: it can carry a filename.
    console.error("[data-transfer/documents/analyze] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "בדיקת הקבצים נכשלה. נסו שוב מאוחר יותר.", code: "ANALYZE_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
