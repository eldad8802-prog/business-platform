/**
 * Canonical CRM subject resolver — the single place that validates a
 * (businessId, subjectType, subjectId) reference for every generic CRM engine
 * (Notes now; Attachments/Contacts later). Existence + tenant ownership are
 * enforced here, never scattered per-service.
 *
 * Polymorphic by design: CrmNote/CrmAttachment reference a subject by
 * (subjectType, subjectId) with NO FK to Customer/Supplier — so one engine
 * serves both. This resolver is what keeps that reference honest.
 *
 * Does NOT use Party / PartyResolutionClaim (that is identity-resolution, a
 * different concern).
 */

import { prisma } from "@/lib/prisma";
import type { TenantTx } from "@/lib/tenant/transaction";
import { NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

export const CRM_SUBJECT_TYPES = ["CUSTOMER", "SUPPLIER"] as const;
export type CrmSubjectType = (typeof CRM_SUBJECT_TYPES)[number];

export function parseCrmSubjectType(raw: unknown): CrmSubjectType | null {
  if (typeof raw !== "string") return null;
  const up = raw.toUpperCase();
  return (CRM_SUBJECT_TYPES as readonly string[]).includes(up)
    ? (up as CrmSubjectType)
    : null;
}

export type ResolveCrmSubjectInput = {
  businessId: number;
  subjectType: CrmSubjectType | string;
  subjectId: number;
};

export type ResolvedCrmSubject = {
  businessId: number;
  subjectType: CrmSubjectType;
  subjectId: number;
  /** Minimal safe descriptor — the subject's display name. */
  displayName: string;
};

function assertBusinessId(businessId: number): void {
  if (!businessId || Number.isNaN(businessId)) {
    throw new UnauthorizedError("Invalid business id");
  }
}

function normalizeSubjectId(value: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError("Invalid subjectId");
  }
  return n;
}

/**
 * Validates and resolves a CRM subject. Throws:
 *  - ValidationError for an unsupported subjectType or invalid subjectId.
 *  - NotFoundError if the subject does not exist OR belongs to another business
 *    (identical response — no cross-tenant information leak).
 */
export async function resolveCrmSubject(
  input: ResolveCrmSubjectInput,
  options?: { tx?: TenantTx }
): Promise<ResolvedCrmSubject> {
  const db = options?.tx ?? prisma;
  assertBusinessId(input.businessId);

  const subjectType = parseCrmSubjectType(input.subjectType);
  if (!subjectType) {
    throw new ValidationError("Unsupported subjectType");
  }
  const subjectId = normalizeSubjectId(input.subjectId);

  let displayName: string | null = null;
  if (subjectType === "CUSTOMER") {
    const c = await db.customer.findFirst({
      where: { id: subjectId, businessId: input.businessId },
      select: { name: true },
    });
    displayName = c?.name ?? null;
  } else {
    const s = await db.supplier.findFirst({
      where: { id: subjectId, businessId: input.businessId },
      select: { name: true },
    });
    displayName = s?.name ?? null;
  }

  if (displayName === null) {
    // Same error whether missing or cross-tenant — deliberately no leak.
    throw new NotFoundError("Subject not found");
  }

  return { businessId: input.businessId, subjectType, subjectId, displayName };
}
