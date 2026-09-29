/**
 * Business Intake M4 · deterministic identity resolution.
 *
 * "Who is this about, and how certain are we?" — answered from EVIDENCE, inside
 * ONE business (every query carries businessId; FORCE RLS backs it), with no
 * fuzzy matching, no names, no AI:
 *
 *   STRONG     phone  — Customer.phone (the domain's own unique key) or an
 *                       ACTIVE phone link (an owner-confirmed alternate)
 *              provider — an ACTIVE link for that provider-scoped id
 *              email  — an ACTIVE email link (proven earlier: seen together with
 *                       a strong identifier, or confirmed by the owner)
 *   WEAK       email  — only Customer.email (free text nobody verified)
 *
 * Policy (identity-policy@1):
 *   two strong identifiers → different Customers          CONFLICT
 *   one strong Customer, a weak email names someone else  CONFLICT
 *   one strong Customer (anything weak agrees or absent)  RESOLVED
 *   no strong; weak email → exactly one Customer          CANDIDATE
 *   no strong; weak email → several Customers             AMBIGUOUS
 *   nothing matches                                       UNRESOLVED
 *   no identifiers at all                                 NOT_APPLICABLE
 *
 * Nothing here writes. The caller decides what a state MEANS for its route
 * (create, link, propose) under the identity locks (./locks.ts).
 */

import type { TenantTx } from "@/lib/tenant/transaction";
import { hashIdentifier, type Identifier } from "./identifiers";

export const IDENTITY_POLICY_VERSION = "identity-policy@1";

export type IdentityState = "resolved" | "candidate" | "ambiguous" | "unresolved" | "conflict" | "not_applicable";

/** How an identifier matched. Categories only — never a value. */
export type MatchBasis = "customer_phone" | "phone_link" | "provider_link" | "email_link" | "customer_email";

export type IdentityCandidate = { customerId: number; bases: MatchBasis[] };

export type IdentityResult = {
  state: IdentityState;
  policyVersion: string;
  /** Set only when state = resolved. */
  customerId: number | null;
  /** Every Customer any identifier pointed at (resolved/candidate/ambiguous/conflict). */
  candidates: IdentityCandidate[];
  /** Evidence categories for explanation and logs. */
  evidence: {
    identifierKinds: string[];
    strongBases: MatchBasis[];
    weakBases: MatchBasis[];
    conflict: boolean;
  };
};

/** Max candidates a weak email may surface before we stop listing (ambiguity is already proven). */
const MAX_WEAK = 5;

export async function resolveIdentity(
  tx: TenantTx,
  businessId: number,
  identifiers: Identifier[]
): Promise<IdentityResult> {
  const kinds = [...new Set(identifiers.map((i) => i.kind))].sort();
  if (identifiers.length === 0) {
    return {
      state: "not_applicable",
      policyVersion: IDENTITY_POLICY_VERSION,
      customerId: null,
      candidates: [],
      evidence: { identifierKinds: [], strongBases: [], weakBases: [], conflict: false },
    };
  }

  const strong = new Map<number, Set<MatchBasis>>();
  const weak = new Map<number, Set<MatchBasis>>();
  const add = (m: Map<number, Set<MatchBasis>>, id: number, b: MatchBasis) => {
    const set = m.get(id) ?? new Set<MatchBasis>();
    set.add(b);
    m.set(id, set);
  };

  for (const id of identifiers) {
    const hashed = hashIdentifier(id);
    const link = await tx.identityLink.findFirst({
      where: { businessId, kind: hashed.kind, scope: hashed.scope, valueHash: hashed.valueHash, status: "active" },
      select: { customerId: true },
    });
    if (id.kind === "phone") {
      const customer = await tx.customer.findFirst({ where: { businessId, phone: id.value }, select: { id: true } });
      if (customer) add(strong, customer.id, "customer_phone");
      if (link) add(strong, link.customerId, "phone_link");
    } else if (id.kind === "provider") {
      if (link) add(strong, link.customerId, "provider_link");
    } else {
      if (link) add(strong, link.customerId, "email_link");
      // Customer.email is free text: compare normalized, tenant-scoped, bounded.
      const rows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "Customer"
         WHERE "businessId" = ${businessId}
           AND "email" IS NOT NULL
           AND lower(btrim("email")) = ${id.value}
         ORDER BY "id"
         LIMIT ${MAX_WEAK + 1}`;
      for (const r of rows) add(weak, r.id, "customer_email");
    }
  }

  const strongIds = [...strong.keys()].sort((a, b) => a - b);
  // A weak match on a Customer the strong evidence already names only agrees.
  const weakOthers = [...weak.keys()].filter((c) => !strong.has(c)).sort((a, b) => a - b);

  const candidates: IdentityCandidate[] = [...new Set([...strongIds, ...weakOthers])]
    .slice(0, MAX_WEAK + 2)
    .map((customerId) => ({
      customerId,
      bases: [...(strong.get(customerId) ?? []), ...(weak.get(customerId) ?? [])].sort() as MatchBasis[],
    }));
  const strongBases = [...new Set([...strong.values()].flatMap((s) => [...s]))].sort() as MatchBasis[];
  const weakBases = [...new Set([...weak.values()].flatMap((s) => [...s]))].sort() as MatchBasis[];
  const base = { policyVersion: IDENTITY_POLICY_VERSION, candidates };

  if (strongIds.length > 1 || (strongIds.length === 1 && weakOthers.length > 0)) {
    return {
      ...base,
      state: "conflict",
      customerId: null,
      evidence: { identifierKinds: kinds, strongBases, weakBases, conflict: true },
    };
  }
  if (strongIds.length === 1) {
    return {
      ...base,
      state: "resolved",
      customerId: strongIds[0],
      evidence: { identifierKinds: kinds, strongBases, weakBases, conflict: false },
    };
  }
  if (weakOthers.length === 1) {
    return {
      ...base,
      state: "candidate",
      customerId: null,
      evidence: { identifierKinds: kinds, strongBases, weakBases, conflict: false },
    };
  }
  if (weakOthers.length > 1) {
    return {
      ...base,
      state: "ambiguous",
      customerId: null,
      evidence: { identifierKinds: kinds, strongBases, weakBases, conflict: false },
    };
  }
  return {
    ...base,
    state: "unresolved",
    customerId: null,
    evidence: { identifierKinds: kinds, strongBases, weakBases, conflict: false },
  };
}
