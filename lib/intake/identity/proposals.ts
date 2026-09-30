/**
 * Business Intake M4 · identity proposals — owner authority over uncertain identity.
 *
 *   Analyze → Propose → Track → Owner decides
 *
 * A proposal says: "this intake event may be about Customer X — here is the
 * evidence (categories), here is what confirming would link". Nothing is linked
 * or merged until the owner confirms.
 *
 *   confirm   staleness-checked, then: owner_confirmed links for the proposed
 *             identifiers, the event's Lead attached to the Customer (only if it
 *             is still contact-less), sibling proposals for the same event
 *             superseded. Every domain effect is recorded in appliedEffects.
 *   reject    keep separate. Nothing else changes.
 *   undo      a confirmed proposal: its links are revoked and exactly the
 *             recorded domain effects are reverted — never messages, never
 *             money, never the historical per-event evidence.
 *
 * STALE: the world moved since the proposal was made — an identifier it would
 * link is now held by ANOTHER Customer, or its Lead was already attached to
 * someone. A stale proposal is marked 'stale' and never applied. An optional
 * `expectedFingerprint` lets a UI refuse to apply what the owner did not see.
 *
 * All functions run in the caller's tenant context; the row lock (FOR UPDATE)
 * makes two concurrent decisions on one proposal serialise.
 */

import { appendLeadLifecycleEvent, lockLeadForLifecycle } from "@/lib/services/crm/lead-lifecycle.service";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withTenantTransaction, type TenantTx } from "@/lib/tenant/transaction";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { IDENTITY_POLICY_VERSION, type IdentityResult } from "./resolve";
import { ensureLinks, revokeProposalLinks, currentHolder } from "./links";
import type { HashedIdentifier } from "./identifiers";

export type ProposalReason = "candidate" | "ambiguous" | "conflict";

/** Max proposals one event may open (ambiguity beyond this is already proven). */
export const MAX_PROPOSALS_PER_EVENT = 5;

export function proposalFingerprint(args: {
  reason: ProposalReason;
  candidateIds: number[];
  links: HashedIdentifier[];
}): string {
  const canon = JSON.stringify({
    r: args.reason,
    c: [...args.candidateIds].sort((a, b) => a - b),
    l: args.links.map((l) => `${l.kind}|${l.scope}|${l.valueHash}`).sort(),
  });
  return `sha256:${createHash("sha256").update(canon, "utf8").digest("hex")}`;
}

