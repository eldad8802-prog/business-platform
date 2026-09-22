/**
 * Payment destinations — Accounts Payable Phase 4.
 *
 * Where money goes TO: a payee's bank account. Never where it comes from (that
 * is a BusinessBankAccount). The two share `payables-bank-crypto` under
 * different PURPOSES, so a destination's ciphertext does not decrypt as a
 * source account's and their fingerprints never collide — and they share no
 * table (programme §11.8).
 *
 * # Exposure (§11.6)
 *
 *   lists / search   masked only: label, beneficiary, last four digits
 *   one row, full    `revealDestinationCoordinates` — the owner copying an
 *                    account number into their bank app. Explicit, single-row,
 *                    AUDITED, and never cached or returned by any list.
 *   logs / audit     never. Audit records "which destination" and "which
 *                    fields changed", never a coordinate or a fingerprint.
 *
 * # Provenance (§11.7)
 *
 * Every destination here is origin OWNER_ENTERED, verification NONE (pinned by a
 * CHECK in the migration). Nothing in this product verifies an account, and no
 * view may imply that one was.
 */

import { Prisma } from "@prisma/client";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import {
  PayablesConflictError,
  PayablesNotFoundError,
  PayablesValidationError,
} from "@/lib/services/payables/payables-core";
import {
  maskAccount,
  openBankCoordinates,
  sealBankCoordinates,
  type BankCoordinates,
} from "@/lib/services/payables/payables-bank-crypto";
import { isUniqueViolation } from "@/lib/services/payables/payables-bank-account.service";
import { writeAudit } from "@/lib/services/payables/payables.service";

type Tx = Prisma.TransactionClient;

const LABEL_MAX = 80;
const NAME_MAX = 120;
const NOTE_MAX = 500;

/** The ONLY projection a list reads. No ciphertext, no fingerprint. */
export const DESTINATION_MASKED_SELECT = {
  id: true,
  payeeId: true,
  label: true,
  beneficiaryName: true,
  accountLast4: true,
  origin: true,
  verification: true,
  isActive: true,
  isDefault: true,
  replacesDestinationId: true,
  note: true,
  createdAt: true,
} as const;

type MaskedRow = Prisma.PaymentDestinationGetPayload<{ select: typeof DESTINATION_MASKED_SELECT }>;

export type DestinationView = {
  id: number;
  payeeId: number;
  label: string;
  beneficiaryName: string;
  last4: string;
  masked: string;
  origin: string;
  /** Always "NONE" today — surfaced so a screen can say so, never to claim more. */
  verification: string;
  isActive: boolean;
  isDefault: boolean;
  replacesDestinationId: number | null;
  note: string | null;
  createdAt: Date;
};

