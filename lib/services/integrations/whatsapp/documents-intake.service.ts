import { createDocumentFromOcrText } from "@/lib/services/documents/create-document-from-ocr.service";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
} from "@/lib/services/documents/document-storage.service";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";
import { writeTempOcrFile } from "@/lib/services/integrations/gmail/temp-ocr-file.service";
import { getAccessTokenForBusiness } from "./connection.service";
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
  | { status: "skipped_duplicate"; reason: "wamid" | "content_hash" }
  | { status: "failed"; reason: string; importId?: number }
  | { status: "imported"; documentId: number; importId: number };

export type WhatsAppIntakeDeps = {
  checkWamidDedup: typeof checkWhatsAppImportWamidDedup;
  checkHashDedup: typeof checkWhatsAppImportHashDedup;
  createFailedImport: typeof createWhatsAppFailedImport;
  claimProcessing: typeof claimWhatsAppProcessingImport;
  markImported: typeof markWhatsAppImportImported;
  markFailed: typeof markWhatsAppImportFailed;
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
  const wamidDedup = await deps.checkWamidDedup({
    businessId: input.businessId,
    wamid: input.wamid,
  });
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
      const failed = await deps.createFailedImport({
        businessId: input.businessId,
        wamid: input.wamid,
        mediaId: input.mediaId,
        phoneNumberId: input.phoneNumberId,
        fromPhone: input.sender,
        mediaType: input.mediaType,
        error: "media_fetch:missing_access_token",
      });
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
    const failed = await deps.createFailedImport({
      businessId: input.businessId,
      wamid: input.wamid,
      mediaId: input.mediaId,
      phoneNumberId: input.phoneNumberId,
      fromPhone: input.sender,
      mediaType: input.mediaType,
      error: `media_fetch:${mediaResult.reason}`,
    });
    return {
      status: "failed",
      reason: mediaResult.reason,
      importId: failed.id,
    };
  }

  const contentHashSha256 = deps.sha256Hex(mediaResult.buffer);

  const hashDedup = await deps.checkHashDedup({
    businessId: input.businessId,
    contentHashSha256,
  });
  if (!hashDedup.ok) {
    return { status: "skipped_duplicate", reason: "content_hash" };
  }

  const claim = await deps.claimProcessing({
    businessId: input.businessId,
    wamid: input.wamid,
    mediaId: input.mediaId,
    phoneNumberId: input.phoneNumberId,
    fromPhone: input.sender,
    mimeType: mediaResult.mimeType,
    sizeBytes: mediaResult.sizeBytes,
    filename: mediaResult.filename,
    contentHashSha256,
  });
  if (!claim.ok) {
    return { status: "skipped_duplicate", reason: claim.reason };
  }

  const importId = claim.importId;
  let tempCleanup: (() => Promise<void>) | null = null;
  let storedFileName: string | null = null;
  let documentCreated = false;

  const fail = async (reason: string): Promise<WhatsAppIntakeOutcome> => {
    await deps.markFailed({ importId, error: reason });
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

    // SEC-24: OCR is best-effort ENRICHMENT. Its failure or empty result MUST
    // NOT discard the already-persisted artifact — mirror the upload / Gmail
    // paths and fall through with empty text so a needs_review document is still
    // created and the file survives (reviewable). Only genuine PERSISTENCE
    // failures (storage put / document row) remain fatal.
    let rawText = "";
    try {
      rawText = (await deps.runOcr(tmp.tempPath, mediaResult.mimeType)).trim();
    } catch {
      rawText = "";
    }

    let created: Awaited<ReturnType<typeof createDocumentFromOcrText>>;
    try {
      created = await deps.createDocument({
        businessId: input.businessId,
        source: "whatsapp",
        mimeType: mediaResult.mimeType,
        ocrText: rawText,
        fileUrl: storedFileName,
      });
    } catch {
      return fail("create_document_failed");
    }

    documentCreated = true;
    await deps.markImported({
      importId,
      documentId: created.documentId,
    });

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
