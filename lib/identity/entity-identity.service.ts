/**
 * M5 · Entity identity for the spending side — supplier, payee, and the vendor on a document.
 *
 * THE PROBLEM
 *
 * The same real business shows up three times in Dubiz and the three never meet. It is a `Supplier`
 * when goods are ordered, a `Payee` when money goes out, and a string on `FinancialRecord.vendorName`
 * when an invoice is filed. Nothing joins them: `Payee` deliberately has no `supplierId` (that is a
 * documented architectural ruling, not an oversight), and a document has no vendor foreign key at
 * all. So "how often does this supplier bill us, and do we pay them late?" is two questions about two
 * subjects that happen to share a name.
 *
 * THE AUTHORITY MODEL, WHICH IS THE WHOLE DESIGN
 *
 *   MATCHING MAY PROPOSE.        A resemblance — a shared phone, a shared email domain, names that
 *                                normalize to the same string — produces an `EntityLinkProposal`.
 *                                A proposal changes NOTHING. No knowledge joins across it, no read
 *                                resolves through it, no record is merged. It is a question.
 *
 *   AUTHORITATIVE EVIDENCE MAY BIND. A tax id is not a resemblance. It is an identifier issued by
 *                                the state, and two subjects carrying the same one are the same
 *                                registered entity. That binds, immediately, recorded as
 *                                DETERMINISTIC_EXACT so the basis is auditable and reversible.
 *
 *   THE OWNER MAY BIND ANYTHING. Confirming a proposal retracts the subject's own anchor and writes
 *                                a claim with method OWNER_CONFIRMED. That is a merge of IDENTITY,
 *                                not of data: no row is combined, nothing is deleted, and the old
 *                                party survives. Rejecting records the refusal with the person, the
 *                                moment and their reason — and the resolver never asks again.
 *
 * WHAT WILL NEVER HAPPEN HERE: two entities merged because their names look alike. Not at high
 * confidence, not with a threshold, not "when the score is above 0.95". A correctly unresolved
 * identity is better than a false join, because a false join produces knowledge about a business
 * relationship that does not exist and there is no downstream check that can catch it.
 *
 * BUILT ON WHAT EXISTS. `Party` and `PartyResolutionClaim` shipped with a working resolution engine,
 * full tenant RLS and a verification harness — and a runtime write path that nothing ever called.
 * This wires that substrate up rather than inventing a second one, and it respects its invariant:
 * one party per subject, enforced by `createClaimTx`. That invariant is exactly why proposals need a
 * table of their own.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  createAnchorClaimTx,
  createClaimTx,
  createPartyTx,
  findCandidatePartyBySignalTx,
} from "@/lib/services/party/party-resolution.service";
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

export const IDENTITY_SOURCE = "m5-entity-identity";

/** The three spending-side subject kinds, in the canonical order proposals are oriented by. */
export const SUBJECT_ORDER = ["SUPPLIER", "PAYEE", "DOCUMENT_VENDOR"] as const;
export type SpendSubjectType = (typeof SUBJECT_ORDER)[number];

/** One thing that might be an entity, reduced to the signals it can be identified by. */
export type IdentitySubject = {
  readonly subjectType: SpendSubjectType;
  readonly subjectId: number;
  readonly displayName: string;
  readonly taxId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly normalizedName: string | null;
};

export type IdentityRunReport = {
  readonly businessId: number;
  readonly subjects: number;
  readonly anchored: number;
  readonly boundByTaxId: number;
  readonly proposed: number;
  readonly proposalsRefreshed: number;
  readonly skippedRejected: number;
  readonly durationMs: number;
};

function cleanId(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Email, lowercased and trimmed. Deliberately NOT split to a domain.
 *
 * Two suppliers can both be at `info@` a shared accountant's domain, and matching on the domain
 * alone would propose a relationship between every client that accountant has. The whole address is
 * a weak signal; the domain is not a signal at all.
 */
function cleanEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 && trimmed.includes("@") ? trimmed : null;
}

function cleanPhone(value: string | null | undefined): string | null {
  const normalized = normalizeCustomerPhone(value ?? null);
  return normalized && normalized.length > 0 ? normalized : null;
}

/**
 * The normalized name, or null when normalizing produced nothing usable.
 *
 * `normalizeVendorForLearning` already exists, already strips legal suffixes and noise words, and is
 * already what `VendorLearning.vendorNameNormalized` is computed with. Reusing it means a supplier
 * and a document vendor are normalized by the same rules — which is the minimum requirement for
 * comparing them at all.
 *
 * "unknown" is its fallback for an empty input and must never be treated as a match: every nameless
 * subject would otherwise resemble every other nameless subject.
 */
