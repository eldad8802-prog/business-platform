/**
 * Business Intake M4 · identity links — the CURRENT interpretation.
 *
 * A link says "this identifier belongs to this Customer". It is written only
 *   - deterministically, when an event was RESOLVED by strong evidence and it
 *     carried further identifiers nobody else holds (e.g. a lead's email seen
 *     together with a phone already on the Customer), or when the event CREATED
 *     the Customer; or
 *   - by the owner, confirming a proposal.
 *
 * It never overwrites: an identifier ACTIVE for another Customer is left alone
 * and reported (that is a conflict for the owner, not something to "fix").
 * The partial unique index (one active link per identifier per business) makes
 * that hold under concurrency too; createMany + skipDuplicates turns a racing
 * duplicate into a no-op instead of an error.
 *
 * Phones already on Customer.phone are not duplicated into links — the Customer
 * row is the authoritative phone identity.
 */

import { Prisma } from "@prisma/client";
import type { TenantTx } from "@/lib/tenant/transaction";
import { hashIdentifier, type HashedIdentifier, type Identifier } from "./identifiers";

/**
 * The Customer whose ROW carries the phone behind this hash, if any. A proposal
 * holds hashes only, so the owner-decision path cannot compare phone values; the
 * hash is recomputed in SQL (same domain-separated input as identifierHash).
 */
export async function phoneRowOwnerByHash(tx: TenantTx, businessId: number, valueHash: string): Promise<number | null> {
  const rows = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    SELECT "id" FROM "Customer"
     WHERE "businessId" = ${businessId} AND "phone" IS NOT NULL
       AND 'sha256:' || encode(sha256(convert_to(concat_ws(chr(31), 'm4.identity.v1', 'phone', '', "phone"), 'UTF8')), 'hex') = ${valueHash}
     LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** Who holds this identifier now: a Customer row (phone) or an active link. */
export async function currentHolder(
  tx: TenantTx,
  businessId: number,
  id: Identifier | HashedIdentifier
): Promise<number | null> {
  const h: HashedIdentifier = "valueHash" in id ? id : hashIdentifier(id);
  if (!h.valueHash) return null;
  if (h.kind === "phone") {
    const row =
      "value" in id
        ? (await tx.customer.findFirst({ where: { businessId, phone: id.value }, select: { id: true } }))?.id ?? null
        : await phoneRowOwnerByHash(tx, businessId, h.valueHash);
    if (row !== null) return row;
  }
  const link = await tx.identityLink.findFirst({
    where: { businessId, kind: h.kind, scope: h.scope, valueHash: h.valueHash, status: "active" },
    select: { customerId: true },
  });
  return link?.customerId ?? null;
}

/**
 * What a proposal may offer to link: only identifiers NOBODY holds. One already
 * held (another Customer's phone, a proven email) is evidence for the owner, never
 * something a confirmation moves — moving it would be a merge nobody decided.
 */
export async function unheldIdentifiers(tx: TenantTx, businessId: number, ids: Identifier[]): Promise<HashedIdentifier[]> {
  const out: HashedIdentifier[] = [];
  for (const id of ids) if ((await currentHolder(tx, businessId, id)) === null) out.push(hashIdentifier(id));
  return out;
}

export type LinkWrite = {
  created: HashedIdentifier[];
  alreadyOwned: HashedIdentifier[];
  heldByOther: HashedIdentifier[];
};

export async function ensureLinks(
  tx: TenantTx,
  args: {
    businessId: number;
    customerId: number;
    identifiers: Array<Identifier | HashedIdentifier>;
    method: "deterministic" | "owner_confirmed";
    sourceIntakeEventId?: number | null;
    proposalId?: number | null;
  }
): Promise<LinkWrite> {
  const out: LinkWrite = { created: [], alreadyOwned: [], heldByOther: [] };
  for (const raw of args.identifiers) {
    const h: HashedIdentifier = "valueHash" in raw ? raw : hashIdentifier(raw);
    if (h.kind === "phone") {
      // A phone on a Customer ROW is that Customer's identity — never duplicated
      // into a link, never re-pointed (checked by hash when only the hash is known).
      const row =
        "value" in raw
          ? (await tx.customer.findFirst({ where: { businessId: args.businessId, phone: raw.value }, select: { id: true } }))?.id ?? null
          : await phoneRowOwnerByHash(tx, args.businessId, h.valueHash);
      if (row !== null) {
        (row === args.customerId ? out.alreadyOwned : out.heldByOther).push(h);
        continue;
      }
      // Deterministic linking never attaches an unknown phone through other
      // evidence (e.g. an email) — that would chain identities nobody decided.
      // Only the OWNER adds a phone to a Customer this way.
      if (args.method === "deterministic") continue;
    }
    const existing = await tx.identityLink.findFirst({
      where: { businessId: args.businessId, kind: h.kind, scope: h.scope, valueHash: h.valueHash, status: "active" },
      select: { customerId: true },
    });
    if (existing) {
      (existing.customerId === args.customerId ? out.alreadyOwned : out.heldByOther).push(h);
      continue;
    }
    const res = await tx.identityLink.createMany({
      data: [
        {
          businessId: args.businessId,
          customerId: args.customerId,
          kind: h.kind,
          scope: h.scope,
          valueHash: h.valueHash,
          method: args.method,
          sourceIntakeEventId: args.sourceIntakeEventId ?? null,
          proposalId: args.proposalId ?? null,
        },
      ],
      skipDuplicates: true,
    });
    if (res.count === 1) out.created.push(h);
    else out.heldByOther.push(h); // lost a race to another Customer's link
  }
  return out;
}

/** Revoke the links a confirmed proposal created (undo). Returns the count revoked. */
export async function revokeProposalLinks(
  tx: TenantTx,
  args: { businessId: number; proposalId: number; userId: number | null; now: Date }
): Promise<number> {
  const res = await tx.identityLink.updateMany({
    where: { businessId: args.businessId, proposalId: args.proposalId, status: "active" },
    data: { status: "revoked", revokedAt: args.now, revokedByUserId: args.userId, revokeReason: "owner_undo" },
  });
  return res.count;
}
