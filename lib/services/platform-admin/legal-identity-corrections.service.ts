/**
 * Legal identity corrections — the admin READ side (owner decision 2026-11-13): the list and one request, for a
 * platform admin holding the dedicated approver permission (the routes check it before calling here).
 *
 * Reads go through the platform-admin read plane (`app_admin`, SELECT-only; the correction migration adds the
 * additive `p7adm_read` policies and grants on both tables). Nothing here writes; deciding runs in the business's
 * own tenant transaction (lib/services/account/legal-identity-correction-admin.service.ts).
 *
 * Minimum exposure:
 *   - the LIST shows a masked number (last 3 digits) and a shortened legal name — enough to triage;
 *   - the DETAIL shows the full values, because the approver must compare them to the documents; every detail read
 *     is audited by the route (PLATFORM_LEGAL_IDENTITY_CORRECTION_VIEWED);
 *   - the number's check is a local FORMAT check — it is never presented as verified with any authority.
 *
 * Tagged queries only (no string-built SQL). Column names follow migration 20261128100000.
 */

import type { PrismaClient } from "@prisma/client";

import { getPrismaAdmin } from "@/lib/prisma-admin";

export type CorrectionAdminStatus = "PENDING" | "APPLIED" | "REJECTED" | "CANCELLED" | "STALE";

