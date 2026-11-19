/**
 * Issuer declaration (#1081) — the server side of: completing the issuer details, asking for the confirmation link,
 * confirming the declaration, the identity lock, and the issuance gate.
 *
 * Who owns what: session 23 owns the link (lib/auth/issuer-declaration-link.ts, migration 20261126090000); this
 * module owns the details, the canonical statement, the declaration row and enforcement. The link is spent with
 * billing's own tenant transaction, so the spend and the declaration INSERT commit or roll back together.
 *
 * Confirmation, in ONE tenant transaction (order agreed with session 23):
 *   1. the per-business advisory lock — the same key the declaration chain trigger takes;
 *   2. recompute the statement and its digest from the CURRENT database state;
 *   3. consumeIssuerDeclarationLink(tx, …) — anything but CONFIRMED records nothing (the link function changes
 *      nothing either, except on CONFIRMED);
 *   4. INSERT the declaration. If it fails, the transaction — and so the spend — rolls back; the link stays usable.
 *
 * Enforcement (assertIssuerDeclarationForIssueTx) acts ONLY when "IssuerDeclarationEnforcement" holds its row.
 * Nothing here writes that row. Without it, issuance behaves exactly as before.
 */

import type { Prisma } from "@prisma/client";

import {
  consumeIssuerDeclarationLink,
  requestIssuerDeclarationLink,
  type IssuerDeclarationConsumeStatus,
  type IssuerDeclarationLinkResult,
} from "@/lib/auth/issuer-declaration-link";
import { parseBillingBusinessKind, type BillingBusinessKind } from "@/lib/billing/business-identity";
import {
  ISSUER_IDENTITY_FIELDS,
  TRACK_BY_KIND,
  validateIssuerDetails,
  type IssuerDetailField,
  type IssuerDetailProblem,
  type IssuerDetailsInput,
} from "@/lib/billing/issuer-declaration/details";
import {
  type IssuerDeclarationConfirmOutcome,
  type IssuerDeclarationPrecondition,
  type IssuerDeclarationRequestOutcome,
} from "@/lib/billing/issuer-declaration/messages";
import {
  buildIssuerStatement,
  issuerStatementSha256,
  ISSUER_STATEMENT_VERSION,
  type IssuerStatement,
} from "@/lib/billing/issuer-declaration/statement";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { DECLARATION_GOVERNED_DOCUMENT_TYPES } from "@/lib/services/billing/issuer-declaration/issuer-declaration-gates";

type Tx = Prisma.TransactionClient;


/**
 * The declarant's capacity, by kind. Product wording, not law: the owner of an individual business declares for
 * themself; a company declares through a person authorised to sign for it.
 */
export const DECLARANT_CAPACITY_BY_KIND: Record<BillingBusinessKind, string> = {
  EXEMPT_DEALER: "בעל העסק",
  AUTHORIZED_DEALER: "בעל העסק",
  LTD_COMPANY: "מורשה חתימה מטעם החברה",
};

const ISSUER_DETAILS_SELECT = {
  billingBusinessKind: true,
  billingLegalName: true,
  billingTaxId: true,
  billingVatNumber: true,
  billingAddress: true,
  billingPhone: true,
  billingEmail: true,
} as const;

export type CurrentDeclarationView = {
  id: number;
  version: number;
  kind: string;
  track: string;
  legalName: string;
  idNumber: string;
  vatRegistrationNumber: string | null;
  effectiveFrom: Date;
  createdAt: Date;
};

export type IssuerDeclarationContext = {
  details: IssuerDetailsInput;
  problems: IssuerDetailProblem[];
  current: CurrentDeclarationView | null;
  usersInBusiness: number;
  /** null until the details are complete and the declarant has a name. */
  statement: IssuerStatement | null;
  statementSha256: string | null;
  precondition: IssuerDeclarationPrecondition | null;
  /**
   * The signed-in account has no name to sign as (an individual falls back to the legal name, a company cannot).
   * Kept apart from `problems`: it is an account detail, not a business detail, and the screen says so.
   */
  declarantNameMissing: boolean;
  /** Identity fields the owner cannot change here: confirmed at signup and/or declared. */
  lockedFields: IssuerDetailField[];
  /** The problem fields the owner may complete on the declaration screen (problems minus locked fields). */
  editableFields: IssuerDetailField[];
  /** Where the confirmation link goes — the signed-in account's own address (never one from the request). */
  accountEmail: string | null;
};

/** The legal-identity lock (signup confirmation) — the fields it holds, by the database trigger's own list. */
const SIGNUP_LOCKED_FIELDS: readonly IssuerDetailField[] = ["billingBusinessKind", "billingLegalName", "billingTaxId"];

/**
 * Which identity fields are locked, and which problem fields the owner may still complete on the declaration screen.
 * Pure. A declaration locks every declared identity field; a confirmed signup identity locks kind, name and number.
 * A problem on a locked field is never offered for editing — it goes through the controlled correction path.
 */
