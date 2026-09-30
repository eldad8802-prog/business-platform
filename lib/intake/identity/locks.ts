/**
 * Business Intake M4 · identity locks — serialise every decision about one
 * identifier inside one business.
 *
 * Two events about the same new person (a WhatsApp message and an explicit lead
 * with the same phone) can arrive together. Without a lock each would see "no
 * Customer" and create one. With it, the second waits, then sees the first's
 * committed Customer.
 *
 *   phone     → the SAME lock M2's inbound WhatsApp path takes
 *               (lockInboundSender: namespace 'IS', key = hash(business:phone)),
 *               so intake and WhatsApp serialise on one key.
 *   email     → namespace 'IE'
 *   provider  → namespace 'IP'
 *
 * Locks are taken in ascending (namespace, key) order — every caller the same
 * order, so two events holding overlapping identifier sets cannot deadlock.
 * Transaction-scoped (pg_advisory_xact_lock): released at commit / rollback.
 * Key collisions only cost waiting; every query under a lock is still scoped by
 * businessId and the exact identifier.
 */

import { createHash } from "node:crypto";
import type { TenantTx } from "@/lib/tenant/transaction";
import {
  INBOUND_SENDER_ADVISORY_NAMESPACE,
  inboundSenderLockKey,
} from "@/lib/services/conversation/inbound-customer-message.service";
import { identifierHash, type Identifier } from "./identifiers";

export const IDENTITY_EMAIL_NAMESPACE = 0x49_45; // 'IE'
export const IDENTITY_PROVIDER_NAMESPACE = 0x49_50; // 'IP'

function key32(businessId: number, text: string): number {
  return createHash("sha256").update(`${businessId}:${text}`).digest().readInt32BE(0);
}

export function identityLockKeys(businessId: number, identifiers: Identifier[]): Array<[number, number]> {
  const keys = identifiers.map((id): [number, number] => {
    if (id.kind === "phone") return [INBOUND_SENDER_ADVISORY_NAMESPACE, inboundSenderLockKey(businessId, id.value)];
    const ns = id.kind === "email" ? IDENTITY_EMAIL_NAMESPACE : IDENTITY_PROVIDER_NAMESPACE;
    return [ns, key32(businessId, identifierHash(id))];
  });
  const seen = new Set<string>();
  return keys
    .filter(([ns, k]) => {
      const tag = `${ns}:${k}`;
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export async function lockIdentifiers(tx: TenantTx, businessId: number, identifiers: Identifier[]): Promise<void> {
  for (const [ns, key] of identityLockKeys(businessId, identifiers)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ns}::int, ${key}::int)`;
  }
}