export type CorrectionListItem = {
  id: number;
  businessId: number;
  businessName: string;
  kind: string;
  status: CorrectionAdminStatus;
  infoRequested: boolean;
  attachmentCount: number;
  currentLegalNameShort: string | null;
  requestedLegalNameShort: string | null;
  currentTaxIdMasked: string | null;
  requestedTaxIdMasked: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type CorrectionAttachmentMeta = {
  id: number;
  mimeType: string;
  sizeBytes: number;
  sha256: string | null;
  createdAt: string;
};

export type CorrectionDetail = {
  id: number;
  businessId: number;
  businessName: string;
  kind: string;
  status: CorrectionAdminStatus;
  current: { businessKind: string; legalName: string | null; taxId: string | null };
  requested: { businessKind: string; legalName: string | null; taxId: string | null };
  reason: string | null;
  sameLegalEntity: boolean;
  verification: { method: string; at: string };
  requester: { userId: number; name: string | null; email: string | null; emailVerified: boolean } | null;
  publicNote: string | null;
  internalNote: string | null;
  infoRequestedAt: string | null;
  infoRequestNote: string | null;
  decidedByUserId: number | null;
  decidedAt: string | null;
  createdAt: string;
  anonymised: boolean;
  attachments: CorrectionAttachmentMeta[];
};

/** "512345678" → "••••••678". Null stays null; anything shorter than 4 characters is fully masked. */
export function maskTaxId(value: string | null): string | null {
  if (value === null) return null;
  const v = value.trim();
  if (v.length < 4) return "•".repeat(v.length);
  return "•".repeat(v.length - 3) + v.slice(-3);
}

/** A legal name shortened for the list: first 12 characters and an ellipsis. */
export function shortenName(value: string | null, max = 12): string | null {
  if (value === null) return null;
  const v = value.trim();
  return v.length <= max ? v : `${v.slice(0, max)}…`;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type ListRow = {
  id: number;
  businessId: number;
  businessName: string;
  kind: string;
  status: CorrectionAdminStatus;
  infoRequestedAt: Date | null;
  attachmentCount: bigint | number;
  currentLegalName: string | null;
  requestedLegalName: string | null;
  currentTaxId: string | null;
  requestedTaxId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
};

export type CorrectionListFilter = "OPEN" | "ALL";

/** Newest first. OPEN = PENDING only (what needs a decision). At most 200 rows. */
export async function listCorrectionsForAdmin(
  filter: CorrectionListFilter = "OPEN",
  db: Pick<PrismaClient, "$queryRaw"> = getPrismaAdmin()
): Promise<CorrectionListItem[]> {
  const onlyOpen = filter === "OPEN";
  const rows = await db.$queryRaw<ListRow[]>`
    SELECT r."id", r."businessId", b."name" AS "businessName", r."kind", r."status", r."infoRequestedAt",
           (SELECT count(*) FROM "LegalIdentityCorrectionAttachment" a WHERE a."requestId" = r."id") AS "attachmentCount",
           r."currentLegalName", r."requestedLegalName", r."currentTaxId", r."requestedTaxId", r."createdAt", r."decidedAt"
      FROM "LegalIdentityCorrectionRequest" r
      JOIN "Business" b ON b."id" = r."businessId"
     WHERE (${onlyOpen} = false OR r."status" = 'PENDING')
     ORDER BY r."createdAt" DESC
     LIMIT 200`;
  return rows.map((r) => ({
    id: Number(r.id),
    businessId: Number(r.businessId),
    businessName: r.businessName,
    kind: r.kind,
    status: r.status,
    infoRequested: r.infoRequestedAt !== null,
    attachmentCount: Number(r.attachmentCount),
    currentLegalNameShort: shortenName(r.currentLegalName),
    requestedLegalNameShort: shortenName(r.requestedLegalName),
    currentTaxIdMasked: maskTaxId(r.currentTaxId),
    requestedTaxIdMasked: maskTaxId(r.requestedTaxId),
    createdAt: r.createdAt.toISOString(),
    decidedAt: iso(r.decidedAt),
  }));
}

type DetailRow = {
  id: number;
  businessId: number;
  businessName: string;
  kind: string;
  status: CorrectionAdminStatus;
  currentBusinessKind: string;
  currentLegalName: string | null;
  currentTaxId: string | null;
  requestedBusinessKind: string;
  requestedLegalName: string | null;
  requestedTaxId: string | null;
  reason: string | null;
  sameLegalEntity: boolean;
  verificationMethod: string;
  verifiedAt: Date;
  requestedByUserId: number;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterEmailVerifiedAt: Date | null;
  requesterInBusiness: boolean | null;
  publicNote: string | null;
  internalNote: string | null;
  infoRequestedAt: Date | null;
  infoRequestNote: string | null;
  decidedByUserId: number | null;
  decidedAt: Date | null;
  createdAt: Date;
  anonymisedAt: Date | null;
};

type AttachmentRow = { id: number; mimeType: string; sizeBytes: number; sha256: string | null; createdAt: Date };

/** One request with everything the approver must compare. null when it does not exist. */
export async function getCorrectionForAdmin(
  id: number,
  db: Pick<PrismaClient, "$queryRaw"> = getPrismaAdmin()
): Promise<CorrectionDetail | null> {
  const rows = await db.$queryRaw<DetailRow[]>`
    SELECT r."id", r."businessId", b."name" AS "businessName", r."kind", r."status",
           r."currentBusinessKind", r."currentLegalName", r."currentTaxId",
           r."requestedBusinessKind", r."requestedLegalName", r."requestedTaxId",
           r."reason", r."sameLegalEntity", r."verificationMethod", r."verifiedAt",
           r."requestedByUserId", u."name" AS "requesterName", u."email" AS "requesterEmail",
           u."emailVerifiedAt" AS "requesterEmailVerifiedAt", (u."businessId" = r."businessId") AS "requesterInBusiness",
           r."publicNote", r."internalNote", r."infoRequestedAt", r."infoRequestNote",
           r."decidedByUserId", r."decidedAt", r."createdAt", r."anonymisedAt"
      FROM "LegalIdentityCorrectionRequest" r
      JOIN "Business" b ON b."id" = r."businessId"
      LEFT JOIN "User" u ON u."id" = r."requestedByUserId"
     WHERE r."id" = ${id}`;
  const r = rows[0];
  if (!r) return null;
  const attachments = await db.$queryRaw<AttachmentRow[]>`
    SELECT a."id", a."mimeType", a."sizeBytes", a."sha256", a."createdAt"
      FROM "LegalIdentityCorrectionAttachment" a
     WHERE a."requestId" = ${id} AND a."anonymisedAt" IS NULL
     ORDER BY a."createdAt" ASC`;
  return {
    id: Number(r.id),
    businessId: Number(r.businessId),
    businessName: r.businessName,
    kind: r.kind,
    status: r.status,
    current: { businessKind: r.currentBusinessKind, legalName: r.currentLegalName, taxId: r.currentTaxId },
    requested: { businessKind: r.requestedBusinessKind, legalName: r.requestedLegalName, taxId: r.requestedTaxId },
    reason: r.reason,
    sameLegalEntity: r.sameLegalEntity,
    verification: { method: r.verificationMethod, at: r.verifiedAt.toISOString() },
    // The requester as the business knows them — only while they still belong to that business.
    requester:
      r.requesterInBusiness === true
        ? {
            userId: Number(r.requestedByUserId),
            name: r.requesterName,
            email: r.requesterEmail,
            emailVerified: r.requesterEmailVerifiedAt !== null,
          }
        : null,
    publicNote: r.publicNote,
    internalNote: r.internalNote,
    infoRequestedAt: iso(r.infoRequestedAt),
    infoRequestNote: r.infoRequestNote,
    decidedByUserId: r.decidedByUserId === null ? null : Number(r.decidedByUserId),
    decidedAt: iso(r.decidedAt),
    createdAt: r.createdAt.toISOString(),
    anonymised: r.anonymisedAt !== null,
    attachments: attachments.map((a) => ({
      id: Number(a.id),
      mimeType: a.mimeType,
      sizeBytes: Number(a.sizeBytes),
      sha256: a.sha256,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

type AttachmentKeyRow = { id: number; businessId: number; storageKey: string | null; mimeType: string };

/** The storage key of one attachment of one request (admin read plane). null when not found or anonymised. */
export async function getCorrectionAttachmentForAdmin(
  requestId: number,
  attachmentId: number,
  db: Pick<PrismaClient, "$queryRaw"> = getPrismaAdmin()
): Promise<{ businessId: number; storageKey: string; mimeType: string } | null> {
  const rows = await db.$queryRaw<AttachmentKeyRow[]>`
    SELECT a."id", a."businessId", a."storageKey", a."mimeType"
      FROM "LegalIdentityCorrectionAttachment" a
     WHERE a."id" = ${attachmentId} AND a."requestId" = ${requestId} AND a."anonymisedAt" IS NULL`;
  const a = rows[0];
  if (!a || !a.storageKey) return null;
  return { businessId: Number(a.businessId), storageKey: a.storageKey, mimeType: a.mimeType };
}
