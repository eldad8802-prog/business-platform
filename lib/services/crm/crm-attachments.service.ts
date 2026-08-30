/**
 * Canonical CRM Attachments service. User-uploaded files attached to any CRM
 * subject (Customer now, Supplier later), tenant-scoped and uploader-owned.
 * Hard delete. Bytes live in object storage (domain "crm", private); this table
 * holds metadata only. Never merged with the financial `Document` model.
 */

import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";
import {
  parseCrmSubjectType,
  resolveCrmSubject,
  type CrmSubjectType,
} from "@/lib/services/crm/crm-subject.resolver";
import {
  buildAttachmentStorageKey,
  deleteAttachmentObject,
  putAttachmentObject,
  readAttachmentObject,
  validateAttachmentUpload,
} from "@/lib/services/crm/crm-attachment-storage";

/** Cap for the un-paginated v1 list. Documented in the API contract. */
export const ATTACHMENTS_LIST_LIMIT = 100;

export type CrmAttachmentDTO = {
  id: number;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploader: { id: number | null; name: string | null };
  canDelete: boolean;
};

type AttachmentRow = {
  id: number;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  uploadedByUserId: number | null;
  uploadedByUser: { id: number; name: string | null } | null;
};

const ATTACHMENT_SELECT = {
  id: true,
  storageKey: true,
  originalFileName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
  uploadedByUserId: true,
  uploadedByUser: { select: { id: true, name: true } },
} as const;

/** Deletable only by its uploader; a cleared uploader (null) is read-only. */
function canModify(row: { uploadedByUserId: number | null }, actingUserId: number): boolean {
  return row.uploadedByUserId !== null && row.uploadedByUserId === actingUserId;
}

function toDTO(row: AttachmentRow, actingUserId: number): CrmAttachmentDTO {
  return {
    id: row.id,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    uploader: { id: row.uploadedByUser?.id ?? null, name: row.uploadedByUser?.name ?? null },
    canDelete: canModify(row, actingUserId),
  };
}

function normalizeAttachmentId(value: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError("Invalid attachment id");
  }
  return n;
}

/** Bind to the tenant transaction when provided (D2/P7 Wave 1 RLS backstop). */
type TxOptions = { tx?: TenantTx };

async function loadOwnedAttachment(
  db: TenantTx | typeof prisma,
  businessId: number,
  attachmentId: number
): Promise<AttachmentRow> {
  const row = await db.crmAttachment.findFirst({
    where: { id: attachmentId, businessId },
    select: ATTACHMENT_SELECT,
  });
  if (!row) {
    throw new NotFoundError("Attachment not found");
  }
  return row as AttachmentRow;
}

export type ListAttachmentsInput = {
  businessId: number;
  subjectType: CrmSubjectType | string;
  subjectId: number;
  actingUserId: number;
};

export type UploadAttachmentInput = {
  businessId: number;
  subjectType: CrmSubjectType | string;
  subjectId: number;
  uploadedByUserId: number;
  buffer: Buffer;
  originalFileName: string;
  mimeType: string;
};

