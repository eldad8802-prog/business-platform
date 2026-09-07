import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { prisma } from "@/lib/prisma";
import { getGmailAccessTokenForBusiness } from "@/lib/services/integrations/gmail/gmail-auth.service";
import { isGmailConnectionOwnedByBusiness } from "@/lib/services/integrations/gmail/gmail-connection.service";
import { GmailReauthRequiredError } from "@/lib/services/integrations/gmail/gmail-errors";
import { fetchGmailAttachmentBytes } from "@/lib/services/integrations/gmail/gmail-attachment-fetch.service";
import { checkEmailImportDedup } from "@/lib/services/integrations/gmail/email-import-dedup.service";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";
import { writeTempOcrFile } from "@/lib/services/integrations/gmail/temp-ocr-file.service";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";
import { createDocumentFromOcrText } from "@/lib/services/documents/create-document-from-ocr.service";
import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
  isHeicMimeType,
} from "@/lib/services/documents/document-ingestion.service";
import {
  signatureRejectionMessage,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";
import {
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
} from "@/lib/services/documents/document-storage.service";

export const runtime = "nodejs";

/**
 * The Documents ceiling, not a second copy of the number.
 *
 * It was an independent constant that happened to hold the same value; two
 * numbers obliged to agree with nothing making them agree is a drift waiting to
 * happen.
 */
const MAX_ATTACHMENT_BYTES = DOCUMENT_MAX_UPLOAD_BYTES;

type ImportRequestBody = {
  messageId: string;
  attachmentId: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  fromEmail: string | null;
  subject: string | null;
  sentAt: string | null;
};

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function safeNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeNullableNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  }
  // D2/P7-W4C: the whole import flow runs under the session tenant context.
  // Gmail/OCR/storage network work stays OUTSIDE any tenant transaction; the
  // ctx-aware Gmail services run their DB steps on short tenant txs, and the
  // route-level DB ops below are wrapped explicitly.
  return runWithTenantContext({ businessId: user.businessId }, () =>
    handleAuthedImport(req, user)
  );
}

