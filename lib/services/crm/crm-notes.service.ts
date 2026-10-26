/**
 * Canonical CRM Notes service. Threaded notes on any CRM subject (Customer /
 * Supplier), tenant-scoped and author-owned. Hard delete (no soft-delete /
 * tombstones / append-only — CRM notes are not accounting records).
 *
 * The scalar Customer.notes / Supplier.notes "general note" is a separate field
 * and is never touched here.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  parseCrmSubjectType,
  resolveCrmSubject,
  type CrmSubjectType,
} from "@/lib/services/crm/crm-subject.resolver";

export const NOTE_BODY_MAX = 5000;
/** Cap for the un-paginated v1 list. Documented in the API contract. */
export const NOTES_LIST_LIMIT = 100;

export type CrmNoteAuthor = {
  id: number | null;
  name: string | null;
};

export type CrmNoteDTO = {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: CrmNoteAuthor;
  canEdit: boolean;
  canDelete: boolean;
};

type NoteRow = {
  id: number;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: number | null;
  createdByUser: { id: number; name: string | null } | null;
};

const NOTE_SELECT = {
  id: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  createdByUserId: true,
  createdByUser: { select: { id: true, name: true } },
} as const;

/**
 * A note is modifiable only by its author. If the author was cleared
 * (createdByUserId === null after a user deletion) the note is read-only until a
 * management policy / RBAC exists — never editable by an arbitrary user.
 */
function canModify(row: { createdByUserId: number | null }, actingUserId: number): boolean {
  return row.createdByUserId !== null && row.createdByUserId === actingUserId;
}

function toDTO(row: NoteRow, actingUserId: number): CrmNoteDTO {
  const mutable = canModify(row, actingUserId);
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    author: { id: row.createdByUser?.id ?? null, name: row.createdByUser?.name ?? null },
    canEdit: mutable,
    canDelete: mutable,
  };
}

function normalizeBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("body is required");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError("body must not be empty");
  }
  if (trimmed.length > NOTE_BODY_MAX) {
    throw new ValidationError(`body must be at most ${NOTE_BODY_MAX} characters`);
  }
  return trimmed;
}

export type ListNotesInput = {
  businessId: number;
  subjectType: CrmSubjectType | string;
  subjectId: number;
  actingUserId: number;
};

export type CreateNoteInput = {
  businessId: number;
  subjectType: CrmSubjectType | string;
  subjectId: number;
  body: string;
  createdByUserId: number;
};

export type UpdateNoteInput = {
  businessId: number;
  noteId: number;
  actingUserId: number;
  body: string;
};

export type DeleteNoteInput = {
  businessId: number;
  noteId: number;
  actingUserId: number;
};

function normalizeNoteId(value: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError("Invalid note id");
  }
  return n;
}

/** Bind to the tenant transaction when provided (D2/P7 Wave 1 RLS backstop). */
type TxOptions = { tx?: TenantTx };

async function loadOwnedNote(
  db: TenantTx | typeof prisma,
  businessId: number,
  noteId: number
): Promise<NoteRow> {
  const row = await db.crmNote.findFirst({
    where: { id: noteId, businessId },
    select: NOTE_SELECT,
  });
  if (!row) {
    throw new NotFoundError("Note not found");
  }
  return row as NoteRow;
}