function normalizedNameOf(name: string): string | null {
  const key = normalizeVendorForLearning(name).normalizedKey;
  return key && key !== "unknown" ? key : null;
}

/** Read every spending-side subject this business has, tenant-scoped, in a canonical order. */
export async function loadIdentitySubjects(businessId: number): Promise<IdentitySubject[]> {
  return tenantTx(businessId, async (tx) => {
    const [suppliers, payees, vendors] = await Promise.all([
      tx.supplier.findMany({
        where: { businessId },
        orderBy: { id: "asc" },
        select: { id: true, name: true, legalName: true, taxId: true, phone: true, email: true },
      }),
      tx.payee.findMany({
        where: { businessId },
        orderBy: { id: "asc" },
        select: { id: true, displayName: true, legalName: true, taxId: true },
      }),
      tx.vendorLearning.findMany({
        where: { businessId },
        orderBy: { id: "asc" },
        select: { id: true, vendorName: true, vendorNameNormalized: true },
      }),
    ]);

    const out: IdentitySubject[] = [];
    for (const s of suppliers) {
      out.push({
        subjectType: "SUPPLIER",
        subjectId: s.id,
        displayName: s.name,
        taxId: cleanId(s.taxId),
        phone: cleanPhone(s.phone),
        email: cleanEmail(s.email),
        // The legal name is preferred for matching when present: it is what a tax authority and an
        // invoice header use, and it is the spelling a document is most likely to carry.
        normalizedName: normalizedNameOf(s.legalName ?? s.name),
      });
    }
    for (const p of payees) {
      out.push({
        subjectType: "PAYEE",
        subjectId: p.id,
        displayName: p.displayName,
        taxId: cleanId(p.taxId),
        phone: null,
        email: null,
        normalizedName: normalizedNameOf(p.legalName ?? p.displayName),
      });
    }
    for (const v of vendors) {
      out.push({
        subjectType: "DOCUMENT_VENDOR",
        subjectId: v.id,
        displayName: v.vendorName,
        // A vendor learned from a document has no identifiers at all. Only a name — which is exactly
        // why document vendors can never auto-bind and always need the owner.
        taxId: null,
        phone: null,
        email: null,
        normalizedName: v.vendorNameNormalized ?? normalizedNameOf(v.vendorName),
      });
    }
    return out;
  });
}

function rank(subjectType: SpendSubjectType): number {
  return SUBJECT_ORDER.indexOf(subjectType);
}

/**
 * Which of two subjects proposes to join the other.
 *
 * Canonical and total, so one pair yields exactly one proposal rather than two mirror images. The
 * later subject in (type rank, id) order proposes joining the earlier one's party, which also reads
 * the right way round: a document vendor proposes that it is a known supplier, not the reverse.
 */
function proposalDirection(
  a: IdentitySubject,
  b: IdentitySubject,
): { from: IdentitySubject; to: IdentitySubject } {
  const aKey: [number, number] = [rank(a.subjectType), a.subjectId];
  const bKey: [number, number] = [rank(b.subjectType), b.subjectId];
  const aFirst = aKey[0] !== bKey[0] ? aKey[0] < bKey[0] : aKey[1] < bKey[1];
  return aFirst ? { from: b, to: a } : { from: a, to: b };
}

type SignalKind = "PHONE" | "EMAIL" | "NORMALIZED_NAME";

/** The weak signals, in the order a proposal prefers to cite them. */
const WEAK_SIGNALS: readonly { kind: SignalKind; of: (s: IdentitySubject) => string | null }[] = [
  { kind: "PHONE", of: (s) => s.phone },
  { kind: "EMAIL", of: (s) => s.email },
  { kind: "NORMALIZED_NAME", of: (s) => s.normalizedName },
];

/**
 * Resolve every spending-side subject in one business: anchor it, bind it where a tax id says so,
 * and propose the rest.
 *
 * Idempotent. Running it twice changes nothing the second time: anchored subjects are skipped,
 * tax-id bindings already exist, and proposals are upserted onto their unique slot. That is what
 * makes it safe to run on every derivation.
 */