export function toDestinationView(row: MaskedRow): DestinationView {
  return {
    id: row.id,
    payeeId: row.payeeId,
    label: row.label,
    beneficiaryName: row.beneficiaryName,
    last4: row.accountLast4,
    masked: maskAccount(row.accountLast4),
    origin: row.origin,
    verification: row.verification,
    isActive: row.isActive,
    isDefault: row.isDefault,
    replacesDestinationId: row.replacesDestinationId,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function cleanText(value: unknown, field: string, max: number, required: boolean): string | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    if (required) throw new PayablesValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new PayablesValidationError(`${field} must be text`);
  const v = value.trim();
  if (v.length > max) throw new PayablesValidationError(`${field} must be at most ${max} characters`);
  return v;
}

async function lockPayeeDestinations(tx: Tx, businessId: number, payeeId: number): Promise<void> {
  // Advisory, per (business, payee): serialises default changes and the first
  // destination of a payee, which has no row to lock yet.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payables-destination:' || ${businessId}::text), ${payeeId}::int)`;
}

async function assertPayee(tx: Tx, businessId: number, payeeId: number) {
  const payee = await tx.payee.findFirst({
    where: { id: payeeId, businessId },
    select: { id: true, displayName: true, isActive: true },
  });
  if (!payee) throw new PayablesNotFoundError("Payee not found");
  return payee;
}

async function loadOwned(tx: Tx, businessId: number, destinationId: number) {
  const row = await tx.paymentDestination.findFirst({
    where: { id: destinationId, businessId },
    select: DESTINATION_MASKED_SELECT,
  });
  if (!row) throw new PayablesNotFoundError("Destination not found");
  return row;
}

export async function listDestinations(input: {
  businessId: number;
  payeeId?: number | null;
  includeArchived?: boolean;
}): Promise<DestinationView[]> {
  return withTenantTransaction(async (tx) => {
    const rows = await tx.paymentDestination.findMany({
      where: {
        businessId: input.businessId,
        ...(input.payeeId ? { payeeId: input.payeeId } : {}),
        ...(input.includeArchived ? {} : { isActive: true }),
      },
      select: DESTINATION_MASKED_SELECT,
      orderBy: [{ isActive: "desc" }, { isDefault: "desc" }, { id: "asc" }],
      take: 200,
    });
    return rows.map(toDestinationView);
  });
}

/**
 * Add a destination to a payee. Sealed BEFORE the transaction: a missing key
 * fails the request without touching the database, and no plaintext reaches
 * Prisma. The same account for the same payee is one destination (409, or a
 * restore if it was archived); for a DIFFERENT payee it is allowed — two payees
 * of one business may share an account.
 */
export async function createDestination(input: {
  businessId: number;
  actorUserId?: number | null;
  payeeId: number;
  label: unknown;
  beneficiaryName: unknown;
  bankCode: unknown;
  branchCode: unknown;
  accountNumber: unknown;
  isDefault?: boolean;
  note?: unknown;
  replacesDestinationId?: number | null;
}): Promise<{ destination: DestinationView; restored: boolean }> {
  const label = cleanText(input.label, "label", LABEL_MAX, true)!;
  const beneficiaryName = cleanText(input.beneficiaryName, "beneficiaryName", NAME_MAX, true)!;
  const note = cleanText(input.note, "note", NOTE_MAX, false);
  const sealed = sealBankCoordinates(
    { bankCode: input.bankCode, branchCode: input.branchCode, accountNumber: input.accountNumber },
    input.businessId,
    "PAYMENT_DESTINATION",
  );

  try {
    return await withTenantTransaction(async (tx) => {
      await assertPayee(tx, input.businessId, input.payeeId);
      await lockPayeeDestinations(tx, input.businessId, input.payeeId);

      const existing = await tx.paymentDestination.findFirst({
        where: { businessId: input.businessId, payeeId: input.payeeId, fingerprint: sealed.fingerprint },
        select: { id: true, isActive: true },
      });
      if (existing?.isActive) {
        throw new PayablesConflictError("This account is already a destination of this payee");
      }

      const activeCount = await tx.paymentDestination.count({
        where: { businessId: input.businessId, payeeId: input.payeeId, isActive: true },
      });
      const makeDefault = input.isDefault === true || activeCount === 0;
      if (makeDefault) {
        await tx.paymentDestination.updateMany({
          where: { businessId: input.businessId, payeeId: input.payeeId, isDefault: true },
          data: { isDefault: false },
        });
      }

      if (existing) {
        const row = await tx.paymentDestination.update({
          where: { id: existing.id },
          data: { isActive: true, isDefault: makeDefault, label, beneficiaryName, note },
          select: DESTINATION_MASKED_SELECT,
        });
        await writeAudit(tx, {
          businessId: input.businessId,
          actorUserId: input.actorUserId,
          eventType: "DESTINATION_RESTORED",
          summary: `Destination ${maskAccount(row.accountLast4)} restored`,
          metadata: { destinationId: row.id, payeeId: row.payeeId, last4: row.accountLast4 },
        });
        return { destination: toDestinationView(row), restored: true };
      }

      const row = await tx.paymentDestination.create({
        data: {
          businessId: input.businessId,
          payeeId: input.payeeId,
          label,
          beneficiaryName,
          note,
          isDefault: makeDefault,
          replacesDestinationId: input.replacesDestinationId ?? null,
          createdByUserId: input.actorUserId ?? null,
          coordinatesEncrypted: sealed.coordinatesEncrypted,
          coordinatesIv: sealed.coordinatesIv,
          coordinatesTag: sealed.coordinatesTag,
          encryptionKeyId: sealed.encryptionKeyId,
          accountLast4: sealed.accountLast4,
          fingerprint: sealed.fingerprint,
        },
        select: DESTINATION_MASKED_SELECT,
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        eventType: "DESTINATION_CREATED",
        summary: `Destination ${maskAccount(row.accountLast4)} added for a payee`,
        metadata: { destinationId: row.id, payeeId: row.payeeId, last4: row.accountLast4, isDefault: makeDefault },
      });
      return { destination: toDestinationView(row), restored: false };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PayablesConflictError("This account is already a destination of this payee");
    }
    throw error;
  }
}

export async function setDefaultDestination(input: {
  businessId: number;
  actorUserId?: number | null;
  destinationId: number;
}): Promise<DestinationView> {
  return withTenantTransaction(async (tx) => {
    const current = await loadOwned(tx, input.businessId, input.destinationId);
    await lockPayeeDestinations(tx, input.businessId, current.payeeId);
    if (!current.isActive) throw new PayablesValidationError("An archived destination cannot be the default");
    if (current.isDefault) return toDestinationView(current);
    await tx.paymentDestination.updateMany({
      where: { businessId: input.businessId, payeeId: current.payeeId, isDefault: true, id: { not: current.id } },
      data: { isDefault: false },
    });
    const row = await tx.paymentDestination.update({
      where: { id: current.id },
      data: { isDefault: true },
      select: DESTINATION_MASKED_SELECT,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "DESTINATION_DEFAULT_SET",
      summary: `Destination ${maskAccount(row.accountLast4)} set as the payee's default`,
      metadata: { destinationId: row.id, payeeId: row.payeeId },
    });
    return toDestinationView(row);
  });
}

export async function archiveDestination(input: {
  businessId: number;
  actorUserId?: number | null;
  destinationId: number;
}): Promise<DestinationView> {
  return withTenantTransaction(async (tx) => {
    const current = await loadOwned(tx, input.businessId, input.destinationId);
    await lockPayeeDestinations(tx, input.businessId, current.payeeId);
    if (!current.isActive) return toDestinationView(current);
    // A destination an APPROVED preparation is frozen against cannot quietly
    // disappear under it. Cancel or complete the preparation first.
    const frozen = await tx.paymentPreparation.count({
      where: {
        businessId: input.businessId,
        destinationId: current.id,
        status: { in: ["APPROVED", "SUBMITTED", "FAILED"] as never },
      },
    });
    if (frozen > 0) {
      throw new PayablesValidationError(
        "An approved payment is prepared to this destination; cancel or complete it before archiving",
      );
    }
    const row = await tx.paymentDestination.update({
      where: { id: current.id },
      data: { isActive: false, isDefault: false },
      select: DESTINATION_MASKED_SELECT,
    });
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "DESTINATION_ARCHIVED",
      summary: `Destination ${maskAccount(row.accountLast4)} archived`,
      metadata: { destinationId: row.id, payeeId: row.payeeId, wasDefault: current.isDefault },
    });
    return toDestinationView(row);
  });
}