export const crmAttachmentsService = {
  /** Newest-first, capped. Subject validated + tenant-scoped. */
  async listAttachments(
    input: ListAttachmentsInput,
    options?: TxOptions
  ): Promise<CrmAttachmentDTO[]> {
    const db = options?.tx ?? prisma;
    // resolveCrmSubject parses the raw value into the enum (and rejects it
    // if it is not one) — query with what it returned, never with the raw
    // input, or a caller-supplied casing reaches Prisma unvalidated.
    const subject = await resolveCrmSubject(
      {
        businessId: input.businessId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
      options
    );
    const rows = await db.crmAttachment.findMany({
      where: {
        businessId: input.businessId,
        subjectType: subject.subjectType,
        subjectId: input.subjectId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ATTACHMENTS_LIST_LIMIT,
      select: ATTACHMENT_SELECT,
    });
    return rows.map((r) => toDTO(r as AttachmentRow, input.actingUserId));
  },

  async countAttachments(
    input: {
      businessId: number;
      subjectType: CrmSubjectType | string;
      subjectId: number;
    },
    options?: TxOptions
  ): Promise<number> {
    const db = options?.tx ?? prisma;
    // Count takes no resolver pass (it is a read-model helper, deliberately
    // not a subject-existence check), so it must parse the value itself —
    // otherwise an unvalidated string reaches Prisma as an enum.
    const subjectType = parseCrmSubjectType(input.subjectType);
    if (!subjectType) throw new ValidationError("Unsupported subjectType");
    return db.crmAttachment.count({
      where: {
        businessId: input.businessId,
        subjectType,
        subjectId: input.subjectId,
      },
    });
  },

  /**
   * Upload flow (order matters):
   *   subject → MIME → size → filename → server key → write object → DB row.
   * If the DB write fails after the object landed, the orphan object is deleted
   * (best-effort, logged) and the failure is surfaced — never a false success.
   */
  async uploadAttachment(
    input: UploadAttachmentInput,
    options?: TxOptions
  ): Promise<CrmAttachmentDTO> {
    const db = options?.tx ?? prisma;
    const subject = await resolveCrmSubject(
      {
        businessId: input.businessId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
      options
    );

    const sizeBytes = input.buffer.length;
    const validated = validateAttachmentUpload({
      mimeType: input.mimeType,
      originalFileName: input.originalFileName,
      sizeBytes,
    });

    const key = buildAttachmentStorageKey({
      businessId: input.businessId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      storageExt: validated.storageExt,
    });

    // 1. Write the object first.
    await putAttachmentObject({
      businessId: input.businessId,
      key,
      body: input.buffer,
      contentType: validated.mimeType,
    });

    // 2. Create the metadata row; compensate on failure.
    let row: AttachmentRow;
    try {
      row = (await db.crmAttachment.create({
        data: {
          businessId: input.businessId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          storageKey: key,
          originalFileName: validated.displayFileName,
          mimeType: validated.mimeType,
          sizeBytes,
          uploadedByUserId: input.uploadedByUserId,
        },
        select: ATTACHMENT_SELECT,
      })) as AttachmentRow;
    } catch (dbError) {
      try {
        await deleteAttachmentObject(key);
      } catch (cleanupError) {
        console.error("[crm-attachment] orphan object cleanup failed", { key, cleanupError });
      }
      throw dbError;
    }

    return toDTO(row, input.uploadedByUserId);
  },

  /** Load bytes for the authenticated download route. Tenant-scoped. */
  async getAttachmentForDownload(
    input: { businessId: number; attachmentId: number },
    options?: TxOptions
  ): Promise<{
    body: Buffer;
    contentType: string;
    displayFileName: string;
  }> {
    const db = options?.tx ?? prisma;
    const attachmentId = normalizeAttachmentId(input.attachmentId);
    const row = await loadOwnedAttachment(db, input.businessId, attachmentId);
    try {
      const { body, contentType } = await readAttachmentObject(row.storageKey);
      return { body, contentType: row.mimeType || contentType, displayFileName: row.originalFileName };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        throw new NotFoundError("Attachment file not found");
      }
      throw error;
    }
  },

  /**
   * Hard delete (uploader-only). Order:
   *   1. tenant + permission checks.
   *   2. delete the object (idempotent — a missing object is fine).
   *   3. a REAL storage failure keeps the metadata and surfaces an error.
   *   4. delete the metadata row.
   *   5. a metadata-delete failure after the object is gone surfaces a
   *      reconciliation error — never a false success.
   */
  async deleteAttachment(
    input: {
      businessId: number;
      attachmentId: number;
      actingUserId: number;
    },
    options?: TxOptions
  ): Promise<{ id: number }> {
    const db = options?.tx ?? prisma;
    const attachmentId = normalizeAttachmentId(input.attachmentId);
    const row = await loadOwnedAttachment(db, input.businessId, attachmentId);
    if (!canModify(row, input.actingUserId)) {
      throw new ForbiddenError("Only the uploader can delete this file");
    }

    // deleteObject is idempotent on both adapters (missing key does not throw);
    // a thrown error here is a real storage failure → keep the metadata.
    try {
      await deleteAttachmentObject(row.storageKey);
    } catch (storageError) {
      console.error("[crm-attachment] storage delete failed; metadata kept", {
        attachmentId,
        storageError,
      });
      throw new AppError("מחיקת הקובץ מהאחסון נכשלה. נסו שוב.", 502);
    }

    try {
      await db.crmAttachment.delete({ where: { id: attachmentId } });
    } catch (dbError) {
      console.error(
        "[crm-attachment] object deleted but metadata delete failed — reconciliation needed",
        { attachmentId, storageKey: row.storageKey, dbError }
      );
      throw new AppError(
        "הקובץ נמחק מהאחסון אך רישום הקובץ לא הוסר. נדרש תיאום ידני.",
        500
      );
    }

    return { id: attachmentId };
  },
};