export function issuerFieldAccess(input: {
  problems: readonly IssuerDetailProblem[];
  legalIdentityConfirmed: boolean;
  declared: boolean;
}): { lockedFields: IssuerDetailField[]; editableFields: IssuerDetailField[] } {
  const locked = new Set<IssuerDetailField>();
  if (input.legalIdentityConfirmed) for (const f of SIGNUP_LOCKED_FIELDS) locked.add(f);
  if (input.declared) for (const f of ISSUER_IDENTITY_FIELDS) locked.add(f);
  const editable: IssuerDetailField[] = [];
  for (const p of input.problems) {
    if (!locked.has(p.field) && p.field !== "billingBusinessKind" && !editable.includes(p.field)) editable.push(p.field);
  }
  return { lockedFields: [...locked], editableFields: editable };
}

/**
 * The canonical statement for a business's stored details — one builder for the owner's own declaration and for a
 * platform designation, so both record exactly the same issuer fields. Returns null while anything is missing.
 */
export function issuerStatementForDetails(input: {
  businessId: number;
  details: IssuerDetailsInput;
  issuedCount: number;
  authorizedUserId: number;
  declarantName: string;
  declarantCapacity: string;
}): IssuerStatement | null {
  const kind = parseBillingBusinessKind(input.details.billingBusinessKind);
  const declarantName = input.declarantName.trim();
  if (!kind || validateIssuerDetails(input.details).length > 0 || !declarantName) return null;
  const shape = TRACK_BY_KIND[kind];
  return buildIssuerStatement({
    businessId: input.businessId,
    // A business that already issued confirms its existing identity; a new one makes its initial declaration.
    kind: input.issuedCount > 0 ? "EXISTING_CONFIRMATION" : "INITIAL",
    track: shape.track,
    legalForm: shape.legalForm,
    vatStatus: shape.vatStatus,
    legalName: (input.details.billingLegalName ?? "").trim(),
    tradeName: null,
    idType: shape.idType,
    idNumber: input.details.billingTaxId,
    vatRegistrationNumber: shape.vatStatus === "AUTHORIZED" ? input.details.billingVatNumber : null,
    address: (input.details.billingAddress ?? "").trim(),
    phone: (input.details.billingPhone ?? "").trim(),
    email: (input.details.billingEmail ?? "").trim(),
    effectiveFrom: null,
    authorizedUserId: input.authorizedUserId,
    declarantName: declarantName.slice(0, 120),
    declarantCapacity: input.declarantCapacity,
    supersedesVersion: null,
  });
}

/**
 * Everything the screens and both POSTs need, read inside the caller's tenant transaction. The statement is built
 * only from what is stored — never from the request.
 */
