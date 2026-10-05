import { Prisma, type TrustClaimClass, type TrustClaimKind } from "@prisma/client";
import {
  EVIDENCE_RULE_VERSION,
  isVerificationRequired,
  normalizeTrustClaim,
  RECONFIRM_MONTHS,
  servedCustomersBucket,
  TrustClaimInputError,
  wordingHash,
} from "./trust-claim-catalogue";

/**
 * P3-A · Owner-governed trust claims — the only writer of BusinessTrustClaim.
 *
 * Every function takes a tenant transaction and a SERVER-derived businessId / userId. The database is
 * the last line: FORCE RLS pins every row to the tenant, a claim can only be CREATED active and not
 * public, its content columns cannot change, and a retired row is frozen. This service adds the
 * product rules on top:
 *   - confirming always creates an INTERNAL claim; public use is a second, explicit act;
 *   - public use is refused while the claim has any open issue (expired, re-confirmation due, missing
 *     private document, evidence no longer supporting the number);
 *   - changing a claim is a new claim (retire + insert): an approval never carries over;
 *   - SERVED_CUSTOMERS counts only the business's own completed work (p3.evidence.v1) — never Customer
 *     rows and never billing.
 */

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

export class TrustClaimNotFoundError extends Error {
  constructor() {
    super("Trust claim not found");
    this.name = "TrustClaimNotFoundError";
  }
}
export class TrustClaimConflictError extends Error {
  constructor(message = "This claim changed at the same time; try again") {
    super(message);
    this.name = "TrustClaimConflictError";
  }
}

export const TRUST_CLAIM_SELECT = {
  id: true,
  businessId: true,
  claimKind: true,
  claimClass: true,
  scopeKey: true,
  params: true,
  wording: true,
  evidenceRuleId: true,
  evidenceRuleVersion: true,
  evidenceCondition: true,
  confirmedByUserId: true,
  confirmedAt: true,
  verificationMethod: true,
  verificationAttachmentMimeType: true,
  verifiedAt: true,
  validUntil: true,
  publicUseApproved: true,
  publicUseApprovedAt: true,
  status: true,
} as const;
/** Never includes the storage key or the document hash: those stay server-side. */
export type TrustClaimRow = Prisma.BusinessTrustClaimGetPayload<{ select: typeof TRUST_CLAIM_SELECT }>;

// ─── evidence (p3.evidence.v1) ──────────────────────────────────────────────────────────────────

/**
 * Served customers: DISTINCT customers with at least one COMPLETED appointment or a WON lead. Customer
 * rows on their own (every WhatsApp sender becomes one), imports, sales without a customer link and
 * billing documents are deliberately NOT counted. Read inside the tenant transaction.
 */
