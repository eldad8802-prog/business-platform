/**
 * M7 · Snapshot assembly — stored knowledge + domain state in, one business's snapshot out. PURE.
 *
 * The order of operations is the contract:
 *   1. every governed source becomes typed KnowledgeItems (or KnowledgeGaps, never both)
 *   2. items sharing a semantic slot are DEDUPLICATED (same value → one item, all provenance kept)
 *      or held as a CONFLICT (different values → both kept, UNRESOLVED)
 *   3. authority-vs-machine disagreements become conflicts with the authoritative side PREVAILING
 *   4. identity becomes relationships — ACTIVE only by owner confirmation or tax id
 *   5. cross-domain rules run over the deduplicated, fresh premises
 *   6. gaps are normalised (one per rule and reason), blocked families are stated
 *   7. everything is ordered by slot, bounded, and fingerprinted over its SEMANTIC content only
 *
 * Business Brain (bks.v2) adds, without new statistics or thresholds:
 *   1b' TEMPORAL_STATE — one interpreted state per temporal series (temporal/interpret.ts)
 *   1g  memory — HISTORICAL_MEASURE / PREVIOUS_BASELINE: what used to be known; never fresh, never a premise
 *   4'  RECORD_LINK relationships — what the product's own foreign keys assert, aggregated per entity
 */
import { evaluateTrustClaim } from "@/lib/services/trust/trust-claim.service";
import { createHash } from "node:crypto";
import {
  PREMISE_MAX_AGE_DAYS,
  SNAPSHOT_BOUNDS,
  SNAPSHOT_CONTRACT_VERSION,
  type AuthorityClass,
  type BusinessKnowledgeSnapshot,
  type ConflictItem,
  type CrossDomainFinding,
  type KnowledgeGap,
  type KnowledgeItem,
  type KnowledgeKind,
  type RelationshipItem,
} from "./snapshot.contract";
import { CROSS_DOMAIN_FAMILIES, CROSS_DOMAIN_RULES } from "./cross-domain";
import type { DomainState, StoredKnowledge } from "./snapshot-sources";
import { learnFromOutcomes } from "../outcomes/learn";
import { interpretSeries, type SeriesRow } from "../temporal/interpret";
import { temporalCatalogue } from "../temporal/rules";

/** Depth inputs are optional so stored-knowledge fixtures written before bks.v2 still assemble. */
const NO_DEPTH = { historicalMeasures: [], previousBaselines: [], links: [], receivablesWindow: null } as const;

const DAY = 86_400_000;