export const crmNotesService = {
  /** Newest-first, capped at NOTES_LIST_LIMIT. Subject is validated + tenant-scoped. */
  async listNotes(
    input: ListNotesInput,
    options?: TxOptions
  ): Promise<CrmNoteDTO[]> {
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

    const rows = await db.crmNote.findMany({
      where: {
        businessId: input.businessId,
        subjectType: subject.subjectType,
        subjectId: input.subjectId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: NOTES_LIST_LIMIT,
      select: NOTE_SELECT,
    });

    return rows.map((r) => toDTO(r as NoteRow, input.actingUserId));
  },

  /**
   * One page of the thread (newest first) plus whether older notes exist and how
   * many there are in all. `before` is the id of the last note the caller shows;
   * the page continues strictly after it in the (createdAt desc, id desc) order,
   * so a note added meanwhile at the top neither repeats nor shifts a row. The
   * cursor is read inside this business AND this subject: a foreign id yields an
   * empty page, never another thread's notes.
   */
  async listNotesPage(
    input: ListNotesInput & { before?: number | null },
    // The tenant transaction is required: this read never falls back to the bare client.
    options: { tx: TenantTx }
  ): Promise<{ notes: CrmNoteDTO[]; hasMore: boolean; total: number }> {
    const db = options.tx;
    const subject = await resolveCrmSubject(
      {
        businessId: input.businessId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
      options
    );
    const scope = {
      businessId: input.businessId,
      subjectType: subject.subjectType,
      subjectId: input.subjectId,
    };

    let after: Prisma.CrmNoteWhereInput = {};
    if (input.before != null) {
      const cursor = await db.crmNote.findFirst({
        where: { ...scope, id: input.before },
        select: { id: true, createdAt: true },
      });
      if (!cursor) return { notes: [], hasMore: false, total: await db.crmNote.count({ where: scope }) };
      after = {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      db.crmNote.findMany({
        where: { ...scope, ...after },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: NOTES_LIST_LIMIT + 1,
        select: NOTE_SELECT,
      }),
      db.crmNote.count({ where: scope }),
    ]);
    const hasMore = rows.length > NOTES_LIST_LIMIT;
    return {
      notes: rows.slice(0, NOTES_LIST_LIMIT).map((r) => toDTO(r as NoteRow, input.actingUserId)),
      hasMore,
      total,
    };
  },

  /** Count only — for the Customer Card read-model (no list, no N+1). */
  async countNotes(
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
    return db.crmNote.count({
      where: {
        businessId: input.businessId,
        subjectType,
        subjectId: input.subjectId,
      },
    });
  },

  async createNote(
    input: CreateNoteInput,
    options?: TxOptions
  ): Promise<CrmNoteDTO> {
    const db = options?.tx ?? prisma;
    const subject = await resolveCrmSubject(
      {
        businessId: input.businessId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
      options
    );
    const body = normalizeBody(input.body);

    const row = await db.crmNote.create({
      data: {
        businessId: input.businessId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        body,
        createdByUserId: input.createdByUserId,
      },
      select: NOTE_SELECT,
    });
    // The creator is the acting user, so canEdit/canDelete are true.
    return toDTO(row as NoteRow, input.createdByUserId);
  },

  /** Author-only. Only the body changes — never subject/business/author. */
  async updateNote(
    input: UpdateNoteInput,
    options?: TxOptions
  ): Promise<CrmNoteDTO> {
    const db = options?.tx ?? prisma;
    const noteId = normalizeNoteId(input.noteId);
    const existing = await loadOwnedNote(db, input.businessId, noteId);
    if (!canModify(existing, input.actingUserId)) {
      throw new ForbiddenError("Only the note author can edit this note");
    }
    const body = normalizeBody(input.body);

    const row = await db.crmNote.update({
      where: { id: noteId },
      data: { body },
      select: NOTE_SELECT,
    });
    return toDTO(row as NoteRow, input.actingUserId);
  },

  /** Author-only hard delete. */
  async deleteNote(
    input: DeleteNoteInput,
    options?: TxOptions
  ): Promise<{ id: number }> {
    const db = options?.tx ?? prisma;
    const noteId = normalizeNoteId(input.noteId);
    const existing = await loadOwnedNote(db, input.businessId, noteId);
    if (!canModify(existing, input.actingUserId)) {
      throw new ForbiddenError("Only the note author can delete this note");
    }
    await db.crmNote.delete({ where: { id: noteId } });
    return { id: noteId };
  },
};
