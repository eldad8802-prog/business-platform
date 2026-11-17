/**
 * Issuer declaration (#1081) — platform designation of the user authorized to declare, for a business with more than
 * one user (owner decision 2026-11-17: a controlled, secured, documented admin path).
 *
 * Nothing new in the database: the designation is written ONLY by the migration's definer functions
 * (issuer_designate_initial / issuer_designate_authorized_user, 20261126100000), which are executable by the
 * platform-admin role (app_admin) alone and check, inside the database, that the designating admin is a PLATFORM_ADMIN
 * and that the designated user belongs to the business. The resulting declaration row is permanent and append-only:
 * who designated, when, the evidence reference and the reason — the binding record (owner decision; a separate
 * platform audit event would need a new grant and is not part of this path).
 *
 * The issuer details recorded are the business's own, read from BusinessProfile (the single identity source) inside
 * the business's tenant transaction; the statement and its digest are built with the same builder as the owner's own
 * declaration. Self-designation is refused here and the route requires MFA elevation.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { ConflictError, ValidationError } from "@/lib/errors";
import { validateIssuerDetails, type IssuerDetailProblem, type IssuerDetailsInput } from "@/lib/billing/issuer-declaration/details";
import {
  buildIssuerStatement,
  issuerStatementSha256,
  ISSUER_STATEMENT_VERSION,
  type IssuerStatement,
} from "@/lib/billing/issuer-declaration/statement";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { DECLARATION_GOVERNED_DOCUMENT_TYPES } from "@/lib/services/billing/issuer-declaration/issuer-declaration-gates";
import { issuerStatementForDetails } from "@/lib/services/billing/issuer-declaration/issuer-declaration.service";

type Tx = Prisma.TransactionClient;

export const PLATFORM_DECLARANT_CAPACITY = "מנהל פלטפורמה";

export type DesignationUser = { id: number; name: string | null; email: string };

export type DesignationCurrent = {
  id: number;
  version: number;
  kind: string;
  track: string;
  legalForm: string;
  vatStatus: string;
  legalName: string;
  idType: string;
  idNumber: string;
  vatRegistrationNumber: string | null;
  address: string;
  phone: string;
  email: string;
  effectiveFrom: Date;
  authorizedUserId: number;
  createdAt: Date;
};

export type DesignationContext = {
  businessId: number;
  details: IssuerDetailsInput;
  problems: IssuerDetailProblem[];
  users: DesignationUser[];
  current: DesignationCurrent | null;
  issuedCount: number;
};

export async function loadIssuerDesignationContextTx(tx: Tx, businessId: number): Promise<DesignationContext> {
  const [profile, users, current, issuedCount] = await Promise.all([
    tx.businessProfile.findUnique({
      where: { businessId },
      select: {
        billingBusinessKind: true, billingLegalName: true, billingTaxId: true, billingVatNumber: true,
        billingAddress: true, billingPhone: true, billingEmail: true,
      },
    }),
    tx.user.findMany({ where: { businessId }, select: { id: true, name: true, email: true }, orderBy: { id: "asc" } }),
    tx.businessIssuerDeclaration.findFirst({
      where: { businessId, anonymisedAt: null },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, kind: true, track: true, legalForm: true, vatStatus: true, legalName: true, idType: true,
        idNumber: true, vatRegistrationNumber: true, address: true, phone: true, email: true, effectiveFrom: true,
        authorizedUserId: true, createdAt: true,
      },
    }),
    tx.billingDocument.count({
      where: { businessId, status: "ISSUED", documentType: { in: [...DECLARATION_GOVERNED_DOCUMENT_TYPES] } },
    }),
  ]);
  const details: IssuerDetailsInput = {
    billingBusinessKind: profile?.billingBusinessKind ?? null,
    billingLegalName: profile?.billingLegalName ?? null,
    billingTaxId: profile?.billingTaxId ?? null,
    billingVatNumber: profile?.billingVatNumber ?? null,
    billingAddress: profile?.billingAddress ?? null,
    billingPhone: profile?.billingPhone ?? null,
    billingEmail: profile?.billingEmail ?? null,
  };
  return {
    businessId,
    details,
    problems: validateIssuerDetails(details),
    users,
    current: current as DesignationCurrent | null,
    issuedCount,
  };
}

export function loadIssuerDesignationContext(businessId: number): Promise<DesignationContext> {
  return billingTenantTx(businessId, (tx) => loadIssuerDesignationContextTx(tx, businessId));
}

export type DesignationInput = {
  admin: { id: number; name: string | null; email: string };
  businessId: number;
  authorizedUserId: unknown;
  evidenceRef: unknown;
  reason: unknown;
};

export type DesignationPlan =
  | {
      mode: "INITIAL";
      authorizedUserId: number;
      adminName: string;
      evidenceRef: string;
      reason: string;
      statement: IssuerStatement;
      statementSha256: string;
      issuer: Record<string, string | null>;
    }
  | {
      mode: "TRANSFER";
      authorizedUserId: number;
      adminName: string;
      evidenceRef: string;
      reason: string;
      statement: IssuerStatement;
      statementSha256: string;
    };

/** Hebrew refusals the admin sees; nothing is written when any of these applies. */
export const DESIGNATION_MESSAGES = {
  USER_REQUIRED: "יש לבחור את המשתמש המורשה להצהיר.",
  USER_NOT_IN_BUSINESS: "המשתמש שנבחר אינו משתמש של העסק הזה.",
  SELF: "מנהל אינו יכול למנות את עצמו.",
  EVIDENCE_REQUIRED: "יש לציין אסמכתה (עד 200 תווים).",
  REASON_REQUIRED: "יש לציין סיבה (5–1000 תווים).",
  INCOMPLETE: "פרטי המנפיק של העסק אינם שלמים, ולכן אי אפשר לרשום הצהרה. יש להשלים אותם קודם.",
  SAME_USER: "המשתמש שנבחר כבר מוגדר כמורשה להצהיר.",
  ADMIN_NAME: "לחשבון המנהל אין שם מלא, והוא נדרש כדי להופיע כמי שמינה.",
  DB_REFUSED: "מסד הנתונים סירב לרשום את המינוי, ושום דבר לא נשמר.",
} as const;

