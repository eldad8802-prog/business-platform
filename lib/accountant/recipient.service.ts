/**
 * The accountant who receives the package (D4) — one per business, versioned.
 *
 *   - Only the business's own authenticated user changes it, and only with an explicit confirmation
 *     (`confirm: true`) and the version they were looking at (a stale screen cannot overwrite a newer
 *     recipient).
 *   - The address is validated and stored normalised (trimmed, lower-case); the database checks it again.
 *   - Every change is in the trail (RECIPIENT_SET / RECIPIENT_CHANGED, version only — never the address).
 *   - A change makes every approval that has not started sending invalid (CANCELED, recipient_changed):
 *     a new recipient never inherits an approval to receive an existing package.
 *
 * The Secretary's "רואה חשבון" payee is a payment counterparty with no address semantics and is NOT
 * used here.
 */

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { AccountantError } from "./http";
import { appendEvent } from "./store";

const EMAIL = /^[^@\s<>",;:\\()[\]]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

export function normalizeRecipientEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!EMAIL.test(email)) return null;
  const [local, domain] = email.split("@");
  if (!local || local.length > 64 || !domain || domain.length > 253) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const tld = domain.split(".").pop() ?? "";
  if (tld.length < 2 || /^[0-9]+$/.test(tld)) return null;
  return email;
}

export function normalizeRecipientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 120 || CONTROL.test(name)) return null;
  return name;
}

export type RecipientChange = {
  businessId: number;
  userId: number;
  name: unknown;
  email: unknown;
  /** The version the owner saw; null when there was no recipient yet. */
  expectedVersion: unknown;
  confirm: unknown;
  now: Date;
};

export async function setRecipient(input: RecipientChange): Promise<{
  name: string;
  email: string;
  version: number;
  canceledApprovals: number;
}> {
  if (input.confirm !== true) throw new AccountantError(400, "CONFIRMATION_REQUIRED");
  const name = normalizeRecipientName(input.name);
  if (!name) throw new AccountantError(400, "INVALID_NAME");
  const email = normalizeRecipientEmail(input.email);
  if (!email) throw new AccountantError(400, "INVALID_EMAIL");
  const expected = input.expectedVersion === null ? null : Number(input.expectedVersion);
  if (expected !== null && (!Number.isInteger(expected) || expected < 1)) throw new AccountantError(400, "INVALID_VERSION");

  return tenantTx(input.businessId, async (tx) => {
    // Row lock: two concurrent edits are serialised and the second one sees the first one's version.
    const rows = await tx.$queryRaw<Array<{ version: number; email: string; name: string }>>`
      SELECT "version", "email", "name" FROM "AccountantRecipient"
       WHERE "businessId" = ${input.businessId} FOR UPDATE`;
    const current = rows[0] ?? null;
    if ((current?.version ?? null) !== expected) {
      throw new AccountantError(409, "RECIPIENT_CHANGED_ELSEWHERE", { currentVersion: current?.version ?? 0 });
    }
    if (current && current.email === email && current.name === name) {
      return { name, email, version: current.version, canceledApprovals: 0 };
    }

    const version = (current?.version ?? 0) + 1;
    if (current) {
      await tx.accountantRecipient.update({
        where: { businessId: input.businessId },
        data: { name, email, version, updatedByUserId: input.userId, updatedAt: input.now },
      });
    } else {
      await tx.accountantRecipient.create({
        data: {
          businessId: input.businessId,
          name,
          email,
          version,
          updatedByUserId: input.userId,
          createdAt: input.now,
          updatedAt: input.now,
        },
      });
    }

    // Approvals for the previous recipient that have not started sending are void.
    const stale = await tx.accountantDelivery.findMany({
      where: { businessId: input.businessId, status: "APPROVED", recipientVersion: { lt: version } },
      select: { id: true, periodId: true },
    });
    for (const d of stale) {
      await tx.accountantDelivery.update({
        where: { id: d.id },
        data: { status: "CANCELED", canceledAt: input.now, failureCode: "recipient_changed", updatedAt: input.now },
      });
      await appendEvent(tx, {
        businessId: input.businessId,
        periodId: d.periodId,
        deliveryId: d.id,
        eventType: "DELIVERY_CANCELED",
        actor: { type: "OWNER_USER", userId: input.userId },
        occurredAt: input.now,
        payload: { reason: "recipient_changed" },
        idempotencyKey: `cancel:${d.id}`,
      });
    }

    await appendEvent(tx, {
      businessId: input.businessId,
      eventType: current ? "RECIPIENT_CHANGED" : "RECIPIENT_SET",
      actor: { type: "OWNER_USER", userId: input.userId },
      occurredAt: input.now,
      payload: { version, canceledApprovals: stale.length },
      idempotencyKey: `recipient:${input.businessId}:v${version}`,
    });
    return { name, email, version, canceledApprovals: stale.length };
  });
}