/**
 * Replace a destination with a new account, atomically: the old row is archived
 * and the new row LINKS to it (`replacesDestinationId`, cannot fork), in ONE
 * transaction. The new account is sealed and validated before the transaction
 * opens, so a typo can never leave a payee with its old account archived and no
 * replacement. The replacement inherits the default slot.
 */
export async function replaceDestination(input: {
  businessId: number;
  actorUserId?: number | null;
  destinationId: number;
  label?: unknown;
  beneficiaryName?: unknown;
  bankCode: unknown;
  branchCode: unknown;
  accountNumber: unknown;
}): Promise<{ replaced: DestinationView; replacement: DestinationView }> {
  const sealed = sealBankCoordinates(
    { bankCode: input.bankCode, branchCode: input.branchCode, accountNumber: input.accountNumber },
    input.businessId,
    "PAYMENT_DESTINATION",
  );
  try {
    return await withTenantTransaction(async (tx) => {
      const old = await loadOwned(tx, input.businessId, input.destinationId);
      await lockPayeeDestinations(tx, input.businessId, old.payeeId);
      if (!old.isActive) throw new PayablesValidationError("An archived destination cannot be replaced");
      const frozen = await tx.paymentDestination.findFirst({
        where: { id: old.id, preparations: { some: { status: { in: ["APPROVED", "SUBMITTED", "FAILED"] as never } } } },
        select: { id: true },
      });
      if (frozen) {
        throw new PayablesValidationError(
          "An approved payment is prepared to this destination; cancel or complete it before replacing it",
        );
      }
      const successor = await tx.paymentDestination.findFirst({
        where: { businessId: input.businessId, replacesDestinationId: old.id },
        select: { id: true },
      });
      if (successor) throw new PayablesConflictError("This destination has already been replaced");

      const replacedRow = await tx.paymentDestination.update({
        where: { id: old.id },
        data: { isActive: false, isDefault: false },
        select: DESTINATION_MASKED_SELECT,
      });
      const label = input.label !== undefined ? cleanText(input.label, "label", LABEL_MAX, true)! : old.label;
      const beneficiaryName =
        input.beneficiaryName !== undefined
          ? cleanText(input.beneficiaryName, "beneficiaryName", NAME_MAX, true)!
          : old.beneficiaryName;
      const replacementRow = await tx.paymentDestination.create({
        data: {
          businessId: input.businessId,
          payeeId: old.payeeId,
          label,
          beneficiaryName,
          isDefault: old.isDefault,
          replacesDestinationId: old.id,
          createdByUserId: input.actorUserId ?? null,
          coordinatesEncrypted: sealed.coordinatesEncrypted,
          coordinatesIv: sealed.coordinatesIv,
          coordinatesTag: sealed.coordinatesTag,
          encryptionKeyId: sealed.encryptionKeyId,
          accountLast4: sealed.accountLast4,
          fingerprint: sealed.fingerprint,
        },
        select: DESTINATION_MASKED_SELECT,
      });
      await writeAudit(tx, {
        businessId: input.businessId,
        actorUserId: input.actorUserId,
        eventType: "DESTINATION_REPLACED",
        summary: `Destination ${maskAccount(old.accountLast4)} replaced by ${maskAccount(replacementRow.accountLast4)}`,
        metadata: { destinationId: old.id, replacementDestinationId: replacementRow.id, payeeId: old.payeeId },
      });
      return { replaced: toDestinationView(replacedRow), replacement: toDestinationView(replacementRow) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PayablesConflictError(
        "The replacement was refused: that account is already a destination of this payee, or this one was already replaced",
      );
    }
    throw error;
  }
}

/**
 * The one path that returns full coordinates: a single row, explicitly asked
 * for, audited every time. Returns null if the ciphertext cannot be opened (key
 * missing, tampering) — never a fallback.
 */
export async function revealDestinationCoordinates(input: {
  businessId: number;
  actorUserId?: number | null;
  destinationId: number;
}): Promise<{ destination: DestinationView; coordinates: BankCoordinates | null }> {
  return withTenantTransaction(async (tx) => {
    const row = await tx.paymentDestination.findFirst({
      where: { id: input.destinationId, businessId: input.businessId },
      select: {
        ...DESTINATION_MASKED_SELECT,
        coordinatesEncrypted: true,
        coordinatesIv: true,
        coordinatesTag: true,
        encryptionKeyId: true,
        fingerprint: true,
      },
    });
    if (!row) throw new PayablesNotFoundError("Destination not found");
    const coordinates = openBankCoordinates(row, input.businessId, "PAYMENT_DESTINATION");
    await writeAudit(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: "DESTINATION_REVEALED",
      summary: `Full details of destination ${maskAccount(row.accountLast4)} shown to the owner`,
      metadata: { destinationId: row.id, payeeId: row.payeeId, opened: coordinates !== null },
    });
    return {
      destination: toDestinationView(row),
      coordinates,
    };
  });
}

/** Fingerprint of one destination, for the approval snapshot. Server-side only. */
export async function destinationFingerprintInTx(
  tx: Tx,
  businessId: number,
  destinationId: number,
): Promise<{ fingerprint: string; isActive: boolean; payeeId: number } | null> {
  return tx.paymentDestination.findFirst({
    where: { id: destinationId, businessId },
    select: { fingerprint: true, isActive: true, payeeId: true },
  });
}