/**
 * Validates the request and plans the designation from the business's stored state. Pure (given the context): no
 * write happens here. INITIAL = the business has no declaration yet; TRANSFER = it has one and the authority moves.
 */
export function planIssuerDesignation(input: DesignationInput, ctx: DesignationContext): DesignationPlan {
  const authorizedUserId = typeof input.authorizedUserId === "number" ? input.authorizedUserId : Number(input.authorizedUserId);
  if (!Number.isInteger(authorizedUserId) || authorizedUserId <= 0) throw new ValidationError(DESIGNATION_MESSAGES.USER_REQUIRED);
  if (authorizedUserId === input.admin.id) throw new ValidationError(DESIGNATION_MESSAGES.SELF);
  if (!ctx.users.some((u) => u.id === authorizedUserId)) throw new ValidationError(DESIGNATION_MESSAGES.USER_NOT_IN_BUSINESS);
  const evidenceRef = typeof input.evidenceRef === "string" ? input.evidenceRef.trim() : "";
  if (evidenceRef.length < 1 || evidenceRef.length > 200) throw new ValidationError(DESIGNATION_MESSAGES.EVIDENCE_REQUIRED);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 1000) throw new ValidationError(DESIGNATION_MESSAGES.REASON_REQUIRED);
  const adminName = (input.admin.name ?? "").trim().slice(0, 120);
  if (!adminName) throw new ValidationError(DESIGNATION_MESSAGES.ADMIN_NAME);

  if (!ctx.current) {
    if (ctx.problems.length > 0) throw new ConflictError("ISSUER_DESIGNATION_INCOMPLETE", DESIGNATION_MESSAGES.INCOMPLETE);
    const statement = issuerStatementForDetails({
      businessId: ctx.businessId,
      details: ctx.details,
      issuedCount: ctx.issuedCount,
      authorizedUserId,
      declarantName: adminName,
      declarantCapacity: PLATFORM_DECLARANT_CAPACITY,
    });
    if (!statement) throw new ConflictError("ISSUER_DESIGNATION_INCOMPLETE", DESIGNATION_MESSAGES.INCOMPLETE);
    return {
      mode: "INITIAL",
      authorizedUserId,
      adminName,
      evidenceRef,
      reason,
      statement,
      statementSha256: issuerStatementSha256(statement),
      issuer: {
        kind: String(statement.kind),
        track: String(statement.track),
        legalForm: String(statement.legalForm),
        vatStatus: String(statement.vatStatus),
        legalName: String(statement.legalName),
        tradeName: null,
        idType: String(statement.idType),
        idNumber: String(statement.idNumber),
        vatRegistrationNumber: statement.vatRegistrationNumber === null ? null : String(statement.vatRegistrationNumber),
        address: String(statement.address),
        phone: String(statement.phone),
        email: String(statement.email),
      },
    };
  }

  if (ctx.current.authorizedUserId === authorizedUserId) throw new ConflictError("ISSUER_DESIGNATION_SAME_USER", DESIGNATION_MESSAGES.SAME_USER);
  // An authority transfer copies the current issuer fields unchanged (the database function does exactly that).
  const c = ctx.current;
  const statement = buildIssuerStatement({
    businessId: ctx.businessId,
    kind: "AUTHORITY_TRANSFER",
    track: c.track,
    legalForm: c.legalForm,
    vatStatus: c.vatStatus,
    legalName: c.legalName,
    tradeName: null,
    idType: c.idType,
    idNumber: c.idNumber,
    vatRegistrationNumber: c.vatRegistrationNumber,
    address: c.address,
    phone: c.phone,
    email: c.email,
    effectiveFrom: c.effectiveFrom.toISOString(),
    authorizedUserId,
    declarantName: adminName,
    declarantCapacity: PLATFORM_DECLARANT_CAPACITY,
    supersedesVersion: c.version,
  });
  return { mode: "TRANSFER", authorizedUserId, adminName, evidenceRef, reason, statement, statementSha256: issuerStatementSha256(statement) };
}

