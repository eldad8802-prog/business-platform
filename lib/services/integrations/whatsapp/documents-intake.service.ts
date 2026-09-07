import { createDocumentFromOcrText } from "@/lib/services/documents/create-document-from-ocr.service";
import { syncDocumentsReviewQueueNotification } from "@/lib/notifications/documents-review-queue-notifications";
import { findDuplicateDocumentTx } from "@/lib/services/documents/document-duplicate";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
} from "@/lib/services/documents/document-storage.service";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";
import { writeTempOcrFile } from "@/lib/services/integrations/gmail/temp-ocr-file.service";
import { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { getAccessTokenForBusiness } from "./connection.service";

/**
 * D2/P7-W4B: run a single DB step on a short tenant transaction when a tenant
 * context is established (the webhook path always is — runTenantJob). Outside
 * a context (pure unit tests with stubbed deps) the step runs directly. Under
 * an established context there is NO fallback to the global client.
 */
async function dbStep<T>(
  fn: (tx?: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(undefined);
}
import { fetchAndValidateWhatsAppMedia } from "./media-fetch.service";
import type { MediaFetchDeps, MediaFetchResult } from "./media-fetch.types";
import type { DocumentsIntakeMediaType } from "./routing.types";
import {
  checkWhatsAppImportHashDedup,
  checkWhatsAppImportWamidDedup,
} from "./whatsapp-import-dedup.service";
import {
  claimWhatsAppProcessingImport,
  createWhatsAppFailedImport,
  markWhatsAppImportFailed,
  markWhatsAppImportImported,
  markWhatsAppImportSkippedDuplicate,
} from "./whatsapp-import-row.service";

export type WhatsAppDocumentsIntakeInput = {
  businessId: number;
  phoneNumberId: string;
  sender: string;
  wamid: string;
  mediaType: DocumentsIntakeMediaType;
  mediaId: string;
};

export type WhatsAppIntakeOutcome =
  | {
      status: "skipped_duplicate";
      /**
       * `existing_document` is the CROSS-CHANNEL case: this business already
       * holds these bytes as a Document, however it arrived. The other two are
       * channel-event replays.
       */
      reason: "wamid" | "content_hash" | "existing_document";
      documentId?: number;
    }
  | { status: "failed"; reason: string; importId?: number }
  | { status: "imported"; documentId: number; importId: number };

export type WhatsAppIntakeDeps = {
  checkWamidDedup: typeof checkWhatsAppImportWamidDedup;
  checkHashDedup: typeof checkWhatsAppImportHashDedup;
  createFailedImport: typeof createWhatsAppFailedImport;
  claimProcessing: typeof claimWhatsAppProcessingImport;
  markImported: typeof markWhatsAppImportImported;
  markFailed: typeof markWhatsAppImportFailed;
  markSkippedDuplicate: typeof markWhatsAppImportSkippedDuplicate;
  fetchMedia: (
    params: { mediaId: string; routingMediaType: DocumentsIntakeMediaType },
    deps?: Partial<MediaFetchDeps>
  ) => Promise<MediaFetchResult>;
  sha256Hex: (bytes: Buffer) => string;
  writeTempOcrFile: typeof writeTempOcrFile;
  runOcr: typeof runGoogleVisionOCR;
  createDocument: typeof createDocumentFromOcrText;
  putDocument: typeof putDocumentObject;
  deleteDocument: typeof deleteDocumentObjectQuiet;
  buildStoredFileName: typeof buildStoredDocumentFileName;
  mediaFetchDeps?: Partial<MediaFetchDeps>;
  /**
   * Resolves the per-business WhatsApp access token used to fetch inbound
   * media for this tenant. Defaults to the encrypted-token lookup keyed by
   * `businessId`. When omitted (e.g. in unit tests that fully stub
   * `fetchMedia`), the per-business token gate is skipped.
   */
  getBusinessAccessToken?: (businessId: number) => Promise<string | null>;
};

export const defaultWhatsAppIntakeDeps: WhatsAppIntakeDeps = {
  checkWamidDedup: checkWhatsAppImportWamidDedup,
  checkHashDedup: checkWhatsAppImportHashDedup,
  createFailedImport: createWhatsAppFailedImport,
  claimProcessing: claimWhatsAppProcessingImport,
  markImported: markWhatsAppImportImported,
  markFailed: markWhatsAppImportFailed,
  markSkippedDuplicate: markWhatsAppImportSkippedDuplicate,
  fetchMedia: fetchAndValidateWhatsAppMedia,
  sha256Hex,
  writeTempOcrFile,
  runOcr: runGoogleVisionOCR,
  createDocument: createDocumentFromOcrText,
  putDocument: putDocumentObject,
  deleteDocument: deleteDocumentObjectQuiet,
  buildStoredFileName: buildStoredDocumentFileName,
  getBusinessAccessToken: async (businessId: number) =>
    (await getAccessTokenForBusiness(businessId))?.token ?? null,
};

export function intakeOutcomeLogFields(
  businessId: number,
  wamid: string,
  outcome: WhatsAppIntakeOutcome
): Record<string, unknown> {
  return {
    businessId,
    wamid,
    status: outcome.status,
    ...(outcome.status === "skipped_duplicate"
      ? { reason: outcome.reason }
      : {}),
    ...(outcome.status === "failed" ? { reason: outcome.reason } : {}),
    ...(outcome.status === "imported"
      ? { documentId: outcome.documentId, importId: outcome.importId }
      : {}),
    ...(outcome.status === "failed" && outcome.importId
      ? { importId: outcome.importId }
      : {}),
  };
}

/**
 * PR4 documents intake orchestrator — sync pipeline, no inbox bot/replies.
 * Mandatory order: wamid → fetch → hash → hash dedup → claim → persist → OCR → document → imported.
 */
export async function processWhatsAppDocumentsIntake(
  input: WhatsAppDocumentsIntakeInput,
  deps: WhatsAppIntakeDeps = defaultWhatsAppIntakeDeps
): Promise<WhatsAppIntakeOutcome> {
  const wamidDedup = await dbStep((tx) =>
    deps.checkWamidDedup(
      {
        businessId: input.businessId,
        wamid: input.wamid,
      },
      { tx }
    )
  );
  if (!wamidDedup.ok) {
    return { status: "skipped_duplicate", reason: "wamid" };
  }

  // Resolve the per-business access token and use it for the media fetch.
  // In a Tech Provider model each business owns its WABA/token, so inbound
  // media MUST be fetched with that tenant's token — never a global one.
  let mediaFetchDeps: Partial<MediaFetchDeps> | undefined = deps.mediaFetchDeps;
  if (deps.getBusinessAccessToken) {
    const businessToken = await deps.getBusinessAccessToken(input.businessId);
    if (!businessToken) {
      // No usable token for this business (not connected / revoked). Fail in a
      // controlled way — do NOT fall back to any global token. The token value
      // itself is never logged or surfaced.
      const failed = await dbStep((tx) =>
        deps.createFailedImport(
          {
            businessId: input.businessId,
            wamid: input.wamid,
            mediaId: input.mediaId,
            phoneNumberId: input.phoneNumberId,
            fromPhone: input.sender,
            mediaType: input.mediaType,
            error: "media_fetch:missing_access_token",
          },
          { tx }
        )
      );
      return {
        status: "failed",
        reason: "missing_access_token",
        importId: failed.id,
      };
    }
    mediaFetchDeps = { ...deps.mediaFetchDeps, getAccessToken: () => businessToken };
  }

  const mediaResult = await deps.fetchMedia(
    { mediaId: input.mediaId, routingMediaType: input.mediaType },
    mediaFetchDeps
  );
  if (!mediaResult.ok) {
    const failed = await dbStep((tx) =>
      deps.createFailedImport(
        {
          businessId: input.businessId,
          wamid: input.wamid,
          mediaId: input.mediaId,
          phoneNumberId: input.phoneNumberId,
          fromPhone: input.sender,
          mediaType: input.mediaType,
          error: `media_fetch:${mediaResult.reason}`,
        },
        { tx }
      )
    );
    return {
      status: "failed",
      reason: mediaResult.reason,
      importId: failed.id,
    };
  }

  const contentHashSha256 = deps.sha256Hex(mediaResult.buffer);

  const hashDedup = await dbStep((tx) =>
    deps.checkHashDedup(
      {
        businessId: input.businessId,
        contentHashSha256,
      },
      { tx }
    )
  );
  if (!hashDedup.ok) {
    return { status: "skipped_duplicate", reason: "content_hash" };
  }

  // Cross-channel: the business may already hold these exact bytes from the
  // upload screen, the import centre or Gmail. Asked before the claim, storage
  // and OCR, so a file already held costs none of them. The authoritative
  // race-safe check runs again inside the create transaction.
  const existingDocument = await dbStep((tx) =>
    // `dbStep` hands over the tenant transaction whenever a tenant context is
    // established, which the webhook path always has. Without one there is no
    // tenant-scoped read to make, so this returns nothing rather than querying
    // through some other client.
    tx
      ? findDuplicateDocumentTx(tx, input.businessId, contentHashSha256)
      : Promise.resolve(null)
  );
  if (existingDocument) {
    return {
      status: "skipped_duplicate",
      reason: "existing_document",
      documentId: existingDocument.documentId,
    };
  }

  // The claim INSERT gets its own transaction: a P2002 race aborts only this
  // tx; the wamid-vs-hash disambiguation then runs on a fresh transaction.
  let claim: Awaited<ReturnType<typeof deps.claimProcessing>>;
  try {
    claim = await dbStep((tx) =>
      deps.claimProcessing(
        {
          businessId: input.businessId,
          wamid: input.wamid,
          mediaId: input.mediaId,
          phoneNumberId: input.phoneNumberId,
          fromPhone: input.sender,
          mimeType: mediaResult.mimeType,
          sizeBytes: mediaResult.sizeBytes,
          filename: mediaResult.filename,
          contentHashSha256,
        },
        { tx }
      )
    );
  } catch (claimErr) {
    if (
      claimErr instanceof Prisma.PrismaClientKnownRequestError &&
      claimErr.code === "P2002"
    ) {
      const byWamid = await dbStep((tx) =>
        deps.checkWamidDedup(
          { businessId: input.businessId, wamid: input.wamid },
          { tx }
        )
      );
      claim = { ok: false, reason: byWamid.ok ? "content_hash" : "wamid" };
    } else {
      throw claimErr;
    }
  }
  if (!claim.ok) {
    return { status: "skipped_duplicate", reason: claim.reason };
  }

  const importId = claim.importId;
  let tempCleanup: (() => Promise<void>) | null = null;
  let storedFileName: string | null = null;
  let documentCreated = false;

  const fail = async (reason: string): Promise<WhatsAppIntakeOutcome> => {
    await dbStep((tx) =>
      deps.markFailed(
        { importId, businessId: input.businessId, error: reason },
        { tx }
      )
    );
    if (storedFileName && !documentCreated) {
      try {
        await deps.deleteDocument(input.businessId, storedFileName);
      } catch {
        // ignore cleanup errors
      }
    }
    return { status: "failed", reason, importId };
  };

  try {
    storedFileName = deps.buildStoredFileName(mediaResult.mimeType);
    try {
      await deps.putDocument({
        businessId: input.businessId,
        basename: storedFileName,
        body: mediaResult.buffer,
        contentType: mediaResult.mimeType,
        source: "whatsapp",
      });
    } catch {
      return fail("storage_failed");
    }

    const tmp = await deps.writeTempOcrFile({
      bytes: mediaResult.buffer,
      mimeType: mediaResult.mimeType,
      filenameHint: mediaResult.filename,
    });
    tempCleanup = tmp.cleanup;

    let rawText: string;
    try {
      rawText = (await deps.runOcr(tmp.tempPath, mediaResult.mimeType)).trim();
    } catch {
      return fail("ocr_failed");
    }

    if (!rawText) {
      return fail("ocr_empty");
    }

    let created: Awaited<ReturnType<typeof createDocumentFromOcrText>>;
    try {
      created = await deps.createDocument({
        businessId: input.businessId,
        source: "whatsapp",
        mimeType: mediaResult.mimeType,
        ocrText: rawText,
        // The channel's policy: an inbound copy of a file the business already
        // holds defers to it instead of creating a second Document.
        duplicatePolicy: "SKIP_IF_EXISTS",
        fileUrl: storedFileName,
        contentHashSha256,
        originalFilename: mediaResult.filename ?? null,
        sizeBytes: mediaResult.sizeBytes ?? null,
      });
    } catch {
      return fail("create_document_failed");
    }

    if (!created.ok) {
      // Lost the race to another channel between the early check and the lock.
      // Nothing was written, so release the object this attempt stored and
      // record the event as a duplicate skip rather than a failure.
      await dbStep((tx) =>
        deps.markSkippedDuplicate(
          {
            importId,
            businessId: input.businessId,
            documentId: created.duplicate.documentId,
          },
          { tx }
        )
      );
      try {
        await deps.deleteDocument(input.businessId, storedFileName);
      } catch {
        // ignore cleanup errors
      }
      return {
        status: "skipped_duplicate",
        reason: "existing_document",
        documentId: created.duplicate.documentId,
      };
    }

    documentCreated = true;
    await dbStep((tx) =>
      deps.markImported(
        {
          importId,
          businessId: input.businessId,
          documentId: created.documentId,
        },
        { tx }
      )
    );

    // The one path in this domain where the owner is not present. A supplier
    // sends an invoice over WhatsApp, it lands in `needs_review`, and until now
    // nothing told them. AFTER both transactions above committed; the tenant
    // context is the one runTenantJob established in the webhook from the
    // server-resolved connection lookup, never a payload field.
    //
    // It cannot affect the outcome: the document is durable, and the webhook
    // must answer 200 regardless or Meta will redeliver a file we already have.
    await syncDocumentsReviewQueueNotification(input.businessId, new Date());

    return {
      status: "imported",
      documentId: created.documentId,
      importId,
    };
  } finally {
    if (tempCleanup) {
      try {
        await tempCleanup();
      } catch {
        // ignore
      }
    }
  }
}
