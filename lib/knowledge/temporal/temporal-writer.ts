/**
 * M6 · The temporal writer — append-and-supersede, never overwrite, never delete.
 *
 * A SLOT is (business, temporalKey, entity, context, knowledgeType). For each artifact a derivation
 * produces:
 *
 *   same conclusion from the same evidence   → nothing new; the live row's confirmedAt moves forward.
 *                                              That is what makes a retry, or a daily re-run with no
 *                                              new evidence, a no-op instead of a new "fact".
 *   anything else                            → the live row becomes SUPERSEDED (kept, stamped), and a
 *                                              new row is appended. The baseline that WAS remains
 *                                              auditable next to the baseline that IS.
 *
 * And for slots the run did NOT produce (an anomaly that is no longer current, a pattern that stopped
 * holding): ACTIVE / INSUFFICIENT_HISTORY rows under the current version become STALE; rows under any
 * other version become SUPERSEDED. Nothing is deleted — the runtime role has no DELETE on this table.
 *
 * Tenant-bound: every read and write runs inside `tenantTx(businessId, …)`.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import type { TemporalArtifact } from "./temporal.contract";

export type TemporalSlotArtifact = TemporalArtifact & {
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly contextKey: string;
};

export type TemporalWriteInput = {
  readonly businessId: number;
  readonly temporalKey: string;
  readonly domain: string;
  readonly rulePolicyVersionId: number;
  readonly valueKind: string;
  readonly unit: string;
  readonly asOf: Date;
  readonly artifacts: readonly TemporalSlotArtifact[];
};

export type TemporalWriteOutcome = {
  readonly written: number;
  readonly confirmed: number;
  readonly superseded: number;
  readonly staled: number;
};

/** Deterministic JSON: keys sorted at every level, so equal content always hashes equal. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Identity of the EVIDENCE: the sorted set of contributing records. */
export function evidenceFingerprint(refs: readonly { kind: string; id: number }[]): string {
  return sha(refs.map((r) => `${r.kind}:${r.id}`).sort().join("|"));
}

/**
 * Identity of the CONCLUSION: type, status, summaries, finding, reason. Window dates are deliberately
 * excluded — tomorrow's run over the same evidence reaching the same conclusion is not a new fact.
 */
export function semanticHash(a: TemporalSlotArtifact): string {
  return sha(stable({
    t: a.knowledgeType, s: a.status, c: a.contextKey, b: a.baseline, r: a.recent, f: a.finding, x: a.reason,
  }));
}

const LIVE = ["ACTIVE", "INSUFFICIENT_HISTORY", "STALE"] as const;
const DEMOTABLE = ["ACTIVE", "INSUFFICIENT_HISTORY"] as const;

const slotKey = (a: { knowledgeType: string; entityType: string | null; entityId: number | null; contextKey: string }) =>
  `${a.knowledgeType}|${a.entityType ?? ""}|${a.entityId ?? ""}|${a.contextKey}`;

const json = (v: unknown) => (v == null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

export async function writeTemporalKnowledge(input: TemporalWriteInput): Promise<TemporalWriteOutcome> {
  const { businessId, temporalKey, rulePolicyVersionId } = input;
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("temporal writer: bad businessId");

  return tenantTx(businessId, async (tx) => {
    const now = new Date();
    let written = 0;
    let confirmed = 0;
    let superseded = 0;

    const live = await tx.temporalKnowledge.findMany({
      where: { businessId, temporalKey, status: { in: [...LIVE] } },
      select: {
        id: true, status: true, knowledgeType: true, entityType: true, entityId: true, contextKey: true,
        rulePolicyVersionId: true, semanticHash: true, evidenceFingerprint: true,
      },
    });
    const liveBySlot = new Map<string, (typeof live)[number]>();
    for (const row of live) {
      if (row.rulePolicyVersionId === rulePolicyVersionId) liveBySlot.set(slotKey(row), row);
    }

    const producedSlots = new Set<string>();
    for (const a of input.artifacts) {
      const key = slotKey(a);
      producedSlots.add(key);
      const fp = evidenceFingerprint(a.evidenceRefs);
      const sh = semanticHash(a);
      const current = liveBySlot.get(key);

      if (current && current.semanticHash === sh && current.evidenceFingerprint === fp) {
        await tx.temporalKnowledge.update({ where: { id: current.id }, data: { confirmedAt: now } });
        confirmed += 1;
        continue;
      }
      if (current) {
        await tx.temporalKnowledge.update({
          where: { id: current.id },
          data: { status: "SUPERSEDED", supersededAt: now },
        });
        superseded += 1;
      }
      await tx.temporalKnowledge.create({
        data: {
          businessId, temporalKey, domain: input.domain, rulePolicyVersionId,
          knowledgeType: a.knowledgeType, status: a.status,
          entityType: a.entityType, entityId: a.entityId, contextKey: a.contextKey,
          valueKind: input.valueKind, unit: input.unit, asOf: input.asOf,
          historyStart: a.historyStart, historyEnd: a.historyEnd,
          recentStart: a.recentStart, recentEnd: a.recentEnd,
          historyCount: a.historyCount, recentCount: a.recentCount,
          baseline: json(a.baseline), recent: json(a.recent), finding: json(a.finding), reason: json(a.reason),
          evidenceRefs: a.evidenceRefs as unknown as Prisma.InputJsonValue,
          evidenceFingerprint: fp, semanticHash: sh,
          materializedAt: now, confirmedAt: now,
        },
      });
      written += 1;
    }

    // Slots this run did not speak about. A different rule version is SUPERSEDED; the same version
    // with nothing to say any more is STALE. Neither is deleted.
    let staled = 0;
    for (const row of live) {
      if (!(DEMOTABLE as readonly string[]).includes(row.status)) continue;
      const otherVersion = row.rulePolicyVersionId !== rulePolicyVersionId;
      if (!otherVersion && producedSlots.has(slotKey(row))) continue;
      await tx.temporalKnowledge.update({
        where: { id: row.id },
        data: otherVersion ? { status: "SUPERSEDED", supersededAt: now } : { status: "STALE" },
      });
      if (otherVersion) superseded += 1;
      else staled += 1;
    }

    return { written, confirmed, superseded, staled };
  });
}
