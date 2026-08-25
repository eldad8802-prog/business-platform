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
  buildStoredDocumentFileName,
  deleteDocumentObjectQuiet,
  putDocumentObject,
} from "@/lib/services/documents/document-storage.service";

export const runtime = "nodejs";

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB (MVP)

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

function isAllowedMime(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "application/pdf" || m.startsWith("image/");
}

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

    if (!body.mimeType || !isAllowedMime(body.mimeType)) {
      return NextResponse.json(
        { error: "סוג קובץ לא נתמך (נדרש PDF או תמונה)" },
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

    let documentId: number;
    let extractedDataId: number | null = null;
    let analysis:
      | {
          documentType: string;
          isFinancial: boolean;
          guardrailRoute: string;
          needsReview: boolean;
          direction: string;
          confidence: number;
        }
      | null = null;

    if (ocrSucceeded) {
      const created = await createDocumentFromOcrText({
        businessId: user.businessId,
        source: "email",
        mimeType: body.mimeType,
        ocrText: rawText,
        fileUrl: storedFileName,
        contentHashSha256,
        originalFilename: body.filename,
        sizeBytes: effectiveSize || null,
      });
      documentId = created.documentId;
      extractedDataId = created.extractedDataId;
      analysis = created.analysis;
    } else {
      // No OCR text → create a bare Document (no ExtractedData). It surfaces in
      // the Review Station as needs_review with empty fields for manual entry.
      const bareDocument = await prisma.document.create({
        data: {
          businessId: user.businessId,
          fileUrl: storedFileName,
          source: "email",
          mimeType: body.mimeType,
          status: "needs_review",
          ocrText: null,
          contentHashSha256,
          originalFilename: body.filename?.trim().slice(0, 255) || null,
          sizeBytes: effectiveSize || null,
        },
      });
      documentId = bareDocument.id;
    }
    permanentFilePersisted = true;

    // Final import record on a tenant transaction; a concurrent duplicate
    // (dedup pre-checks are advisory — the DB uniques are the guarantee)
    // resolves as a duplicate-skip instead of a 500.
    let emailImport;
    try {
      emailImport = await withTenantTransaction((tx) =>
        tx.emailAttachmentImport.create({
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
        })
      );
    } catch (raceErr) {
      if (
        raceErr instanceof Prisma.PrismaClientKnownRequestError &&
        raceErr.code === "P2002"
      ) {
        return NextResponse.json({
          success: true,
          imported: false,
          skipped: "duplicate",
          reason: "concurrent_duplicate",
        });
      }
      throw raceErr;
    }

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
      emailAttachmentImportId: emailImport.id,
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