/** The one write: the migration's definer function, as the platform-admin role. Returns the new declaration id. */
export type DesignationWriter = (plan: DesignationPlan, ctx: { businessId: number; adminUserId: number }) => Promise<number>;

type RawQueryClient = { $queryRaw: PrismaClient["$queryRaw"] };

/**
 * The writer over a given client. Production binds it to the platform-admin client in the approved admin surface
 * (lib/services/platform-admin/issuer-designation-writer.ts); the lab passes its own. This module never imports a
 * privileged client.
 */
export function designationWriterFor(getDb: () => RawQueryClient): DesignationWriter {
  return (plan, ctx) => runDesignationSql(getDb(), plan, ctx);
}

async function runDesignationSql(db: RawQueryClient, plan: DesignationPlan, ctx: { businessId: number; adminUserId: number }): Promise<number> {
  if (plan.mode === "INITIAL") {
    const rows = await db.$queryRaw<{ id: number }[]>`
      SELECT public.issuer_designate_initial(
        ${ctx.businessId}::integer, ${plan.authorizedUserId}::integer, ${ctx.adminUserId}::integer, ${plan.adminName}::text,
        ${plan.evidenceRef}::text, ${plan.reason}::text, ${ISSUER_STATEMENT_VERSION}::text, ${plan.statementSha256}::text,
        ${JSON.stringify(plan.issuer)}::jsonb) AS id`;
    return Number(rows[0]?.id);
  }
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT public.issuer_designate_authorized_user(
      ${ctx.businessId}::integer, ${plan.authorizedUserId}::integer, ${ctx.adminUserId}::integer, ${plan.adminName}::text,
      ${plan.evidenceRef}::text, ${plan.reason}::text, ${ISSUER_STATEMENT_VERSION}::text, ${plan.statementSha256}::text) AS id`;
  return Number(rows[0]?.id);
}

/** The database's own refusals (the migration's DZD3x codes) — answered as a 409, nothing written. */
export function isDesignationDbRefusal(error: unknown): boolean {
  return error instanceof Error && /ISSUER_[A-Z_]+|DZD3[0-9]/.test(error.message);
}

export async function designateIssuerAuthority(
  input: DesignationInput,
  deps: { load?: typeof loadIssuerDesignationContext; write: DesignationWriter }
): Promise<{ declarationId: number; mode: "INITIAL" | "TRANSFER" }> {
  const ctx = await (deps.load ?? loadIssuerDesignationContext)(input.businessId);
  const plan = planIssuerDesignation(input, ctx);
  try {
    const declarationId = await deps.write(plan, { businessId: input.businessId, adminUserId: input.admin.id });
    return { declarationId, mode: plan.mode };
  } catch (error) {
    if (isDesignationDbRefusal(error)) throw new ConflictError("ISSUER_DESIGNATION_REFUSED", DESIGNATION_MESSAGES.DB_REFUSED);
    throw error;
  }
}