async function handleAuthedImport(
  req: NextRequest,
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>
) {
  let cleanup: (() => Promise<void>) | null = null;
  let storedFileName: string | null = null;
  const businessId: number = user.businessId;
  let permanentFilePersisted = false;

  try {
    const json = (await req.json().catch(() => null)) as Partial<ImportRequestBody> | null;
    if (!json) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Optional account selection. When provided it must be a valid, owned Gmail
    // connection; otherwise we fall back to the first connected account
    // (unchanged single-account behavior).
    let requestedConnectionId: number | undefined;
    const rawConnectionId = (json as { connectionId?: unknown }).connectionId;
    if (rawConnectionId != null) {
      const parsed =
        typeof rawConnectionId === "number" ? rawConnectionId : Number(rawConnectionId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "connectionId לא תקין" }, { status: 400 });
      }
      const owned = await isGmailConnectionOwnedByBusiness({
        businessId: user.businessId,
        connectionId: parsed,
      });
      if (!owned) {
        return NextResponse.json({ error: "החשבון לא נמצא" }, { status: 404 });
      }
      requestedConnectionId = parsed;
    }

    const body: ImportRequestBody = {
      messageId: safeString(json.messageId),
      attachmentId: safeString(json.attachmentId),
      filename: safeNullableString(json.filename),
      mimeType: safeString(json.mimeType),
      sizeBytes: safeNullableNumber(json.sizeBytes),
      fromEmail: safeNullableString(json.fromEmail),
      subject: safeNullableString(json.subject),
      sentAt: safeNullableString(json.sentAt),
    };

    if (!body.messageId || !body.attachmentId) {
      return NextResponse.json(
        { error: "Missing messageId/attachmentId" },
        { status: 400 }
      );
    }

    // The canonical Documents allowlist — the same closed PDF/JPEG/PNG set the
    // upload screen and the import centre enforce. It used to be a private
    // wildcard here, so an emailed file could enter Documents that a direct
    // upload of the very same file would have refused.
    //
    // Provenance limitation, stated rather than papered over: this type is
    // still supplied by the CLIENT in the request body. Passing this gate means
    // the claim is one we support, and the byte check below means the file
    // really is that container — but the claim itself is not yet read from the
    // Gmail message payload.
    if (body.mimeType && isHeicMimeType(body.mimeType)) {
      return NextResponse.json(
        {
          error:
            "פורמט HEIC לא נתמך. צלם מחדש או המר את התמונה ל-JPG (בהגדרות המצלמה: 'תאימות מרבית').",
        },
        { status: 415 }
      );
    }

    if (!body.mimeType || !isAllowedDocumentMime(body.mimeType)) {
      return NextResponse.json(
        { error: "סוג קובץ לא נתמך (נדרש PDF, JPG או PNG)" },
        { status: 400 }
      );
    }

    if (body.sizeBytes != null && body.sizeBytes > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        {
          error: "הקובץ גדול מדי (עד 15MB)",
          limitBytes: MAX_ATTACHMENT_BYTES,
          sizeBytes: body.sizeBytes,
        },
        { status: 413 }
      );
    }

    // Dedup fast-path by message+attachment BEFORE downloading bytes.
    const preDedup = await withTenantTransaction((tx) =>
      checkEmailImportDedup(
        {
          businessId: user.businessId,
          provider: "gmail",
          messageId: body.messageId,
          attachmentId: body.attachmentId,
        },
        { tx }
      )
    );
    if (!preDedup.ok) {
      return NextResponse.json({
        success: true,
        imported: false,
        skipped: "duplicate",
        reason: preDedup.reason,
      });
    }

    const { connectionId, accessToken } = await getGmailAccessTokenForBusiness({
      businessId: user.businessId,
      connectionId: requestedConnectionId,
    });

    const { bytes, sizeBytes } = await fetchGmailAttachmentBytes({
      accessToken,
      messageId: body.messageId,
      attachmentId: body.attachmentId,
    });

    const effectiveSize = bytes.length || sizeBytes || 0;
    if (effectiveSize > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        {
          error: "הקובץ גדול מדי (עד 15MB)",
          limitBytes: MAX_ATTACHMENT_BYTES,
          sizeBytes: effectiveSize,
        },
        { status: 413 }
      );
    }

    if (bytes.length === 0) {
      return NextResponse.json({ error: "הקובץ המצורף ריק" }, { status: 400 });
    }

    // Now the bytes decide. Nothing below this line runs for a file whose
    // container contradicts its declared type: no storage write, no OCR call,
    // no Document. Same validator as the upload screen and the import centre.
    const signature = verifyFileSignature(Buffer.from(bytes), body.mimeType);
    if (!signature.ok) {
      return NextResponse.json(
        { error: signatureRejectionMessage(signature.reason) },
        { status: 415 }
      );
    }

    const contentHashSha256 = sha256Hex(bytes);

    // Dedup by hash AFTER hashing bytes.
    const hashDedup = await withTenantTransaction((tx) =>
      checkEmailImportDedup(
        {
          businessId: user.businessId,
          provider: "gmail",
          messageId: body.messageId,
          attachmentId: body.attachmentId,
          contentHashSha256,
        },
        { tx }
      )
    );
    if (!hashDedup.ok) {
      return NextResponse.json({
        success: true,
        imported: false,
        skipped: "duplicate",
        reason: hashDedup.reason,
      });
    }

    const tmp = await writeTempOcrFile({
      bytes,
      mimeType: body.mimeType,
      filenameHint: body.filename,
    });
    cleanup = tmp.cleanup;

    // OCR is best-effort: a valid downloaded file must never be lost because
    // OCR failed or returned empty text. On failure we still store the file and
    // create a needs_review Document (without ExtractedData) for manual handling.
    let rawText = "";
    try {
      rawText = (await runGoogleVisionOCR(tmp.tempPath, body.mimeType)).trim();
    } catch (ocrError) {
      console.error("GMAIL_IMPORT_OCR_FAILED:", ocrError);
      rawText = "";
    }
    const ocrSucceeded = rawText.length > 0;

    // Same storage contract as POST /api/documents/upload: basename only on
    // Document.fileUrl, bytes via StorageService (legacy FS read fallback).
    // Stored unconditionally — OCR outcome does not gate it. A real storage
    // failure is still fatal (no stored file = no valid Document).
    storedFileName = buildStoredDocumentFileName(body.mimeType);
    await putDocumentObject({
      businessId: user.businessId,
      basename: storedFileName,
      body: Buffer.from(bytes),
      contentType: body.mimeType,
      source: "email",
    });

    // ---- Document + import identity, in ONE transaction --------------------
    //
    // These used to commit separately, and the gap between them was reachable:
    // a crash after the Document left a document that no retry could recognise,
    // because a retry looks for the EmailAttachmentImport row and there wasn't
    // one — so it imported the same attachment again. The concurrent version was
    // worse: both requests created a Document, one lost the unique constraint on
    // the import row, and its Document survived unlinked while the caller was
    // told "duplicate, skipped".
    //
    // The import row is now written INSIDE the transaction that creates the
    // Document, through the materializer's hook. Committed together or not at
    // all, so "Document exists, import identity absent" is not a state the
    // database can hold — which is the same principle the import ledger uses.
    //
    // The OCR-empty case goes through the SAME materializer with `ocrText: null`
    // rather than a hand-rolled `document.create` beside it. One creator, one
    // set of guarantees; a bare Document keeps exactly its previous meaning of
    // "the file is real, nothing could be read from it".
    let importRowWritten = false;
    let created: Awaited<ReturnType<typeof createDocumentFromOcrText>>;
    // Assigned by the hook below, which the materializer awaits inside the
    // transaction it commits — so by the time that resolves, this is set.
    let emailImportId = 0;

    try {
      created = await createDocumentFromOcrText({
        businessId: user.businessId,
        source: "email",
        mimeType: body.mimeType,
        ocrText: ocrSucceeded ? rawText : null,
        fileUrl: storedFileName,
        contentHashSha256,
        originalFilename: body.filename,
        sizeBytes: effectiveSize || null,
        withinTransaction: async (tx, documentId) => {
          const row = await tx.emailAttachmentImport.create({
            data: {
              businessId: user.businessId,
              connectionId,
              provider: "gmail",
              messageId: body.messageId,
              attachmentId: body.attachmentId,
              filename: body.filename,
              mimeType: body.mimeType,
              sizeBytes: body.sizeBytes,
              fromEmail: body.fromEmail,
              subject: body.subject,
              sentAt: body.sentAt ? new Date(body.sentAt) : null,
              contentHashSha256,
              status: "imported",
              documentId,
            },
          });
          emailImportId = row.id;
          importRowWritten = true;
        },
      });
    } catch (raceErr) {
      // The dedup pre-checks are advisory; the DB uniques are the guarantee.
      // A violation here means another request already owns this attachment
      // identity — and because the write was inside the transaction, the
      // Document it would have belonged to has already rolled back.
      if (
        raceErr instanceof Prisma.PrismaClientKnownRequestError &&
        raceErr.code === "P2002" &&
        !importRowWritten
      ) {
        // Nothing points at the object this request stored, so remove it here
        // rather than leaving the loser's upload behind.
        await deleteDocumentObjectQuiet(user.businessId, storedFileName).catch(
          () => {}
        );
        storedFileName = null;
        return NextResponse.json({
          success: true,
          imported: false,
          skipped: "duplicate",
          reason: "concurrent_duplicate",
        });
      }
      throw raceErr;
    }

    const documentId = created.documentId;
    const extractedDataId = created.extractedDataId;
    const analysis = created.analysis;
    // Set only now: before this point a failure must still delete the object.
    permanentFilePersisted = true;

    return NextResponse.json({
      success: true,
      imported: true,
      ocr: ocrSucceeded ? "ok" : "empty",
      needsManualReview: !ocrSucceeded,
      messageId: body.messageId,
      attachmentId: body.attachmentId,
      contentHashSha256,
      documentId,
      extractedDataId,
      emailAttachmentImportId: emailImportId,
      analysis,
    });
  } catch (error) {
    if (storedFileName && businessId && !permanentFilePersisted) {
      try {
        await deleteDocumentObjectQuiet(businessId, storedFileName);
      } catch {
        // ignore cleanup errors
      }
    }
    if (error instanceof GmailReauthRequiredError) {
      console.warn("GMAIL_IMPORT_REAUTH_REQUIRED:", error.reason);
      return NextResponse.json(
        {
          error: "החיבור ל-Gmail פג. יש לחבר מחדש כדי להמשיך.",
          needsReconnect: true,
        },
        { status: 409 }
      );
    }
    console.error("GMAIL_IMPORT_ERROR:", error);
    return NextResponse.json(
      { error: "שגיאה בייבוא המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  } finally {
    if (cleanup) {
      try {
        await cleanup();
      } catch {
        // ignore
      }
    }
  }
}