export async function loadIssuerDeclarationContextTx(
  tx: Tx,
  businessId: number,
  userId: number
): Promise<IssuerDeclarationContext> {
  const [profile, current, usersInBusiness, user, issuedCount] = await Promise.all([
    tx.businessProfile.findUnique({
      where: { businessId },
      select: { ...ISSUER_DETAILS_SELECT, legalIdentityConfirmedAt: true },
    }),
    tx.businessIssuerDeclaration.findFirst({
      where: { businessId, anonymisedAt: null },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, kind: true, track: true, legalName: true, idNumber: true,
        vatRegistrationNumber: true, effectiveFrom: true, createdAt: true,
      },
    }),
    tx.user.count({ where: { businessId } }),
    tx.user.findFirst({ where: { id: userId, businessId }, select: { name: true, email: true } }),
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
  const problems = validateIssuerDetails(details);
  const kind = parseBillingBusinessKind(details.billingBusinessKind);
  const legalName = (details.billingLegalName ?? "").trim();
  // An individual's declarant is the dealer; without a profile name, the legal name is that person's name.
  const declarantName =
    (user?.name ?? "").trim() || (kind && TRACK_BY_KIND[kind].legalForm === "INDIVIDUAL" ? legalName : "");
  const declarantNameMissing = problems.length === 0 && !declarantName;

  const statement: IssuerStatement | null = kind
    ? issuerStatementForDetails({
        businessId,
        details,
        issuedCount,
        authorizedUserId: userId,
        declarantName,
        declarantCapacity: DECLARANT_CAPACITY_BY_KIND[kind],
      })
    : null;

  const precondition: IssuerDeclarationPrecondition | null = current
    ? "ALREADY_DECLARED"
    : problems.length > 0 || declarantNameMissing
      ? "INCOMPLETE"
      : usersInBusiness !== 1
        ? "NEEDS_DESIGNATION"
        : null;

  const { lockedFields, editableFields } = issuerFieldAccess({
    problems,
    legalIdentityConfirmed: profile?.legalIdentityConfirmedAt != null,
    declared: current !== null,
  });

  return {
    details,
    problems,
    current,
    usersInBusiness,
    statement,
    statementSha256: statement ? issuerStatementSha256(statement) : null,
    precondition,
    declarantNameMissing,
    lockedFields,
    editableFields,
    accountEmail: user?.email ?? null,
  };
}

export function loadIssuerDeclarationContext(businessId: number, userId: number): Promise<IssuerDeclarationContext> {
  return billingTenantTx(businessId, (tx) => loadIssuerDeclarationContextTx(tx, businessId, userId));
}

export type RequestDeclarationLinkResult =
  | { outcome: "SENT"; emailId: number; businessId: number; expiresAt: Date }
  | { outcome: Exclude<IssuerDeclarationRequestOutcome, "SENT">; problems?: IssuerDetailProblem[] };

export type DeclarationLinkDeps = {
  request: (input: Parameters<typeof requestIssuerDeclarationLink>[0]) => Promise<IssuerDeclarationLinkResult>;
  consume: typeof consumeIssuerDeclarationLink;
};

const defaultLinkDeps: DeclarationLinkDeps = {
  request: requestIssuerDeclarationLink,
  consume: consumeIssuerDeclarationLink,
};

/** Ask session 23's link library for a link bound to the digest of the statement as stored right now. */
export async function requestDeclarationLink(
  user: { id: number; businessId: number },
  now: Date,
  deps: DeclarationLinkDeps = defaultLinkDeps
): Promise<RequestDeclarationLinkResult> {
  const ctx = await loadIssuerDeclarationContext(user.businessId, user.id);
  if (ctx.precondition) {
    return ctx.precondition === "INCOMPLETE"
      ? { outcome: "INCOMPLETE", problems: ctx.problems }
      : { outcome: ctx.precondition };
  }
  const kind = parseBillingBusinessKind(ctx.details.billingBusinessKind) as BillingBusinessKind;
  const result = await deps.request({
    userId: user.id,
    businessId: user.businessId,
    statementSha256: ctx.statementSha256 as string,
    legalName: (ctx.details.billingLegalName ?? "").trim(),
    legalForm: kind,
    now,
  });
  return result.status === "SENT"
    ? { outcome: "SENT", emailId: result.emailId, businessId: result.businessId, expiresAt: result.expiresAt }
    : { outcome: "NOT_ISSUED" };
}

export type ConfirmDeclarationResult =
  | { outcome: "CONFIRMED"; declarationId: number; version: number }
  | { outcome: Exclude<IssuerDeclarationConfirmOutcome, "CONFIRMED"> };

/** Test seam only: runs after a CONFIRMED spend and before the INSERT (the lab forces a failure here). */
export type ConfirmHooks = { afterConsume?: (tx: Tx) => Promise<void> };

/** The confirmation — one tenant transaction; see the module comment for the order. */
export async function confirmDeclaration(
  user: { id: number; businessId: number },
  token: unknown,
  now: Date,
  deps: DeclarationLinkDeps = defaultLinkDeps,
  hooks: ConfirmHooks = {}
): Promise<ConfirmDeclarationResult> {
  const businessId = user.businessId;
  return billingTenantTx(businessId, async (tx): Promise<ConfirmDeclarationResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`issuer_declaration:${businessId}`}, 0))`;
    const ctx = await loadIssuerDeclarationContextTx(tx, businessId, user.id);
    if (ctx.precondition) return { outcome: ctx.precondition };
    const statement = ctx.statement as IssuerStatement;

    const status: IssuerDeclarationConsumeStatus = await deps.consume(tx, {
      token,
      userId: user.id,
      statementSha256: ctx.statementSha256 as string,
    });
    if (status !== "CONFIRMED") return { outcome: status };

    await hooks.afterConsume?.(tx);

    const created = await tx.businessIssuerDeclaration.create({
      data: {
        businessId,
        version: 1,
        supersedesId: null,
        kind: statement.kind as "INITIAL" | "EXISTING_CONFIRMATION",
        track: statement.track as "EXEMPT_DEALER" | "AUTHORIZED_DEALER_INDIVIDUAL" | "COMPANY_AUTHORIZED_DEALER",
        legalForm: statement.legalForm as "INDIVIDUAL" | "COMPANY",
        vatStatus: statement.vatStatus as "EXEMPT" | "AUTHORIZED",
        legalName: statement.legalName as string,
        tradeName: null,
        idType: statement.idType as "ISRAELI_ID" | "COMPANY_NUMBER",
        idNumber: statement.idNumber as string,
        vatRegistrationNumber: (statement.vatRegistrationNumber as string | null) ?? null,
        address: statement.address as string,
        phone: statement.phone as string,
        email: statement.email as string,
        // The first declaration takes effect on confirmation (its statement says effectiveFrom: null).
        effectiveFrom: now,
        authorizedUserId: user.id,
        authorityBasis: "SOLE_USER_VERIFIED",
        declaredByUserId: user.id,
        declarantName: statement.declarantName as string,
        declarantCapacity: statement.declarantCapacity as string,
        statementVersion: ISSUER_STATEMENT_VERSION,
        statementSha256: ctx.statementSha256 as string,
        // The signed-in session plus the single-use link sent to the account's address is the step-up.
        reauthMethod: "EMAIL_LINK",
        reauthAt: now,
      },
      select: { id: true, version: true },
    });
    return { outcome: "CONFIRMED", declarationId: created.id, version: created.version };
  });
}