/** Open (idempotently) one proposal per candidate for an uncertain event. */
export async function openProposals(
  tx: TenantTx,
  args: {
    businessId: number;
    intakeEventId: number;
    leadId: number | null;
    identity: IdentityResult;
    links: HashedIdentifier[];
  }
): Promise<number[]> {
  const reason = args.identity.state as ProposalReason;
  const candidateIds = args.identity.candidates.map((c) => c.customerId).slice(0, MAX_PROPOSALS_PER_EVENT);
  if (candidateIds.length === 0) return [];
  const fingerprint = proposalFingerprint({ reason, candidateIds, links: args.links });
  await tx.identityProposal.createMany({
    data: args.identity.candidates.slice(0, MAX_PROPOSALS_PER_EVENT).map((c) => ({
      businessId: args.businessId,
      intakeEventId: args.intakeEventId,
      candidateCustomerId: c.customerId,
      leadId: args.leadId,
      reason,
      proposedLinks: args.links as unknown as Prisma.InputJsonValue,
      evidence: {
        bases: c.bases,
        identifierKinds: args.identity.evidence.identifierKinds,
        conflict: args.identity.evidence.conflict,
        candidateCount: args.identity.candidates.length,
      },
      evidenceFingerprint: fingerprint,
      policyVersion: IDENTITY_POLICY_VERSION,
    })),
    skipDuplicates: true, // (businessId, intakeEventId, candidateCustomerId) unique
  });
  const rows = await tx.identityProposal.findMany({
    where: { businessId: args.businessId, intakeEventId: args.intakeEventId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

type LockedProposal = {
  id: number;
  intakeEventId: number;
  candidateCustomerId: number;
  leadId: number | null;
  reason: string;
  state: string;
  proposedLinks: Prisma.JsonValue | null;
  evidenceFingerprint: string;
  appliedEffects: Prisma.JsonValue | null;
};

async function lockProposal(tx: TenantTx, businessId: number, proposalId: number): Promise<LockedProposal | null> {
  const rows = await tx.$queryRaw<LockedProposal[]>`
    SELECT "id", "intakeEventId", "candidateCustomerId", "leadId", "reason", "state",
           "proposedLinks", "evidenceFingerprint", "appliedEffects"
      FROM "IdentityProposal"
     WHERE "id" = ${proposalId} AND "businessId" = ${businessId}
     FOR UPDATE`;
  return rows[0] ?? null;
}

function linksOf(p: LockedProposal): HashedIdentifier[] {
  return Array.isArray(p.proposedLinks) ? (p.proposedLinks as unknown as HashedIdentifier[]) : [];
}

export type DecisionOutcome =
  | { status: "confirmed" | "rejected" | "undone"; proposalId: number }
  | { status: "stale"; proposalId: number; why: string }
  | { status: "not_found" }
  | { status: "invalid_state"; state: string };

async function staleness(tx: TenantTx, businessId: number, p: LockedProposal): Promise<string | null> {
  for (const l of linksOf(p)) {
    if (!l.valueHash) return "evidence_erased";
    // A link OR (for a phone) a Customer row that appeared since the proposal.
    const holder = await currentHolder(tx, businessId, l);
    if (holder !== null && holder !== p.candidateCustomerId) return "identifier_now_held_by_another_customer";
  }
  if (p.leadId !== null) {
    const lead = await tx.lead.findFirst({ where: { id: p.leadId, businessId }, select: { customerId: true } });
    if (lead && lead.customerId !== null && lead.customerId !== p.candidateCustomerId) {
      return "lead_already_attached_to_another_customer";
    }
  }
  return null;
}

/** M5 — record an owner-decided contact relink on the lead's lifecycle history. */
async function recordContactStep(
  tx: Prisma.TransactionClient,
  businessId: number,
  leadId: number,
  kind: "contact_attached" | "contact_detached",
  proposalId: number,
  userId: number | null
): Promise<void> {
  const locked = await lockLeadForLifecycle(tx, businessId, leadId);
  if (!locked) return;
  await appendLeadLifecycleEvent(tx, locked, {
    kind,
    idempotencyKey: `identity-proposal:${proposalId}:${kind}`,
    actor: userId !== null ? { type: "OWNER_USER", userId } : { type: "SYSTEM" },
    source: userId !== null ? "OWNER_UI" : "SYSTEM",
    evidence: { kind: "identity_proposal", ref: String(proposalId) },
  });
}

export async function decideProposal(args: {
  businessId: number;
  proposalId: number;
  action: "confirm" | "reject" | "undo";
  userId: number | null;
  expectedFingerprint?: string;
  now?: Date;
}): Promise<DecisionOutcome> {
  const now = args.now ?? new Date();
  const outcome = await withTenantTransaction(async (tx): Promise<DecisionOutcome> => {
    const p = await lockProposal(tx, args.businessId, args.proposalId);
    if (!p) return { status: "not_found" };

    if (args.action === "undo") {
      if (p.state !== "confirmed") return { status: "invalid_state", state: p.state };
      await revokeProposalLinks(tx, { businessId: args.businessId, proposalId: p.id, userId: args.userId, now });
      const effects = (p.appliedEffects ?? {}) as { lead?: { id: number; previousCustomerId: number | null } };
      if (effects.lead) {
        // Revert only what this confirmation did, and only if nobody changed it since.
        const reverted = await tx.lead.updateMany({
          where: { id: effects.lead.id, businessId: args.businessId, customerId: p.candidateCustomerId },
          data: { customerId: effects.lead.previousCustomerId },
        });
        if (reverted.count === 1) {
          // M5 — the reversal is part of the lead's lifecycle history (once per proposal).
          await recordContactStep(tx, args.businessId, effects.lead.id, "contact_detached", p.id, args.userId);
        }
      }
      await tx.identityProposal.updateMany({
        where: { id: p.id, businessId: args.businessId },
        data: { state: "undone", decidedAt: now, decidedByUserId: args.userId },
      });
      return { status: "undone", proposalId: p.id };
    }

    if (p.state !== "proposed") return { status: "invalid_state", state: p.state };

    if (args.action === "reject") {
      await tx.identityProposal.updateMany({
        where: { id: p.id, businessId: args.businessId },
        data: { state: "rejected", decidedAt: now, decidedByUserId: args.userId },
      });
      return { status: "rejected", proposalId: p.id };
    }

    // confirm
    const why =
      args.expectedFingerprint && args.expectedFingerprint !== p.evidenceFingerprint
        ? "evidence_changed_since_shown"
        : await staleness(tx, args.businessId, p);
    if (why) {
      await tx.identityProposal.updateMany({
        where: { id: p.id, businessId: args.businessId },
        data: { state: "stale", decidedAt: now, decidedByUserId: args.userId },
      });
      return { status: "stale", proposalId: p.id, why };
    }

    await ensureLinks(tx, {
      businessId: args.businessId,
      customerId: p.candidateCustomerId,
      identifiers: linksOf(p),
      method: "owner_confirmed",
      sourceIntakeEventId: p.intakeEventId,
      proposalId: p.id,
    });
    const effects: { lead?: { id: number; previousCustomerId: number | null } } = {};
    if (p.leadId !== null) {
      const attached = await tx.lead.updateMany({
        where: { id: p.leadId, businessId: args.businessId, customerId: null },
        data: { customerId: p.candidateCustomerId },
      });
      if (attached.count === 1) {
        effects.lead = { id: p.leadId, previousCustomerId: null };
        await recordContactStep(tx, args.businessId, p.leadId, "contact_attached", p.id, args.userId);
      }
    }
    await tx.identityProposal.updateMany({
      where: { businessId: args.businessId, intakeEventId: p.intakeEventId, state: "proposed", id: { not: p.id } },
      data: { state: "superseded", decidedAt: now, decidedByUserId: args.userId },
    });
    await tx.identityProposal.updateMany({
      where: { id: p.id, businessId: args.businessId },
      data: {
        state: "confirmed",
        decidedAt: now,
        decidedByUserId: args.userId,
        appliedEffects: effects as Prisma.InputJsonValue,
      },
    });
    return { status: "confirmed", proposalId: p.id };
  });

  if (outcome.status === "confirmed" || outcome.status === "rejected" || outcome.status === "undone" || outcome.status === "stale") {
    await recordSensor({
      businessId: args.businessId,
      sensor: "IDENTITY_PROPOSAL_DECIDED",
      entityId: args.proposalId,
      actor: args.userId !== null ? { type: "OWNER_USER", userId: args.userId } : { type: "SYSTEM" },
      source: args.userId !== null ? "OWNER_UI" : "SYSTEM",
      occurredAt: now,
      idempotencyKey: `identity-proposal:${args.proposalId}:${outcome.status}`,
      payload: { action: args.action, outcome: outcome.status },
    });
  }
  return outcome;
}

/** Owner read model: open proposals (no identifier values — categories only). */
export async function listOpenProposals(businessId: number, limit = 50) {
  return withTenantTransaction((tx) =>
    tx.identityProposal.findMany({
      where: { businessId, state: "proposed" },
      orderBy: { id: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true,
        intakeEventId: true,
        candidateCustomerId: true,
        leadId: true,
        reason: true,
        evidence: true,
        evidenceFingerprint: true,
        createdAt: true,
      },
    })
  );
}
