import { createHash } from "node:crypto";
import { Prisma, type BusinessIdentityFact } from "@prisma/client";
import { IdentityInputError } from "./identity-vocabulary";
import { IdentityConflictError, IdentityNotFoundError } from "./identity-statement.service";

/**
 * P2 · Publication authority over identity FACTS.
 *
 * The canonical values stay in Business / BusinessProfile. This service records only the owner's
 * decision about one fact — confirmed, and optionally approved for public use — bound to a sha256 of
 * the exact value the decision was made for. When the value later changes, the hash no longer
 * matches and the authority lapses: the fact is KNOWN again, never silently still "approved".
 *
 *   fact existence ≠ permission       a value with no authority row is only KNOWN
 *   billing field ≠ public contact    PUBLIC_PHONE/EMAIL/ADDRESS exist only by explicit designation
 *
 * Deliberately NOT a fact here (not identity-publication concerns, or owned elsewhere):
 *   billingLegalName / billingTaxId / billingVatNumber  tax identity on invoices, governed by billing law
 *   category / subCategory / businessModel              internal taxonomy, not a public claim
 *   latitude / longitude                                no writer exists; a map pin is a later surface
 *   logo / images                                       BusinessAsset.publicUseApproved already governs them
 *   WhatsApp number                                     owned by the WhatsApp integration; channel choice is Conversion
 */

type Tx = Prisma.TransactionClient;

export const FACT_SOURCES: Record<BusinessIdentityFact, { sourceField: string; model: "Business" | "BusinessProfile"; column: string }> = {
  BUSINESS_NAME: { sourceField: "Business.name", model: "Business", column: "name" },
  CITY: { sourceField: "BusinessProfile.city", model: "BusinessProfile", column: "city" },
  OPENING_HOURS: { sourceField: "BusinessProfile.openingHours", model: "BusinessProfile", column: "openingHours" },
  PUBLIC_PHONE: { sourceField: "BusinessProfile.billingPhone", model: "BusinessProfile", column: "billingPhone" },
  PUBLIC_EMAIL: { sourceField: "BusinessProfile.billingEmail", model: "BusinessProfile", column: "billingEmail" },
  PUBLIC_ADDRESS: { sourceField: "BusinessProfile.billingAddress", model: "BusinessProfile", column: "billingAddress" },
};

export const IDENTITY_FACTS = Object.keys(FACT_SOURCES) as BusinessIdentityFact[];

export type FactAuthorityAction = "CONFIRM" | "APPROVE_PUBLIC" | "WITHDRAW_PUBLIC" | "RETIRE";
const ACTIONS = new Set<FactAuthorityAction>(["CONFIRM", "APPROVE_PUBLIC", "WITHDRAW_PUBLIC", "RETIRE"]);

export function isIdentityFact(value: unknown): value is BusinessIdentityFact {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FACT_SOURCES, value);
}

/** sha256 of the exact UTF-8 value — identical to PostgreSQL's encode(sha256(convert_to(v,'UTF8')),'hex'). */
export function factValueHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const FACT_AUTHORITY_SELECT = {
  id: true,
  businessId: true,
  fact: true,
  sourceField: true,
  valueHash: true,
  status: true,
  confirmedByUserId: true,
  confirmedAt: true,
  publicUseApproved: true,
  publicUseApprovedAt: true,
} as const;
export type FactAuthorityRow = Prisma.BusinessIdentityFactAuthorityGetPayload<{ select: typeof FACT_AUTHORITY_SELECT }>;

export class IdentityTenantMismatchError extends Error {
  constructor() {
    super("Identity facts may only be read inside the requested business's tenant transaction");
    this.name = "IdentityTenantMismatchError";
  }
}

/**
 * Business is the tenant root and, since B4 (20261006090000_business_tenant_write_rls), its SELECT
 * policy is USING (true): RLS does not stop a transaction scoped to business A from reading business
 * B's row. So the read is pinned here instead — the transaction's own tenant setting must name the
 * requested business, or nothing is read. Without a tenant context it fails closed.
 */
async function assertTenantTx(businessId: number, tx: Tx): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ tenant: string | null }>>`
    SELECT NULLIF(current_setting('app.current_business_id', true), '') AS "tenant"`;
  if (rows[0]?.tenant !== String(businessId)) throw new IdentityTenantMismatchError();
}

