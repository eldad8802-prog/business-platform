/**
 * The ONE way a document enters Dubiz.
 *
 * Until now this orchestration lived inside `app/api/documents/upload/route.ts`.
 * That was fine while there was exactly one caller. It stops being fine the
 * moment a second one exists, because the sequence below is not a list of
 * independent steps — it is an ordering with real consequences:
 *
 *   hash -> duplicate lookup -> STORAGE -> Document row -> phase 2
 *
 * Storage is written BEFORE the row, deliberately: a row pointing at a file
 * that does not exist is a broken document, while a file with no row is an
 * orphan we can delete. The cleanup for that orphan is in this file too, so a
 * caller cannot forget it.
 *
 * Phase 2 is scheduled with `after()` from inside this service for the same
 * reason. A caller that forgot to schedule it would leave every document it
 * created stuck in "processing" forever, and nothing would ever say so.
 *
 * # What this service does NOT do
 *
 * It does not authenticate, parse a request, choose an HTTP status, apply a
 * rate limit, or record product-usage. Those belong to whichever surface is
 * calling — the upload screen and a future bulk import legitimately differ on
 * every one of them.
 *
 * It also never touches BillingDocument. Documents and issued fiscal documents
 * are separate models with no foreign key between them, and ingestion has no
 * business crossing that line.
 *
 * # Acceptance rules live here on purpose
 *
 * `isAllowedDocumentMime`, `isHeicMimeType` and DOCUMENT_MAX_UPLOAD_BYTES are
 * exported from this module rather than from the route, so a second caller
 * cannot quietly accept a file the first one would have refused. The HTTP
 * mapping of a refusal stays with the caller; the rule itself is shared.
 */

import { after } from "next/server";
import { runTenantJob } from "@/lib/tenant/job";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { processDocumentPipeline } from "@/lib/services/documents/process-document-pipeline.service";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
} from "@/lib/services/documents/document-storage.service";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

/** Largest single document accepted, in bytes. */
export const DOCUMENT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

function normalizeMime(mimeType: string): string {
  return String(mimeType || "").toLowerCase().trim();
}

/**
 * HEIC/HEIF — the default iPhone photo format — passes a naive `image/*` check
 * but Google Vision cannot OCR it, so it would silently produce no text. It is
 * refused explicitly and the caller is expected to say so in words the owner
 * can act on.
 */
export function isHeicMimeType(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  return m === "image/heic" || m === "image/heif";
}

export function isAllowedDocumentMime(mimeType: string): boolean {
  const m = normalizeMime(mimeType);
  if (isHeicMimeType(m)) return false;
  return m === "application/pdf" || m.startsWith("image/");
}

/** Where a document came from. Provenance metadata; nothing branches on it. */
export type DocumentIngestSource = "file" | "email" | "whatsapp";

export type IngestDocumentInput = {
  /** Server-derived. There is no path by which a caller may supply this. */
  businessId: number;
  userId: number;
  /** The already-read file bytes. */
  buffer: Buffer;
  mimeType: string;
  /** Uploader's filename, for display and duplicate triage only. */
  originalFilename: string | null;
  sizeBytes: number;
  source: DocumentIngestSource;
  /** The owner has seen the duplicate and chosen to ingest anyway. */
  allowDuplicate?: boolean;
  sessionId?: string | null;
  /** Passed through to the pipeline for its own telemetry. */
  sourceChannel?: "upload" | "reprocess";
  /**
   * Run the caller's own statement inside the SAME transaction as the Document
   * row, as its FIRST statement.
   *
   * # Why this exists, stated precisely
   *
   * The bulk import needs a durable per-file execution marker, and the only
   * dangerous state it can be in is "the Document was created but the marker
   * was not" — because then a retry has no evidence the file was ingested and
   * creates it a second time. For a deliberate duplicate override that is not
   * caught by duplicate detection either, since detection is exactly what the
   * owner switched off.
   *
   * Two separate transactions cannot rule that state out. One transaction can,
   * and this hook is what puts the caller's marker in it. Document row and
   * marker now commit together or not at all, so "created but unmarked" is not
   * a state the database can hold.
   *
   * # Why FIRST, and not after the create
   *
   * So that a unique violation from the hook is distinguishable from one raised
   * by the Document write. A failed statement aborts the whole transaction and
   * nothing after it can run, so the two cannot be told apart by catching them
   * separately — only by knowing which one was in flight.
   *
   * # What it must not be used for
   *
   * DB statements only, and short ones. The storage write has already happened
   * by the time this runs, deliberately, so that no non-database I/O is held
   * inside the transaction. A hook that threw would roll the Document back and
   * take the orphan cleanup path, which is correct but wasteful.
   */
  withinTransaction?: (tx: TenantTx) => Promise<void>;
};

export type DuplicateDocument = {
  documentId: number;
  status: string;
  uploadedAt: string;
  vendorName: string | null;
  amount: number | null;
  date: string | null;
};

