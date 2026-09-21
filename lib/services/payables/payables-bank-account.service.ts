/**
 * Business bank accounts — Accounts Payable Phase 3.
 *
 * The accounts money leaves FROM. Not payment destinations (where money goes):
 * a different concept, with a different crypto purpose, arriving in Phase 4.
 *
 * # The plaintext boundary
 *
 * Full coordinates exist in exactly one place: the argument of
 * `createBusinessBankAccount`, on their way into `sealBankCoordinates`. They are
 * never returned, never logged, never written to audit metadata, and no read in
 * this module selects the ciphertext columns at all — `MASKED_SELECT` is the
 * only projection, so a caller that forgets to mask has nothing to leak.
 *
 * Recovering coordinates (`openBankCoordinates`) is deliberately NOT exposed by
 * any function here. Nothing in Phase 3 needs it; Phase 4's "prepare payment"
 * will add that path, with its own review.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
} from "@/lib/services/payables/payables-core";
import { maskAccount, sealBankCoordinates } from "@/lib/services/payables/payables-bank-crypto";
import { writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

const LABEL_MAX = 80;
const NOTE_MAX = 500;

/** The ONLY projection this module reads. No ciphertext, no fingerprint. */
const MASKED_SELECT = {
  id: true,
  label: true,
  accountLast4: true,
  isActive: true,
  isDefault: true,
  note: true,
  createdAt: true,
} as const;

export type BankAccountView = {
  id: number;
  label: string;
  last4: string;
  masked: string;
  isActive: boolean;
  isDefault: boolean;
  note: string | null;
  createdAt: Date;
};

function toView(row: {
  id: number;
  label: string;
  accountLast4: string;
  isActive: boolean;
  isDefault: boolean;
  note: string | null;
  createdAt: Date;
}): BankAccountView {
  return {
    id: row.id,
    label: row.label,
    last4: row.accountLast4,
    masked: maskAccount(row.accountLast4),
    isActive: row.isActive,
    isDefault: row.isDefault,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function cleanLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PayablesValidationError("label is required");
  }
  const label = value.trim();
  if (label.length > LABEL_MAX) {
    throw new PayablesValidationError(`label must be at most ${LABEL_MAX} characters`);
  }
  return label;
}

function cleanNote(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new PayablesValidationError("note must be text");
  const note = value.trim();
  if (note.length > NOTE_MAX) {
    throw new PayablesValidationError(`note must be at most ${NOTE_MAX} characters`);
  }
  return note || null;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Clear the current default, if any. Runs BEFORE the new default is written so
 * the partial unique index (one active default per business) is never asked to
 * hold two rows at once.
 */
async function clearDefault(tx: Tx, businessId: number, exceptId?: number): Promise<void> {
  await tx.businessBankAccount.updateMany({
    where: {
      businessId,
      isDefault: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isDefault: false },
  });
}

/**
 * Serialises account writes per business, so two concurrent "add" or "make
 * default" calls queue instead of racing the one-default index.
 *
 * A transaction-scoped ADVISORY lock rather than `FOR UPDATE` on the rows: the
 * first account of a business has no row to lock yet, and an advisory lock needs
 * no table privilege beyond what the runtime role already holds. Released
 * automatically at commit or rollback. `$executeRaw` because the function
 * returns `void`, which `$queryRaw` cannot deserialise.
 */
async function lockBusinessAccounts(tx: Tx, businessId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payables-bank-account'), ${businessId}::int)`;
}

export async function listBusinessBankAccounts(input: {
  businessId: number;
  includeArchived?: boolean;
}): Promise<BankAccountView[]> {
  return withTenantTransaction(async (tx) => {
    const rows = await tx.businessBankAccount.findMany({
      where: {
        businessId: input.businessId,
        ...(input.includeArchived ? {} : { isActive: true }),
      },
      select: MASKED_SELECT,
      orderBy: [{ isActive: "desc" }, { isDefault: "desc" }, { id: "asc" }],
    });
    return rows.map(toView);
  });
}

/**
 * Add an account. Sealing happens BEFORE the transaction opens: a missing key
 * fails the request without touching the database, and no plaintext ever
 * reaches Prisma.
 *
 * The same account entered again is one account:
 *   - already ACTIVE    → 409, nothing written
 *   - ARCHIVED earlier  → restored (reactivated), audited as a restore
 *
 * The first active account becomes the default automatically — a business with
 * accounts but no default would make every cheque form ask a question with an
 * obvious answer.
 */
export async function createBusinessBankAccount(input: {
  businessId: number;
  actorUserId?: number | null;
  label: unknown;
  bankCode: unknown;
  branchCode: unknown;
  accountNumber: unknown;
  isDefault?: boolean;
  note?: unknown;
}): Promise<{ account: BankAccountView; restored: boolean }> {
  const label = cleanLabel(input.label);
  const note = cleanNote(input.note);
  const sealed = sealBankCoordinates(
    { bankCode: input.bankCode, branchCode: input.branchCode, accountNumber: input.accountNumber },
    input.businessId,
    "BUSINESS_BANK_ACCOUNT",
  );

  try {
    return await withTenantTransaction(async (tx) => {
      await lockBusinessAccounts(tx, input.businessId);

      const existing = await tx.businessBankAccount.findFirst({
        where: { businessId: input.businessId, fingerprint: sealed.fingerprint },
        select: { id: true, isActive: true },
      });
      if (existing?.isActive) {
        throw new PayablesConflictError("This bank account is already recorded");
      }

      const activeCount = await tx.businessBankAccount.count({
        where: { businessId: input.businessId, isActive: true },
      });
      const makeDefault = input.isDefault === true || activeCount === 0;
      if (makeDefault) await clearDefault(tx, input.businessId);

      if (existing) {
        const row = await tx.businessBankAccount.update({
          where: { id: existing.id },
          data: { isActive: true, isDefault: makeDefault, label, note },
          select: MASKED_SELECT,
        });
        await writeAudit(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId,
          eventType: "BANK_ACCOUNT_RESTORED",
          summary: `Bank account ${maskAccount(row.accountLast4)} restored`,
          metadata: { bankAccountId: row.id, last4: row.accountLast4, isDefault: makeDefault },
        });
        return { account: toView(row), restored: true };
      }

      const row = await tx.businessBankAccount.create({
        data: {
          businessId: input.businessId,
          label,
          note,
          isDefault: makeDefault,
          createdByUserId: input.actorUserId ?? null,
          coordinatesEncrypted: sealed.coordinatesEncrypted,
          coordinatesIv: sealed.coordinatesIv,
          coordinatesTag: sealed.coordinatesTag,
          encryptionKeyId: sealed.encryptionKeyId,
          accountLast4: sealed.accountLast4,
          fingerprint: sealed.fingerprint,
        },
        select: MASKED_SELECT,
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        eventType: "BANK_ACCOUNT_CREATED",
        summary: `Bank account ${maskAccount(row.accountLast4)} added`,
        metadata: { bankAccountId: row.id, last4: row.accountLast4, isDefault: makeDefault },
      });
      return { account: toView(row), restored: false };
    });
  } catch (error) {
    // A concurrent insert of the same account loses at the unique index. The
    // Prisma error would name the index and its columns; the owner only needs
    // to know it is a duplicate.
    if (isUniqueViolation(error)) {
      throw new PayablesConflictError("This bank account is already recorded");
    }
    throw error;
  }
}