export function stable(v: unknown): string {
  if (v === null || v === undefined || typeof v !== "object") {
    return JSON.stringify(v === undefined ? null : v instanceof Date ? v.toISOString() : v);
  }
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ageDays = (asOf: Date, t: Date) => Math.max(0, Math.floor((asOf.getTime() - t.getTime()) / DAY));


type Draft = Omit<KnowledgeItem, "provenance" | "conflictIds"> & { provenance: KnowledgeItem["provenance"] };

/** Facts whose truth a known product defect can distort, stated with the item. */
const FACT_CAVEATS: Record<string, string[]> = {
  "inventory-alerts": ["POS_HELD_SALE_STOCK_DEFECT_MAY_DISTORT_QUANTITIES"],
};

/**
 * Epistemic labels a RULE put on its own measure, carried as item caveats so they survive into the
 * Brain context (which sees caveats, never `detail`): an obligation closure is OWNER_ASSERTED — the
 * owner said so, nothing verified it. Closed set: an unknown label is not promoted.
 */
const MEASURE_CAVEATS = new Set(["OWNER_ASSERTED"]);
function measureCaveats(detail: unknown): string[] {
  const d = (detail ?? {}) as { caveat?: unknown; authority?: unknown };
  return [d.caveat, d.authority].filter((x): x is string => typeof x === "string" && MEASURE_CAVEATS.has(x)).sort();
}

export function assembleSnapshot(
  businessId: number,
  asOf: Date,
  stored: StoredKnowledge,
  domain: DomainState,
  opts: { includeGaps: boolean },
): Omit<BusinessKnowledgeSnapshot, "stats"> & { truncated: Record<string, number> } {
  const drafts: Draft[] = [];
  const gapsRaw: { slot: string; domain: string; key: string; ruleId: string | null; kind: KnowledgeGap["kind"]; reason: string; have: number | null; need: number | null; needSpanDays: number | null }[] = [];

  /* ── 1a. measures ── */
  for (const m of stored.measures) {
    const subject = m.entityType ? { type: m.entityType, id: m.entityId ?? 0 } : null;
    if (m.status !== "ACTIVE") {
      gapsRaw.push({
        slot: `gap|${m.measureKey}|INSUFFICIENT_EVIDENCE`, domain: m.measureKey.split(".")[0], key: m.measureKey,
        ruleId: m.policyVersion.policy.key, kind: "INSUFFICIENT_EVIDENCE", reason: "BELOW_MINIMUM_SUPPORT",
        have: m.observationCount, need: ((m.detail ?? {}) as { minSupport?: number }).minSupport ?? null, needSpanDays: null,
      });
      continue;
    }
    const age = ageDays(asOf, m.windowEnd);
    drafts.push({
      slot: `measure|${m.measureKey}|${m.entityType ?? ""}|${m.entityId ?? ""}`,
      kind: "MEASURE", domain: m.measureKey.split(".")[0], subject, key: m.measureKey,
      ruleId: m.policyVersion.policy.key, ruleVersion: m.policyVersion.version, authority: "KNOWLEDGE_MEASURE",
      value: { value: m.valueNumeric.toString(), unit: m.valueUnit, trend: m.trend, detail: m.detail },
      observationCount: m.observationCount, window: { start: m.windowStart.toISOString(), end: m.windowEnd.toISOString() },
      status: "ACTIVE", freshness: { ageDays: age, fresh: age <= PREMISE_MAX_AGE_DAYS },
      evidence: { fingerprint: m.evidenceFingerprint, refCount: m.observationCount }, caveats: measureCaveats(m.detail),
      provenance: [{ store: "KnowledgeMeasure", id: m.id }],
    });
  }

  /* ── 1b. temporal knowledge ── */
  const ruleCaveats = new Map(temporalCatalogue().map((r) => [r.temporalKey, [...(r.caveats ?? [])].sort()]));
  for (const t of stored.temporal) {
    const subject = t.entityType ? { type: t.entityType, id: t.entityId ?? 0 } : null;
    if (t.status === "STALE") continue; // read by the temporal interpretation below (GONE_QUIET)
    if (t.status !== "ACTIVE") {
      const r = (t.reason ?? {}) as { code?: string; have?: number; need?: number; needSpanDays?: number };
      gapsRaw.push({
        slot: `gap|${t.temporalKey}|${t.knowledgeType}|${r.code ?? "UNKNOWN"}`, domain: t.domain, key: `${t.temporalKey}.${t.knowledgeType}`,
        ruleId: t.policyVersion.policy.key, kind: "INSUFFICIENT_HISTORY", reason: r.code ?? "INSUFFICIENT_HISTORY",
        have: r.have ?? null, need: r.need ?? null, needSpanDays: r.needSpanDays ?? null,
      });
      continue;
    }
    // Freshness from the last time a derivation CONFIRMED it, not when it was first concluded.
    const age = ageDays(asOf, t.confirmedAt);
    drafts.push({
      slot: `temporal|${t.temporalKey}|${t.knowledgeType}|${t.entityType ?? ""}|${t.entityId ?? ""}|${t.contextKey}`,
      kind: t.knowledgeType as KnowledgeKind, domain: t.domain, subject, key: t.temporalKey,
      ruleId: t.policyVersion.policy.key, ruleVersion: t.policyVersion.version, authority: "TEMPORAL_DERIVATION",
      value: { valueKind: t.valueKind, unit: t.unit, contextKey: t.contextKey, baseline: t.baseline, recent: t.recent, finding: t.finding },
      observationCount: t.historyCount + t.recentCount,
      window: { start: t.historyStart.toISOString(), end: (t.recentEnd ?? t.asOf).toISOString() },
      status: "ACTIVE", freshness: { ageDays: age, fresh: age <= PREMISE_MAX_AGE_DAYS },
      evidence: { fingerprint: t.evidenceFingerprint, refCount: t.historyCount + t.recentCount }, caveats: [...(ruleCaveats.get(t.temporalKey) ?? [])],
      provenance: [{ store: "TemporalKnowledge", id: t.id }],
    });
  }

  /* ── 1b'. temporal STATE per series (interpretation only; the engine already proved every input) ── */
  const meta = new Map(temporalCatalogue().map((r) => [r.temporalKey, { polarity: r.polarity ?? null, minRecent: r.spec.minRecent }]));
  const series = new Map<string, typeof stored.temporal>();
  for (const t of stored.temporal) {
    const k = `${t.temporalKey}|${t.entityType ?? ""}|${t.entityId ?? ""}|${t.contextKey}`;
    series.set(k, [...(series.get(k) ?? []), t]);
  }
  const hasBaseline = (rows: typeof stored.temporal) =>
    rows.some((t) => t.knowledgeType === "BASELINE" && (t.status === "ACTIVE" || t.status === "STALE"));
  for (const [k, rows] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = rows[0];
    const m = meta.get(first.temporalKey);
    if (!m) continue; // a stored key no current rule produces: it is history, not a current state
    // "established history for this key" must come from ANOTHER subject of the same rule, never from this series
    const keyEstablished = [...series.entries()].some(([k2, r2]) => k2 !== k && r2[0].temporalKey === first.temporalKey && hasBaseline(r2));
    const st = interpretSeries(rows as unknown as SeriesRow[], m.polarity, m.minRecent, keyEstablished);
    if (!st || st.state === "INSUFFICIENT_HISTORY") continue; // already stated as a gap above
    const used = rows.filter((t) => st.basedOn.includes(t.id));
    const confirmed = used.reduce((mx, t) => Math.max(mx, t.confirmedAt.getTime()), 0);
    const age = ageDays(asOf, new Date(confirmed || asOf.getTime()));
    drafts.push({
      slot: `tstate|${k}`, kind: "TEMPORAL_STATE", domain: first.domain,
      subject: first.entityType ? { type: first.entityType, id: first.entityId ?? 0 } : null, key: first.temporalKey,
      ruleId: first.policyVersion.policy.key, ruleVersion: first.policyVersion.version, authority: "TEMPORAL_DERIVATION",
      value: { state: st.state, direction: st.direction, changeKind: st.changeKind, polarity: st.polarity, normalSince: st.normalSince,
        historyObservations: st.historyObservations, recentObservations: st.recentObservations },
      observationCount: st.historyObservations + st.recentObservations, window: null, status: "ACTIVE",
      freshness: { ageDays: age, fresh: age <= PREMISE_MAX_AGE_DAYS && st.state !== "GONE_QUIET" },
      evidence: { fingerprint: null, refCount: st.basedOn.length }, caveats: [...(ruleCaveats.get(first.temporalKey) ?? [])],
      provenance: st.basedOn.map((id) => ({ store: "TemporalKnowledge" as const, id })),
    });
  }

  /* ── 1g. memory: what Dubiz USED to know. Never fresh (never a premise), never authoritative now. ── */
  const depth = stored.depth ?? NO_DEPTH;
  const memory: Draft[] = [];
  const seenHist = new Set<string>();
  for (const h of depth.historicalMeasures) { // newest first
    const subj = `${h.entityType ?? ""}|${h.entityId ?? ""}`;
    const k = `hist|${h.measureKey}|${subj}|${h.status}`;
    if (seenHist.has(k)) continue;
    seenHist.add(k);
    const rowsOf = depth.historicalMeasures.filter((x) =>
      x.measureKey === h.measureKey && `${x.entityType ?? ""}|${x.entityId ?? ""}` === subj && x.status === h.status).length;
    memory.push({
      slot: k, kind: "HISTORICAL_MEASURE", domain: h.measureKey.split(".")[0],
      subject: h.entityType ? { type: h.entityType, id: h.entityId ?? 0 } : null, key: h.measureKey,
      ruleId: h.policyVersion.policy.key, ruleVersion: h.policyVersion.version, authority: "KNOWLEDGE_MEASURE",
      // A STALE measure keeps its value: it was this rule's own answer until the subject went quiet. A
      // SUPERSEDED one does not: a different rule version's number is not comparable with today's.
      value: h.status === "STALE"
        ? { historicalState: "STALE", value: h.valueNumeric.toString(), unit: h.valueUnit, validUntil: h.windowEnd.toISOString(), rows: rowsOf }
        : { historicalState: "SUPERSEDED", unit: h.valueUnit, validUntil: h.windowEnd.toISOString(), rows: rowsOf },
      observationCount: h.observationCount, window: { start: h.windowStart.toISOString(), end: h.windowEnd.toISOString() },
      status: "ACTIVE", freshness: { ageDays: ageDays(asOf, h.windowEnd), fresh: false },
      evidence: { fingerprint: h.evidenceFingerprint, refCount: h.observationCount }, caveats: ["NOT_CURRENT_KNOWLEDGE"],
      provenance: [{ store: "KnowledgeMeasure", id: h.id }],
    });
  }
  const seenBase = new Set<string>();
  for (const b of depth.previousBaselines) { // newest first: the most recent previous "normal" per series
    const k = `prevbase|${b.temporalKey}|${b.entityType ?? ""}|${b.entityId ?? ""}|${b.contextKey}`;
    if (seenBase.has(k)) continue;
    seenBase.add(k);
    memory.push({
      slot: k, kind: "PREVIOUS_BASELINE", domain: b.domain,
      subject: b.entityType ? { type: b.entityType, id: b.entityId ?? 0 } : null, key: b.temporalKey,
      ruleId: b.policyVersion.policy.key, ruleVersion: b.policyVersion.version, authority: "TEMPORAL_DERIVATION",
      value: { valueKind: b.valueKind, unit: b.unit, contextKey: b.contextKey, baseline: b.baseline,
        normalFrom: b.historyStart.toISOString(), normalUntil: (b.supersededAt ?? b.historyEnd).toISOString() },
      observationCount: b.historyCount, window: { start: b.historyStart.toISOString(), end: b.historyEnd.toISOString() },
      status: "ACTIVE", freshness: { ageDays: ageDays(asOf, b.supersededAt ?? b.historyEnd), fresh: false },
      evidence: { fingerprint: b.evidenceFingerprint, refCount: b.historyCount }, caveats: ["NOT_CURRENT_KNOWLEDGE"],
      provenance: [{ store: "TemporalKnowledge", id: b.id }],
    });
  }
  // Memory has its own cap, newest first, so years of history can never crowd out current knowledge.
  const memoryKept = memory.slice(0, SNAPSHOT_BOUNDS.memory);
  const memoryDropped = memory.length - memoryKept.length;
  drafts.push(...memoryKept);

  /* ── 1c. derived claims (and their conflicts) ── */
  const conflicts: ConflictItem[] = [];
  const ownerCategory = new Map(stored.vendorCategories.map((v) => [v.vendorNameNormalized ?? "", v]));
  for (const c of stored.claims) {
    const owner = ownerCategory.get(c.subjectNormalizedKey);
    // A vendor's name is a counterparty label: the subject is the learned-vendor row id when known,
    // otherwise an opaque digest of the key. The name itself never enters the snapshot.
    const subject = owner ? { type: "vendor-learning", id: owner.id } : { type: "vendor-key", id: sha(c.subjectNormalizedKey).slice(0, 16) };
    const values = c.candidates.map((x) => x.propositionValue).sort();
    const slot = `claim|${c.subjectDomain}|${c.claimType}|${subject.type}|${subject.id}`;
    const age = ageDays(asOf, c.materializedAt);
    drafts.push({
      slot, kind: "CLAIM", domain: "documents", subject, key: c.claimType,
      ruleId: c.policyVersion.policy.key, ruleVersion: c.policyVersion.version, authority: "DERIVED_CLAIM",
      value: { candidates: values }, observationCount: null, window: null, status: "ACTIVE",
      freshness: { ageDays: age, fresh: age <= PREMISE_MAX_AGE_DAYS },
      evidence: { fingerprint: sha(c.evidenceSetFingerprint), refCount: null }, caveats: [],
      provenance: [{ store: "DerivedClaimProjection", id: c.id }],
    });
    if (values.length > 1) {
      conflicts.push({
        conflictId: `conflict|${slot}|COMPETING`, kind: "COMPETING_CLAIM_VALUES", slot, resolution: "UNRESOLVED", prevailing: null,
        sides: values.map((v) => ({ authority: "DERIVED_CLAIM" as AuthorityClass, value: { candidate: v }, provenance: [{ store: "DerivedClaimProjection" as const, id: c.id }] })),
      });
    }
    if (owner?.category && values.some((v) => v !== owner.category)) {
      conflicts.push({
        conflictId: `conflict|${slot}|OWNER`, kind: "MACHINE_VS_OWNER", slot,
        // Authority genuinely exists here: the owner's category comes from their own approvals.
        resolution: "RESOLVED_BY_AUTHORITY", prevailing: "OWNER_CONFIRMED",
        sides: [
          { authority: "OWNER_CONFIRMED", value: { category: owner.category }, provenance: [] },
          { authority: "DERIVED_CLAIM", value: { candidates: values }, provenance: [{ store: "DerivedClaimProjection", id: c.id }] },
        ],
      });
    }
  }

  /* ── 1d. owner decisions ── */
  for (const d of stored.decisions) {
    drafts.push({
      slot: `decision|insight|${d.id}`, kind: "OWNER_DECISION", domain: "insights", subject: { type: "insight", id: d.id },
      key: d.insightKey, ruleId: null, ruleVersion: d.composerVersion, authority: "OWNER_CONFIRMED",
      value: { decision: d.status }, observationCount: null, window: null, status: "ACTIVE",
      // A decision does not age into untruth; it is a fact about what the owner said, and when.
      freshness: { ageDays: d.ownerDecisionAt ? ageDays(asOf, d.ownerDecisionAt) : 0, fresh: true },
      evidence: { fingerprint: null, refCount: null }, caveats: [],
      provenance: [{ store: "BusinessInsight", id: d.id }],
    });
  }

  /* ── 1d'. P2 owner identity statements and identity-fact authorities ──
   * OWNER_CONFIRMED by construction. Every item points at its canonical row twice — the typed
   * `subject` and the `provenance` reference — so "which specialization" always resolves to one
   * BusinessIdentityStatement (resolveIdentityProvenance, within the same business). Coded dimensions
   * carry their code; text dimensions carry only that the statement exists and its public-use
   * authority — the text itself never enters the snapshot. Fact authorities enter only while the
   * canonical value still matches the approved one, and carry no value. Derived identity signals are
   * MACHINE_PROPOSALs and stay out until the owner adopts one (it then arrives as a statement). */
  for (const s of stored.identityStatements ?? []) {
    const slot = s.code !== null ? `identity|${s.dimension}|${s.code}` : `identity|${s.dimension}|statement|${s.id}`;
    drafts.push({
      slot, kind: "OWNER_DECISION", domain: "identity", subject: { type: "identity-statement", id: s.id },
      key: `identity.${s.dimension.toLowerCase()}`, ruleId: null, ruleVersion: null, authority: "OWNER_CONFIRMED",
      value: {
        dimension: s.dimension,
        ...(s.code !== null ? { code: s.code } : { hasText: true }),
        ...(s.channel ? { channel: s.channel } : {}),
        status: s.status,
        source: s.source,
        sourceRef: s.sourceRef,
        ownerConfirmed: true,
        confirmedByUserId: s.confirmedByUserId,
        publicUseApproved: s.code !== null ? false : s.publicUseApproved,
      },
      observationCount: null, window: null, status: "ACTIVE",
      freshness: { ageDays: ageDays(asOf, s.createdAt), fresh: true },
      evidence: { fingerprint: null, refCount: null }, caveats: [],
      provenance: [{ store: "BusinessIdentityStatement", id: s.id }],
    });
  }
  for (const f of stored.identityFacts ?? []) {
    if (!f.valueCurrent) continue; // the value changed since the decision: the authority has lapsed
    drafts.push({
      slot: `identity|FACT|${f.fact}`, kind: "OWNER_DECISION", domain: "identity", subject: { type: "identity-fact-authority", id: f.id },
      key: `identity.fact.${f.fact.toLowerCase()}`, ruleId: null, ruleVersion: null, authority: "OWNER_CONFIRMED",
      value: {
        fact: f.fact, sourceField: f.sourceField, status: "ACTIVE", valueCurrent: true,
        ownerConfirmed: true, confirmedByUserId: f.confirmedByUserId, publicUseApproved: f.publicUseApproved,
      },
      observationCount: null, window: null, status: "ACTIVE",
      freshness: { ageDays: ageDays(asOf, f.confirmedAt), fresh: true },
      evidence: { fingerprint: null, refCount: null }, caveats: [],
      provenance: [{ store: "BusinessIdentityFactAuthority", id: f.id }],
    });
  }

  /* ── 1d·P3-A. Owner trust claims ── OWNER_CONFIRMED items carrying the claim's kind, class and authority
   * flags with a stable provenance reference. Never the wording, the parameters or the private
   * document. A claim with an open lapse (expired, re-confirmation due, evidence no longer supporting
   * it) is NOT active owner-confirmed knowledge and stays out; a verification-required claim still
   * waiting for its document enters as unverified. Derived evidence never enters as a claim. */
  for (const c of stored.trustClaims ?? []) {
    const view = evaluateTrustClaim(c, { now: asOf, servedCustomers: stored.servedCustomers ?? null });
    if (view.issues.some((i) => i !== "NEEDS_DOCUMENT")) continue;
    drafts.push({
      slot: `trust|${c.claimKind}|${c.scopeKey}`, kind: "OWNER_DECISION", domain: "trust", subject: { type: "trust-claim", id: c.id },
      key: `trust.claim.${c.claimKind.toLowerCase()}`, ruleId: c.evidenceRuleId ?? null, ruleVersion: c.evidenceRuleVersion ?? null, authority: "OWNER_CONFIRMED",
      value: {
        claimKind: c.claimKind,
        claimClass: c.claimClass,
        ownerConfirmed: true,
        confirmedByUserId: c.confirmedByUserId,
        verificationRequired: view.verification.required,
        providedByBusiness: view.verification.provided,
        externallyVerified: false,
        publicUseApproved: c.publicUseApproved,
        publicEffective: view.publicEffective,
      },
      observationCount: null, window: null, status: "ACTIVE",
      freshness: { ageDays: ageDays(asOf, c.confirmedAt), fresh: true },
      evidence: { fingerprint: null, refCount: null }, caveats: view.verification.required ? ["provided by the business — not externally verified"] : [],
      provenance: [{ store: "BusinessTrustClaim", id: c.id }],
    });
  }

  /* ── 1e. L0 facts (authoritative domain state, structured fields only) ── */
  for (const f of domain.facts) {
    drafts.push({
      slot: `fact|${f.sourceEngine}|${f.entityRef.type}|${f.entityRef.id}`, kind: "FACT", domain: f.domain,
      subject: { type: f.entityRef.type, id: f.entityRef.id }, key: f.sourceEngine, ruleId: f.sourceEngine, ruleVersion: null,
      authority: "AUTHORITATIVE_DOMAIN_STATE",
      value: { category: f.semanticCategory, severity: f.severity, moneyImpactBand: f.moneyImpactBand, blocking: f.blocking,
        related: [...f.relatedRefs].sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id) },
      observationCount: null, window: null, status: "ACTIVE", freshness: { ageDays: 0, fresh: true },
      evidence: { fingerprint: null, refCount: null }, caveats: FACT_CAVEATS[f.sourceEngine] ?? [],
      provenance: [{ store: "BusinessStatus", id: f.itemId }],
    });
  }

  /* ── 1f. M9 outcome learning (memory, owner-behaviour and outcome patterns; gaps below threshold) ── */
  const learned = learnFromOutcomes(asOf, (stored.outcomes ?? []).map((r) => ({
    ...r, assessment: r.assessments[0] ?? null,
  })));
  drafts.push(...learned.items);
  gapsRaw.push(...learned.gaps);

  /* ── 2. deduplicate by semantic slot; divergent values become conflicts ── */
  const bySlot = new Map<string, Draft[]>();
  for (const d of drafts) {
    const list = bySlot.get(d.slot) ?? [];
    list.push(d);
    bySlot.set(d.slot, list);
  }
  const items: KnowledgeItem[] = [];
  for (const [slot, list] of [...bySlot.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const groups = new Map<string, Draft[]>();
    for (const d of list) {
      const h = sha(stable(d.value));
      groups.set(h, [...(groups.get(h) ?? []), d]);
    }
    const ids: string[] = conflicts.filter((c) => c.slot === slot).map((c) => c.conflictId);
    if (groups.size > 1) {
      const conflictId = `conflict|${slot}|DIVERGENT`;
      ids.push(conflictId);
      conflicts.push({
        conflictId, kind: "DIVERGENT_SAME_SLOT", slot, resolution: "UNRESOLVED", prevailing: null,
        sides: [...groups.values()].map((g) => ({ authority: g[0].authority, value: g[0].value, provenance: g.flatMap((x) => x.provenance) })),
      });
    }
    for (const g of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, g]) => g)) {
      const prov = g.flatMap((x) => x.provenance).sort((a, b) => `${a.store}:${a.id}`.localeCompare(`${b.store}:${b.id}`));
      items.push({ ...g[0], provenance: prov, conflictIds: [...ids].sort() });
    }
  }

  /* ── 4. identity relationships ── */
  const relationships: RelationshipItem[] = [];
  const claimsByParty = new Map<number, typeof stored.identity>();
  for (const c of stored.identity) claimsByParty.set(c.partyId, [...(claimsByParty.get(c.partyId) ?? []), c]);
  for (const [partyId, cs] of [...claimsByParty.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...cs].sort((a, b) => a.subjectType.localeCompare(b.subjectType) || a.subjectId - b.subjectId);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        const owner = a.method === "OWNER_CONFIRMED" || b.method === "OWNER_CONFIRMED";
        relationships.push({
          slot: `rel|party|${partyId}|${a.subjectType}:${a.subjectId}|${b.subjectType}:${b.subjectId}`,
          type: "SAME_COUNTERPARTY", left: { type: a.subjectType, id: a.subjectId }, right: { type: b.subjectType, id: b.subjectId },
          via: { type: "party", id: partyId }, status: "ACTIVE",
          authority: owner ? "OWNER_CONFIRMED" : "AUTHORITATIVE_IDENTIFIER",
          provenance: [{ store: "PartyResolutionClaim", id: a.id }, { store: "PartyResolutionClaim", id: b.id }],
        });
      }
    }
  }
  const authoritativelyBound = new Map(stored.identity.map((c) => [`${c.subjectType}:${c.subjectId}`, c.partyId]));
  for (const p of [...stored.proposals].sort((a, b) => a.id - b.id)) {
    relationships.push({
      slot: `rel|proposal|${p.id}`, type: "SAME_COUNTERPARTY",
      left: { type: p.subjectType, id: p.subjectId }, right: { type: "party", id: p.candidatePartyId },
      via: { type: "party", id: p.candidatePartyId },
      status: p.state === "REJECTED" ? "REJECTED" : "PROPOSED",
      authority: p.state === "REJECTED" ? "OWNER_CONFIRMED" : "MACHINE_PROPOSAL",
      provenance: [{ store: "EntityLinkProposal", id: p.id }],
    });
    const bound = authoritativelyBound.get(`${p.subjectType}:${p.subjectId}`);
    if (p.state === "PROPOSED" && bound != null && bound !== p.candidatePartyId) {
      conflicts.push({
        conflictId: `conflict|rel|proposal|${p.id}`, kind: "PROPOSAL_VS_AUTHORITATIVE_IDENTITY", slot: `rel|proposal|${p.id}`,
        resolution: "RESOLVED_BY_AUTHORITY", prevailing: "AUTHORITATIVE_IDENTIFIER",
        sides: [
          { authority: "AUTHORITATIVE_IDENTIFIER", value: { partyId: bound }, provenance: [] },
          { authority: "MACHINE_PROPOSAL", value: { partyId: p.candidatePartyId }, provenance: [{ store: "EntityLinkProposal", id: p.id }] },
        ],
      });
    }
  }
  /* ── 4'. RECORD_LINK — what the product's own foreign keys assert, one edge per entity and relation ── */
  for (const l of depth.links) {
    const right = l.right ?? { type: "records", id: l.relation };
    relationships.push({
      slot: `rel|fk|${l.relation}|${l.left.type}:${l.left.id}|${right.type}:${right.id}`, type: "RECORD_LINK",
      left: { type: l.left.type, id: l.left.id }, right, via: { type: "foreign-key", relation: l.relation },
      records: l.records, lastAt: l.lastAt ? l.lastAt.toISOString() : null,
      status: "ACTIVE", authority: "AUTHORITATIVE_DOMAIN_STATE",
      provenance: [{ store: "DomainRecordLink", id: `${l.relation}:${l.left.type}:${l.left.id}${l.right ? `:${l.right.type}:${l.right.id}` : ""}` }],
    });
  }
  // Identity relationships first, then record links, each by slot: a bound cuts the most numerous (links) last.
  relationships.sort((a, b) =>
    (a.type === "SAME_COUNTERPARTY" ? 0 : 1) - (b.type === "SAME_COUNTERPARTY" ? 0 : 1) || a.slot.localeCompare(b.slot));

  /* ── 5. cross-domain rules ── */
  const findings: CrossDomainFinding[] = [];
  const ruleGaps: KnowledgeGap[] = [];
  for (const rule of CROSS_DOMAIN_RULES) {
    const r = rule.evaluate({ asOf, items, relationships, domain, stored });
    findings.push(...r.findings);
    ruleGaps.push(...r.gaps);
  }
  findings.sort((a, b) => a.slot.localeCompare(b.slot));

  /* ── 6. gaps: one per (rule, reason), however many subjects share it ── */
  const gapMap = new Map<string, KnowledgeGap>();
  for (const g of gapsRaw) {
    const cur = gapMap.get(g.slot);
    if (!cur) {
      gapMap.set(g.slot, { ...g, subjectsAffected: 1, have: g.have == null ? null : { min: g.have, max: g.have } });
    } else {
      gapMap.set(g.slot, {
        ...cur, subjectsAffected: cur.subjectsAffected + 1,
        have: g.have == null ? cur.have : { min: Math.min(cur.have?.min ?? g.have, g.have), max: Math.max(cur.have?.max ?? g.have, g.have) },
      });
    }
  }
  for (const g of ruleGaps) gapMap.set(g.slot, g);
  for (const fam of CROSS_DOMAIN_FAMILIES) {
    if (fam.status === "READY") continue;
    gapMap.set(`gap|family|${fam.family}`, {
      slot: `gap|family|${fam.family}`, domain: "cross-domain", key: fam.name, ruleId: null, kind: "RULE_BLOCKED",
      reason: fam.status, subjectsAffected: 0, have: null, need: null, needSpanDays: null,
    });
  }
  const gaps = opts.includeGaps ? [...gapMap.values()].sort((a, b) => a.slot.localeCompare(b.slot)) : [];

  /* ── 7. bound, order, fingerprint ── */
  // Business-level knowledge first, then entity-level, each by slot — a deterministic order in which
  // a bound cuts the most specific (entity) knowledge last in line, and the cut is COUNTED.
  const ordered = [...items].sort((a, b) =>
    (a.subject == null ? 0 : 1) - (b.subject == null ? 0 : 1) || a.slot.localeCompare(b.slot));
  const cut = <T,>(xs: T[], n: number) => ({ kept: xs.slice(0, n), dropped: Math.max(0, xs.length - n) });
  const k = cut(ordered, SNAPSHOT_BOUNDS.knowledge);
  const r = cut(relationships, SNAPSHOT_BOUNDS.relationships);
  const f = cut(findings, SNAPSHOT_BOUNDS.crossDomainFindings);
  const c = cut([...conflicts].sort((a, b) => a.conflictId.localeCompare(b.conflictId)), SNAPSHOT_BOUNDS.conflicts);
  const g = cut(gaps, SNAPSHOT_BOUNDS.knowledgeGaps);

  const body = {
    contractVersion: SNAPSHOT_CONTRACT_VERSION as typeof SNAPSHOT_CONTRACT_VERSION,
    businessId,
    asOf: asOf.toISOString(),
    knowledge: k.kept,
    relationships: r.kept,
    crossDomainFindings: f.kept,
    conflicts: c.kept,
    knowledgeGaps: g.kept,
  };
  // SEMANTIC fingerprint: provenance row ids are dropped (a re-derived measure gets a new id but is the
  // same knowledge); evidence fingerprints, values, windows and statuses remain.
  const semantic = {
    ...body,
    knowledge: body.knowledge.map(({ provenance: _p, ...rest }) => rest),
    relationships: body.relationships.map(({ provenance: _p, ...rest }) => rest),
    crossDomainFindings: body.crossDomainFindings.map((x) => ({ ...x, premises: x.premises.map((p) => ({ slot: p.slot, authority: p.authority })) })),
    conflicts: body.conflicts.map((x) => ({ ...x, sides: x.sides.map((s) => ({ authority: s.authority, value: s.value })) })),
  };
  return {
    ...body,
    snapshotFingerprint: sha(stable(semantic)),
    truncated: { memory: memoryDropped, knowledge: k.dropped, relationships: r.dropped, crossDomainFindings: f.dropped, conflicts: c.dropped, knowledgeGaps: g.dropped },
  };
}