export type IngestDocumentResult =
  | { ok: true; documentId: number; status: "processing" }
  | { ok: false; reason: "DUPLICATE"; duplicate: DuplicateDocument };

/**
 * Find an already-ingested document with identical bytes for THIS business.
 *
 * Tenant-scoped in the predicate and served by the
 * `(businessId, contentHashSha256)` index. `failed` rows are excluded on
 * purpose: a document whose processing failed is not evidence that the owner
 * already has this expense, and blocking a retry on it would be wrong.
 */
async function findDuplicate(
  businessId: number,
  contentHashSha256: string
): Promise<DuplicateDocument | null> {
  const existing = await runWithTenantContext({ businessId }, () =>
    withTenantTransaction((tx) =>
      tx.document.findFirst({
        where: {
          businessId,
          contentHashSha256,
          status: { not: "failed" },
        },
        orderBy: { id: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          extractedData: {
            select: { vendorName: true, amount: true, date: true },
          },
          financialRecord: {
            select: { vendorName: true, amount: true, date: true },
          },
        },
      })
    )
  );
  if (!existing) return null;

  const known = existing.financialRecord ?? existing.extractedData;
  return {
    documentId: existing.id,
    status: existing.status,
    uploadedAt: existing.createdAt.toISOString(),
    vendorName: known?.vendorName ?? null,
    amount: known?.amount ?? null,
    date: known?.date ? known.date.toISOString() : null,
  };
}

/**
 * Ingest one already-accepted document into the canonical Documents lifecycle.
 *
 * "Already-accepted" means the caller has authenticated the user, applied its
 * own admission control, and checked the file against the acceptance rules this
 * module exports. What happens after that point is identical for every caller,
 * and that is precisely what this function owns.
 *
 * Returns a DUPLICATE result rather than throwing: a duplicate is a decision
 * for the owner, not an error. Every other failure throws, and the caller maps
 * it — but the storage orphan is already cleaned up before it does.
 */
export async function ingestDocument(
  input: IngestDocumentInput
): Promise<IngestDocumentResult> {
  const contentHashSha256 = sha256Hex(input.buffer);

  if (!input.allowDuplicate) {
    const duplicate = await findDuplicate(input.businessId, contentHashSha256);
    if (duplicate) {
      return { ok: false, reason: "DUPLICATE", duplicate };
    }
  } else {
    console.warn("[documents] duplicate override accepted", {
      businessId: input.businessId,
      userId: input.userId,
      contentHashSha256,
    });
  }

  // Storage FIRST, unconditionally. A real storage failure stays fatal: no
  // stored file means no valid Document, and the caller's error path is the
  // right place to say so.
  const storedFileName = buildStoredDocumentFileName(input.mimeType);
  await putDocumentObject({
    businessId: input.businessId,
    basename: storedFileName,
    body: input.buffer,
    contentType: input.mimeType || "image/jpeg",
    source: input.source,
  });

  let documentId: number;
  try {
    const document = await runWithTenantContext(
      { businessId: input.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          // FIRST statement in the transaction — see `withinTransaction`.
          if (input.withinTransaction) await input.withinTransaction(tx);
          return tx.document.create({
            data: {
              businessId: input.businessId,
              // `fileUrl` stores ONLY the stored basename — no slashes, no
              // business id. The file route rebuilds the full path from the
              // AUTHENTICATED user's businessId, so a leaked name still cannot
              // reach another tenant's object.
              fileUrl: storedFileName,
              source: input.source,
              mimeType: input.mimeType || "image/jpeg",
              status: "processing",
              ocrText: null,
              contentHashSha256,
              originalFilename: input.originalFilename,
              sizeBytes: input.sizeBytes,
            },
          });
        })
    );
    documentId = document.id;
  } catch (error) {
    // The permanent copy exists but no row points at it. Remove it here rather
    // than leaving the caller to remember — an orphan that accumulates silently
    // is exactly the kind of debt nobody goes looking for.
    await deleteDocumentObjectQuiet(input.businessId, storedFileName).catch(
      () => {}
    );
    throw error;
  }

  // Phase 2 runs AFTER the response is sent. `after()` extends the serverless
  // invocation until it settles, so it survives client navigation. The
  // continuation re-establishes the tenant EXPLICITLY through runTenantJob —
  // the server-derived businessId travels in the closure and is never inherited
  // from request-scoped async storage. The pipeline never throws; it moves the
  // document to needs_review or failed on its own.
  after(() =>
    runTenantJob({ businessId: input.businessId }, () =>
      processDocumentPipeline({
        documentId,
        businessId: input.businessId,
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        buffer: input.buffer,
        mimeType: input.mimeType,
        sourceChannel: input.sourceChannel ?? "upload",
      })
    )
  );

  return { ok: true, documentId, status: "processing" };
}