export async function loadServedCustomers(businessId: number, tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS "n" FROM (
      SELECT "customerId" FROM "Appointment"
       WHERE "businessId" = ${businessId} AND "status" = 'COMPLETED' AND "customerId" IS NOT NULL
      UNION
      SELECT "customerId" FROM "Lead"
       WHERE "businessId" = ${businessId} AND "status" = 'WON' AND "customerId" IS NOT NULL
    ) served`;
  return Number(rows[0]?.n ?? 0);
}

// ─── effective state (pure) ─────────────────────────────────────────────────────────────────────

export type TrustClaimIssue =
  | "EXPIRED"
  | "RECONFIRM_DUE"
  | "NEEDS_DOCUMENT"
  | "EVIDENCE_LAPSED"
  | "EVIDENCE_RULE_CHANGED";

export type TrustClaimView = {
  id: number;
  kind: TrustClaimKind;
  claimClass: TrustClaimClass;
  wording: string;
  params: Record<string, unknown>;
  confirmedAt: string;
  reconfirmBy: string;
  validUntil: string | null;
  verification: { required: boolean; provided: boolean; verifiedAt: string | null; label: "PROVIDED_BY_BUSINESS" | null };
  evidence: { ruleVersion: string; condition: Record<string, unknown> } | null;
  publicUseApproved: boolean;
  /** Open issues; any issue keeps the claim off every public surface. */
  issues: TrustClaimIssue[];
  /** The only flag a public surface may read: approved AND no open issue. */
  publicEffective: boolean;
};

export function evaluateTrustClaim(row: TrustClaimRow, ctx: { now: Date; servedCustomers: number | null }): TrustClaimView {
  const issues: TrustClaimIssue[] = [];
  const reconfirmBy = new Date(row.confirmedAt.getTime() + RECONFIRM_MONTHS * 30.4375 * DAY);
  if (row.validUntil && row.validUntil.getTime() <= ctx.now.getTime()) issues.push("EXPIRED");
  if (reconfirmBy.getTime() <= ctx.now.getTime()) issues.push("RECONFIRM_DUE");
  const required = isVerificationRequired(row.claimKind);
  if (required && !row.verifiedAt) issues.push("NEEDS_DOCUMENT");
  const condition = (row.evidenceCondition ?? null) as { metric?: string; gte?: number } | null;
  if (row.claimClass === "SAFE_FACTUAL") {
    if (row.evidenceRuleVersion !== EVIDENCE_RULE_VERSION) issues.push("EVIDENCE_RULE_CHANGED");
    const gte = Number(condition?.gte);
    if (ctx.servedCustomers === null || !Number.isFinite(gte) || ctx.servedCustomers < gte) issues.push("EVIDENCE_LAPSED");
  }
  return {
    id: row.id,
    kind: row.claimKind,
    claimClass: row.claimClass,
    wording: row.wording,
    params: (row.params ?? {}) as Record<string, unknown>,
    confirmedAt: row.confirmedAt.toISOString(),
    reconfirmBy: reconfirmBy.toISOString(),
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    verification: {
      required,
      provided: !!row.verifiedAt,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      label: required ? "PROVIDED_BY_BUSINESS" : null,
    },
    evidence: row.evidenceRuleVersion ? { ruleVersion: row.evidenceRuleVersion, condition: (condition ?? {}) as Record<string, unknown> } : null,
    publicUseApproved: row.publicUseApproved,
    issues,
    publicEffective: row.publicUseApproved && issues.length === 0,
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────────────────────────

export function listActiveTrustClaims(businessId: number, tx: Tx): Promise<TrustClaimRow[]> {
  return tx.businessTrustClaim.findMany({
    where: { businessId, status: "ACTIVE" },
    select: TRUST_CLAIM_SELECT,
    orderBy: [{ claimKind: "asc" }, { id: "asc" }],
  });
}

function assertActor(businessId: number, userId: number) {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new TrustClaimInputError("Invalid business");
  if (!Number.isInteger(userId) || userId <= 0) throw new TrustClaimInputError("Invalid user");
}

async function activeClaim(businessId: number, claimId: number, tx: Tx): Promise<TrustClaimRow> {
  if (!Number.isInteger(claimId) || claimId <= 0) throw new TrustClaimNotFoundError();
  const row = await tx.businessTrustClaim.findFirst({ where: { id: claimId, businessId, status: "ACTIVE" }, select: TRUST_CLAIM_SELECT });
  if (!row) throw new TrustClaimNotFoundError();
  return row;
}

async function retireRow(businessId: number, userId: number, id: number, tx: Tx) {
  const res = await tx.businessTrustClaim.updateMany({
    where: { id, businessId, status: "ACTIVE" },
    data: { status: "RETIRED", retiredAt: new Date(), retiredByUserId: userId },
  });
  if (res.count !== 1) throw new TrustClaimNotFoundError();
}

// ─── owner actions ──────────────────────────────────────────────────────────────────────────────

/**
 * The owner confirms a claim (new, changed or re-confirmed). Always INTERNAL: a claim is never created
 * public. An ACTIVE claim of the same kind and scope is retired in the same transaction — its approval
 * and its verification document do not carry over to the new wording.
 */
export async function confirmTrustClaim(
  input: { businessId: number; userId: number; kind: unknown; params: unknown },
  tx: Tx,
  now = new Date(),
): Promise<TrustClaimRow> {
  assertActor(input.businessId, input.userId);
  const servedCustomers = input.kind === "SERVED_CUSTOMERS" ? await loadServedCustomers(input.businessId, tx) : null;
  const claim = normalizeTrustClaim(input.kind, input.params, { now, servedCustomers });
  const existing = await tx.businessTrustClaim.findFirst({
    where: { businessId: input.businessId, claimKind: claim.kind, scopeKey: claim.scopeKey, status: "ACTIVE" },
    select: { id: true },
  });
  if (existing) await retireRow(input.businessId, input.userId, existing.id, tx);
  try {
    return await tx.businessTrustClaim.create({
      data: {
        businessId: input.businessId,
        claimKind: claim.kind,
        claimClass: claim.claimClass,
        scopeKey: claim.scopeKey,
        params: claim.params as Prisma.InputJsonValue,
        wording: claim.wording,
        wordingHash: wordingHash(claim.wording),
        evidenceRuleId: claim.evidence?.ruleId ?? null,
        evidenceRuleVersion: claim.evidence?.ruleVersion ?? null,
        evidenceCondition: claim.evidence ? (claim.evidence.condition as Prisma.InputJsonValue) : Prisma.DbNull,
        confirmedByUserId: input.userId,
        confirmedAt: now,
        validUntil: claim.validUntil,
      },
      select: TRUST_CLAIM_SELECT,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new TrustClaimConflictError();
    throw error;
  }
}

/**
 * Grant or withdraw public use. Granting requires the claim to have NO open issue right now (fresh
 * evidence for SERVED_CUSTOMERS, the private document for verification-required kinds, not expired,
 * re-confirmed within 12 months). Withdrawing is always allowed.
 */
export async function setTrustClaimPublicUse(
  input: { businessId: number; userId: number; claimId: number; approved: unknown },
  tx: Tx,
  now = new Date(),
): Promise<TrustClaimRow> {
  assertActor(input.businessId, input.userId);
  if (typeof input.approved !== "boolean") throw new TrustClaimInputError("approved must be true or false");
  const row = await activeClaim(input.businessId, input.claimId, tx);
  if (input.approved) {
    const servedCustomers = row.claimKind === "SERVED_CUSTOMERS" ? await loadServedCustomers(input.businessId, tx) : null;
    const view = evaluateTrustClaim(row, { now, servedCustomers });
    if (view.issues.length) throw new TrustClaimInputError(`This claim cannot be public yet: ${view.issues.join(", ")}`);
  }
  const data = input.approved
    ? { publicUseApproved: true, publicUseApprovedAt: now, publicUseApprovedByUserId: input.userId }
    : { publicUseApproved: false, publicUseApprovedAt: null, publicUseApprovedByUserId: null };
  const res = await tx.businessTrustClaim.updateMany({ where: { id: row.id, businessId: input.businessId, status: "ACTIVE" }, data });
  if (res.count !== 1) throw new TrustClaimNotFoundError();
  return activeClaim(input.businessId, row.id, tx);
}

export async function retireTrustClaim(input: { businessId: number; userId: number; claimId: number }, tx: Tx): Promise<void> {
  assertActor(input.businessId, input.userId);
  const row = await activeClaim(input.businessId, input.claimId, tx);
  await retireRow(input.businessId, input.userId, row.id, tx);
}

/**
 * Record the owner's PRIVATE supporting document on a verification-required claim (the object is
 * already stored under biz/{businessId}/trust/… by the route). Replacing a document withdraws public
 * use: the approval was given for the previous evidence.
 */
export async function attachVerificationDocument(
  input: { businessId: number; userId: number; claimId: number; storageKey: string; sha256: string; mimeType: string },
  tx: Tx,
  now = new Date(),
): Promise<TrustClaimRow> {
  assertActor(input.businessId, input.userId);
  const row = await activeClaim(input.businessId, input.claimId, tx);
  if (!isVerificationRequired(row.claimKind)) throw new TrustClaimInputError("This kind of claim does not take a supporting document");
  if (!input.storageKey.startsWith(`biz/${input.businessId}/trust/`)) throw new TrustClaimInputError("Invalid document");
  const res = await tx.businessTrustClaim.updateMany({
    where: { id: row.id, businessId: input.businessId, status: "ACTIVE" },
    data: {
      verificationMethod: "OWNER_DOCUMENT",
      verificationAttachmentKey: input.storageKey,
      verificationAttachmentSha256: input.sha256,
      verificationAttachmentMimeType: input.mimeType,
      verifiedAt: now,
      ...(row.publicUseApproved ? { publicUseApproved: false, publicUseApprovedAt: null, publicUseApprovedByUserId: null } : {}),
    },
  });
  if (res.count !== 1) throw new TrustClaimNotFoundError();
  return activeClaim(input.businessId, row.id, tx);
}

/** The private document's storage reference — server-side only, for the owner's own download route. */
export async function verificationDocumentRef(
  input: { businessId: number; claimId: number },
  tx: Tx,
): Promise<{ storageKey: string; mimeType: string } | null> {
  if (!Number.isInteger(input.claimId) || input.claimId <= 0) return null;
  const row = await tx.businessTrustClaim.findFirst({
    where: { id: input.claimId, businessId: input.businessId },
    select: { verificationAttachmentKey: true, verificationAttachmentMimeType: true },
  });
  if (!row?.verificationAttachmentKey || !row.verificationAttachmentMimeType) return null;
  if (!row.verificationAttachmentKey.startsWith(`biz/${input.businessId}/trust/`)) return null;
  return { storageKey: row.verificationAttachmentKey, mimeType: row.verificationAttachmentMimeType };
}

export { servedCustomersBucket };