/** The current canonical values of every identity fact, read inside the caller's tenant transaction. */
export async function loadIdentityFactValues(businessId: number, tx: Tx): Promise<Record<BusinessIdentityFact, string | null>> {
  await assertTenantTx(businessId, tx);
  const [business, profile] = await Promise.all([
    tx.business.findUnique({ where: { id: businessId }, select: { name: true } }),
    tx.businessProfile.findUnique({
      where: { businessId },
      select: { city: true, openingHours: true, billingPhone: true, billingEmail: true, billingAddress: true },
    }),
  ]);
  const known = (v: string | null | undefined) => (typeof v === "string" && v.trim() ? v : null);
  return {
    BUSINESS_NAME: known(business?.name),
    CITY: known(profile?.city),
    OPENING_HOURS: known(profile?.openingHours),
    PUBLIC_PHONE: known(profile?.billingPhone),
    PUBLIC_EMAIL: known(profile?.billingEmail),
    PUBLIC_ADDRESS: known(profile?.billingAddress),
  };
}

export function listActiveFactAuthorities(businessId: number, tx: Tx): Promise<FactAuthorityRow[]> {
  return tx.businessIdentityFactAuthority.findMany({
    where: { businessId, status: "ACTIVE" },
    select: FACT_AUTHORITY_SELECT,
    orderBy: [{ fact: "asc" }, { id: "asc" }],
  });
}

/**
 * The owner decides about one fact. The value is read here, server-side, inside the tenant; the
 * client never supplies it. An unknown (empty) value cannot be confirmed or approved.
 */
export async function decideFactAuthority(
  input: { businessId: number; userId: number; fact: unknown; action: unknown },
  tx: Tx,
): Promise<FactAuthorityRow | null> {
  if (!Number.isInteger(input.businessId) || input.businessId <= 0) throw new IdentityInputError("Invalid business");
  if (!Number.isInteger(input.userId) || input.userId <= 0) throw new IdentityInputError("Invalid user");
  if (!isIdentityFact(input.fact)) throw new IdentityInputError("Unknown identity fact");
  if (typeof input.action !== "string" || !ACTIONS.has(input.action as FactAuthorityAction)) {
    throw new IdentityInputError("Unknown action");
  }
  const fact = input.fact;
  const action = input.action as FactAuthorityAction;
  const now = new Date();

  const value = (await loadIdentityFactValues(input.businessId, tx))[fact];
  const hash = value === null ? null : factValueHash(value);
  const active = await tx.businessIdentityFactAuthority.findFirst({
    where: { businessId: input.businessId, fact, status: "ACTIVE" },
    select: FACT_AUTHORITY_SELECT,
  });
  const retire = async (id: number) => {
    const res = await tx.businessIdentityFactAuthority.updateMany({
      where: { id, businessId: input.businessId, status: "ACTIVE" },
      data: { status: "RETIRED", retiredAt: now, retiredByUserId: input.userId },
    });
    if (res.count !== 1) throw new IdentityConflictError();
  };
  const current = active && hash !== null && active.valueHash === hash ? active : null;

  if (action === "RETIRE" || action === "WITHDRAW_PUBLIC") {
    if (!active) throw new IdentityNotFoundError();
    if (action === "RETIRE" || !current) {
      // A stale authority (value changed) is retired rather than edited: it was about another value.
      await retire(active.id);
      return null;
    }
    await tx.businessIdentityFactAuthority.updateMany({
      where: { id: current.id, businessId: input.businessId, status: "ACTIVE" },
      data: { publicUseApproved: false, publicUseApprovedAt: null, publicUseApprovedByUserId: null },
    });
    return tx.businessIdentityFactAuthority.findFirstOrThrow({ where: { id: current.id, businessId: input.businessId }, select: FACT_AUTHORITY_SELECT });
  }

  if (value === null || hash === null) throw new IdentityInputError("This fact has no value yet; there is nothing to confirm");
  const approve = action === "APPROVE_PUBLIC";

  if (current) {
    if (!approve || current.publicUseApproved) return current;
    await tx.businessIdentityFactAuthority.updateMany({
      where: { id: current.id, businessId: input.businessId, status: "ACTIVE" },
      data: { publicUseApproved: true, publicUseApprovedAt: now, publicUseApprovedByUserId: input.userId },
    });
    return tx.businessIdentityFactAuthority.findFirstOrThrow({ where: { id: current.id, businessId: input.businessId }, select: FACT_AUTHORITY_SELECT });
  }

  if (active) await retire(active.id);
  try {
    return await tx.businessIdentityFactAuthority.create({
      data: {
        businessId: input.businessId,
        fact,
        sourceField: FACT_SOURCES[fact].sourceField,
        valueHash: hash,
        confirmedByUserId: input.userId,
        confirmedAt: now,
        publicUseApproved: approve,
        publicUseApprovedAt: approve ? now : null,
        publicUseApprovedByUserId: approve ? input.userId : null,
      },
      select: FACT_AUTHORITY_SELECT,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new IdentityConflictError();
    throw error;
  }
}