async function loadOwned(tx: Tx, businessId: number, id: number) {
  const row = await tx.businessBankAccount.findFirst({
    where: { id, businessId },
    select: MASKED_SELECT,
  });
  if (!row) throw new PayablesNotFoundError("Bank account not found");
  return row;
}

export async function updateBusinessBankAccount(input: {
  businessId: number;
  actorUserId?: number | null;
  bankAccountId: number;
  label?: unknown;
  note?: unknown;
}): Promise<BankAccountView> {
  const data: { label?: string; note?: string | null } = {};
  if (input.label !== undefined) data.label = cleanLabel(input.label);
  if (input.note !== undefined) data.note = cleanNote(input.note);
  if (Object.keys(data).length === 0) {
    throw new PayablesValidationError("Nothing to update");
  }
  return withTenantTransaction(async (tx) => {
    await loadOwned(tx, input.businessId, input.bankAccountId);
    const row = await tx.businessBankAccount.update({
      where: { id: input.bankAccountId },
      data,
      select: MASKED_SELECT,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "BANK_ACCOUNT_UPDATED",
      summary: `Bank account ${maskAccount(row.accountLast4)} details updated`,
      metadata: { bankAccountId: row.id, fields: Object.keys(data) },
    });
    return toView(row);
  });
}

export async function setDefaultBusinessBankAccount(input: {
  businessId: number;
  actorUserId?: number | null;
  bankAccountId: number;
}): Promise<BankAccountView> {
  return withTenantTransaction(async (tx) => {
    await lockBusinessAccounts(tx, input.businessId);
    const current = await loadOwned(tx, input.businessId, input.bankAccountId);
    if (!current.isActive) {
      throw new PayablesValidationError("An archived account cannot be the default");
    }
    if (current.isDefault) return toView(current); // idempotent
    await clearDefault(tx, input.businessId, input.bankAccountId);
    const row = await tx.businessBankAccount.update({
      where: { id: input.bankAccountId },
      data: { isDefault: true },
      select: MASKED_SELECT,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "BANK_ACCOUNT_DEFAULT_SET",
      summary: `Bank account ${maskAccount(row.accountLast4)} set as default`,
      metadata: { bankAccountId: row.id },
    });
    return toView(row);
  });
}

/**
 * Archive — never delete. Cheques already drawn on the account keep pointing at
 * it (the FK is RESTRICT), so their history stays whole; archiving only stops
 * NEW cheques from being drawn on it.
 */
export async function archiveBusinessBankAccount(input: {
  businessId: number;
  actorUserId?: number | null;
  bankAccountId: number;
}): Promise<BankAccountView> {
  return withTenantTransaction(async (tx) => {
    await lockBusinessAccounts(tx, input.businessId);
    const current = await loadOwned(tx, input.businessId, input.bankAccountId);
    if (!current.isActive) return toView(current); // idempotent
    const row = await tx.businessBankAccount.update({
      where: { id: input.bankAccountId },
      data: { isActive: false, isDefault: false },
      select: MASKED_SELECT,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "BANK_ACCOUNT_ARCHIVED",
      summary: `Bank account ${maskAccount(row.accountLast4)} archived`,
      metadata: { bankAccountId: row.id, wasDefault: current.isDefault },
    });
    return toView(row);
  });
}