export async function resolveIdentitiesForBusiness(
  businessId: number,
): Promise<IdentityRunReport> {
  const started = Date.now();
  const subjects = await loadIdentitySubjects(businessId);

  let anchored = 0;
  let boundByTaxId = 0;
  let proposed = 0;
  let proposalsRefreshed = 0;
  let skippedRejected = 0;

  // ── Pass 1 · every subject gets a party ────────────────────────────────────────────────────
  //
  // Sequential rather than parallel, and that is load-bearing: two subjects with the same tax id
  // resolved concurrently would each find no candidate and each create a party, and the identifier
  // that should have joined them would have been defeated by a race.
  const partyOf = new Map<string, number>();
  for (const subject of subjects) {
    const key = `${subject.subjectType}:${subject.subjectId}`;
    const partyId = await tenantTx(businessId, async (tx) => {
      const existing = await tx.partyResolutionClaim.findFirst({
        where: {
          businessId,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          status: "ACTIVE",
        },
        select: { partyId: true },
      });
      if (existing) return existing.partyId;

      if (subject.taxId) {
        // A tax id is authoritative. If another subject already claims this one, they are the same
        // registered entity and this subject joins that party — no proposal, no owner, no threshold.
        const candidate = await findCandidatePartyBySignalTx(tx, businessId, "TAX_ID", subject.taxId);
        const party = candidate ?? (await createPartyTx(tx, businessId));
        await createClaimTx(tx, {
          businessId,
          partyId: party.id,
          subjectType: subject.subjectType,
          subjectId: subject.subjectId,
          signalType: "TAX_ID",
          signalValue: subject.taxId,
          confidence: "KNOWN",
          source: IDENTITY_SOURCE,
        });
        if (candidate) boundByTaxId += 1;
        else anchored += 1;
        return party.id;
      }

      // No authoritative identifier: the subject anchors to its own party, with NO signal written.
      // Writing a name or a phone as a claim signal would put a weak value into the index that
      // `findCandidatePartyBySignalTx` searches, and a later subject would bind to it automatically.
      // That is the fuzzy auto-merge this milestone forbids, so the signal columns stay null.
      const party = await createPartyTx(tx, businessId);
      await createAnchorClaimTx(tx, {
        businessId,
        partyId: party.id,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        source: IDENTITY_SOURCE,
      });
      anchored += 1;
      return party.id;
    });
    partyOf.set(key, partyId);
  }

  // ── Pass 2 · propose the resemblances ──────────────────────────────────────────────────────
  const seenPairs = new Set<string>();
  for (let i = 0; i < subjects.length; i += 1) {
    for (let j = i + 1; j < subjects.length; j += 1) {
      const a = subjects[i];
      const b = subjects[j];

      const signal = WEAK_SIGNALS.find((s) => {
        const av = s.of(a);
        const bv = s.of(b);
        return av != null && bv != null && av === bv;
      });
      if (!signal) continue;

      const aParty = partyOf.get(`${a.subjectType}:${a.subjectId}`);
      const bParty = partyOf.get(`${b.subjectType}:${b.subjectId}`);
      if (aParty == null || bParty == null) continue;
      // Already the same entity — by tax id, or because the owner said so earlier. Nothing to ask.
      if (aParty === bParty) continue;

      const { from, to } = proposalDirection(a, b);
      const candidatePartyId = partyOf.get(`${to.subjectType}:${to.subjectId}`);
      if (candidatePartyId == null) continue;

      const pairKey = `${from.subjectType}:${from.subjectId}->${candidatePartyId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const signalValue = signal.of(from);
      if (signalValue == null) continue;

      const outcome = await tenantTx(businessId, async (tx) => {
        const existing = await tx.entityLinkProposal.findUnique({
          where: {
            businessId_subjectType_subjectId_candidatePartyId: {
              businessId,
              subjectType: from.subjectType,
              subjectId: from.subjectId,
              candidatePartyId,
            },
          },
          select: { id: true, state: true },
        });

        // A refusal is permanent until the owner changes their own mind. Re-proposing a rejected pair
        // would turn a decision into a recurring prompt, which is how a system teaches people to
        // stop reading it.
        if (existing?.state === "REJECTED") return "skipped-rejected" as const;
        if (existing?.state === "CONFIRMED") return "skipped-confirmed" as const;

        if (existing) {
          await tx.entityLinkProposal.update({
            where: { id: existing.id },
            data: { signalType: signal.kind, signalValue, strength: "WEAK" },
          });
          return "refreshed" as const;
        }

        await tx.entityLinkProposal.create({
          data: {
            businessId,
            subjectType: from.subjectType,
            subjectId: from.subjectId,
            candidatePartyId,
            signalType: signal.kind,
            signalValue,
            // Every proposal is WEAK, and there is no code path that creates a STRONG one — a strong
            // identifier binds in pass 1 and never reaches here. The value exists in the enum so the
            // distinction is expressible if an authoritative-but-not-binding signal ever appears.
            strength: "WEAK",
            state: "PROPOSED",
          },
        });
        return "created" as const;
      });

      if (outcome === "created") proposed += 1;
      if (outcome === "refreshed") proposalsRefreshed += 1;
      if (outcome === "skipped-rejected") skippedRejected += 1;
    }
  }

  return {
    businessId,
    subjects: subjects.length,
    anchored,
    boundByTaxId,
    proposed,
    proposalsRefreshed,
    skippedRejected,
    durationMs: Date.now() - started,
  };
}

export type ProposalDecision = "CONFIRMED" | "REJECTED";

export type DecisionResult =
  | { ok: true; state: ProposalDecision }
  | { ok: false; reason: "not_found" | "already_decided" | "invalid_actor" };

/**
 * The owner's answer.
 *
 * CONFIRMING is the only automatic identity change in the system that a machine did not make, and it
 * is written as one: the subject's existing claims are RETRACTED rather than deleted, and a new claim
 * records the new binding with `OWNER_CONFIRMED` and the user who said so. Both halves are in one
 * transaction — a subject left with two active claims pointing at different parties would violate the
 * substrate's own invariant and the next `createClaimTx` would start refusing.
 *
 * REJECTING is evidence. It records who, when and why, and the resolver will not raise that pair
 * again. Silence is not rejection: an untouched proposal stays PROPOSED forever, and the difference
 * between "they said no" and "they never looked" stays visible, because those mean different things.
 *
 * `actorUserId` must be server-derived. A decision attributed to a user id that arrived in a request
 * body is not evidence of anything.
 */
export async function decideProposal(
  businessId: number,
  proposalId: number,
  decision: ProposalDecision,
  actorUserId: number,
  note?: string,
): Promise<DecisionResult> {
  if (!Number.isInteger(actorUserId) || actorUserId <= 0) {
    return { ok: false, reason: "invalid_actor" };
  }

  return tenantTx(businessId, async (tx) => {
    const proposal = await tx.entityLinkProposal.findFirst({
      where: { id: proposalId, businessId },
      select: {
        id: true,
        state: true,
        subjectType: true,
        subjectId: true,
        candidatePartyId: true,
        signalType: true,
        signalValue: true,
      },
    });
    if (!proposal) return { ok: false as const, reason: "not_found" as const };
    if (proposal.state !== "PROPOSED") {
      return { ok: false as const, reason: "already_decided" as const };
    }

    if (decision === "CONFIRMED") {
      await tx.partyResolutionClaim.updateMany({
        where: {
          businessId,
          subjectType: proposal.subjectType,
          subjectId: proposal.subjectId,
          status: "ACTIVE",
        },
        data: { status: "RETRACTED", resolvedByUserId: actorUserId },
      });
      await tx.partyResolutionClaim.create({
        data: {
          businessId,
          partyId: proposal.candidatePartyId,
          subjectType: proposal.subjectType,
          subjectId: proposal.subjectId,
          signalType: proposal.signalType,
          signalValue: proposal.signalValue,
          // KNOWN because a person established it — not because the signal was strong. The method
          // column is what records which of those two it was.
          confidence: "KNOWN",
          method: "OWNER_CONFIRMED",
          source: IDENTITY_SOURCE,
          resolvedByUserId: actorUserId,
          status: "ACTIVE",
        },
      });
    }

    await tx.entityLinkProposal.update({
      where: { id: proposal.id },
      data: {
        state: decision,
        decidedAt: new Date(),
        decidedByUserId: actorUserId,
        decisionNote: note?.trim() ? note.trim().slice(0, 500) : null,
      },
    });

    return { ok: true as const, state: decision };
  });
}

export type OpenProposal = {
  readonly id: number;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly candidatePartyId: number;
  readonly signalType: string;
  readonly strength: string;
  readonly createdAt: Date;
};

/** Everything still awaiting the owner, for this tenant only. */
export async function listOpenProposals(businessId: number): Promise<OpenProposal[]> {
  return tenantTx(businessId, (tx) =>
    tx.entityLinkProposal.findMany({
      where: { businessId, state: "PROPOSED" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        candidatePartyId: true,
        signalType: true,
        strength: true,
        createdAt: true,
      },
    }),
  );
}
