import { Prisma, type BusinessIdentityDimension, type BusinessIdentitySource } from "@prisma/client";
import {
  DIMENSION_RULES,
  IdentityInputError,
  isIdentityDimension,
  normalizeStatementValue,
} from "./identity-vocabulary";

/**
 * P2 · Owner identity statements — the only writer of BusinessIdentityStatement.
 *
 * Every function takes a tenant transaction (`tenantTx`) and a server-derived businessId and
 * userId. A row here is OWNER_CONFIRMED by construction. Changing a statement retires the old
 * row and inserts a new one; nothing is deleted, and public-use approval never carries over to
 * new text.
 */

type Tx = Prisma.TransactionClient;

export class IdentityNotFoundError extends Error {
  constructor() {
    super("Identity statement not found");
    this.name = "IdentityNotFoundError";
  }
}

export class IdentityConflictError extends Error {
  constructor(message = "This identity statement changed at the same time; try again") {
    super(message);
    this.name = "IdentityConflictError";
  }
}

export const STATEMENT_SELECT = {
  id: true,
  businessId: true,
  dimension: true,
  code: true,
  text: true,
  source: true,
  sourceRef: true,
  status: true,
  confirmedByUserId: true,
  publicUseApproved: true,
  publicUseApprovedAt: true,
  createdAt: true,
} as const;

export type IdentityStatementRow = Prisma.BusinessIdentityStatementGetPayload<{ select: typeof STATEMENT_SELECT }>;

function assertActor(businessId: number, userId: number) {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new IdentityInputError("Invalid business");
  if (!Number.isInteger(userId) || userId <= 0) throw new IdentityInputError("Invalid user");
}

export type CreateIdentityStatementInput = {
  businessId: number;
  userId: number;
  dimension: unknown;
  code?: unknown;
  text?: unknown;
  source: BusinessIdentitySource;
  sourceRef?: string | null;
  /** Replace this ACTIVE statement (same dimension) in the same transaction. */
  replacesStatementId?: number | null;
};

async function retire(tx: Tx, businessId: number, userId: number, id: number) {
  const res = await tx.businessIdentityStatement.updateMany({
    where: { id, businessId, status: "ACTIVE" },
    data: { status: "RETIRED", retiredAt: new Date(), retiredByUserId: userId },
  });
  if (res.count !== 1) throw new IdentityNotFoundError();
}

export async function createIdentityStatement(input: CreateIdentityStatementInput, tx: Tx): Promise<IdentityStatementRow> {
  assertActor(input.businessId, input.userId);
  if (!isIdentityDimension(input.dimension)) throw new IdentityInputError("Unknown identity dimension");
  const dimension: BusinessIdentityDimension = input.dimension;
  const rule = DIMENSION_RULES[dimension];
  const value = normalizeStatementValue(dimension, { code: input.code, text: input.text });
  if (input.source === "OWNER_ADOPTED_SUGGESTION" && !input.sourceRef) {
    throw new IdentityInputError("An adopted suggestion must name its signal");
  }
  const sourceRef = input.sourceRef ? input.sourceRef.slice(0, 120) : null;

  const active = await tx.businessIdentityStatement.findMany({
    where: { businessId: input.businessId, dimension, status: "ACTIVE" },
    select: STATEMENT_SELECT,
    orderBy: { id: "asc" },
  });

  // Same value already stated: idempotent, the owner's existing statement stands.
  const same = active.find((row) => row.code === value.code && row.text === value.text);
  if (same) return same;

  if (dimension === "SECONDARY_OBJECTIVE") {
    const primary = await tx.businessIdentityStatement.findFirst({
      where: { businessId: input.businessId, dimension: "PRIMARY_OBJECTIVE", status: "ACTIVE", code: value.code },
      select: { id: true },
    });
    if (primary) throw new IdentityInputError("This objective is already the primary objective");
  }

  let replaced: number | null = null;
  if (input.replacesStatementId !== undefined && input.replacesStatementId !== null) {
    if (!active.some((row) => row.id === input.replacesStatementId)) throw new IdentityNotFoundError();
    replaced = input.replacesStatementId;
  } else if (rule.single && active.length > 0) {
    replaced = active[0].id;
  }
  const remaining = active.length - (replaced === null ? 0 : 1);
  if (remaining >= rule.maxActive) {
    throw new IdentityInputError(`At most ${rule.maxActive} active ${dimension} statements`);
  }

  if (replaced !== null) await retire(tx, input.businessId, input.userId, replaced);
  if (dimension === "PRIMARY_OBJECTIVE") {
    // Promoting a secondary objective to primary: it stops being secondary.
    await tx.businessIdentityStatement.updateMany({
      where: { businessId: input.businessId, dimension: "SECONDARY_OBJECTIVE", status: "ACTIVE", code: value.code },
      data: { status: "RETIRED", retiredAt: new Date(), retiredByUserId: input.userId },
    });
  }
  try {
    return await tx.businessIdentityStatement.create({
      data: {
        businessId: input.businessId,
        dimension,
        code: value.code,
        text: value.text,
        source: input.source,
        sourceRef,
        confirmedByUserId: input.userId,
      },
      select: STATEMENT_SELECT,
    });
  } catch (error) {
    // The partial unique indexes are the concurrency guard: a parallel writer won.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new IdentityConflictError();
    }
    throw error;
  }
}

export async function retireIdentityStatement(
  input: { businessId: number; userId: number; statementId: number },
  tx: Tx,
): Promise<void> {
  assertActor(input.businessId, input.userId);
  if (!Number.isInteger(input.statementId) || input.statementId <= 0) throw new IdentityNotFoundError();
  await retire(tx, input.businessId, input.userId, input.statementId);
}

/**
 * Grant or withdraw PUBLIC_USE_APPROVED on one active, claim-like statement. Owner confirmation is
 * a precondition (the row exists); approval is a separate, explicit act that is recorded with who
 * and when.
 */
export async function setIdentityPublicUse(
  input: { businessId: number; userId: number; statementId: number; approved: boolean },
  tx: Tx,
): Promise<IdentityStatementRow> {
  assertActor(input.businessId, input.userId);
  if (typeof input.approved !== "boolean") throw new IdentityInputError("approved must be true or false");
  const row = await tx.businessIdentityStatement.findFirst({
    where: { id: input.statementId, businessId: input.businessId, status: "ACTIVE" },
    select: { id: true, dimension: true },
  });
  if (!row) throw new IdentityNotFoundError();
  if (!DIMENSION_RULES[row.dimension].publicUseEligible) {
    throw new IdentityInputError(`${row.dimension} is internal and cannot be approved for public use`);
  }
  const data = input.approved
    ? { publicUseApproved: true, publicUseApprovedAt: new Date(), publicUseApprovedByUserId: input.userId }
    : { publicUseApproved: false, publicUseApprovedAt: null, publicUseApprovedByUserId: null };
  const res = await tx.businessIdentityStatement.updateMany({
    where: { id: row.id, businessId: input.businessId, status: "ACTIVE" },
    data,
  });
  if (res.count !== 1) throw new IdentityNotFoundError();
  return tx.businessIdentityStatement.findFirstOrThrow({
    where: { id: row.id, businessId: input.businessId },
    select: STATEMENT_SELECT,
  });
}

export function listActiveIdentityStatements(businessId: number, tx: Tx): Promise<IdentityStatementRow[]> {
  return tx.businessIdentityStatement.findMany({
    where: { businessId, status: "ACTIVE" },
    select: STATEMENT_SELECT,
    orderBy: [{ dimension: "asc" }, { id: "asc" }],
  });
}
