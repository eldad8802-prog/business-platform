/**
 * M7 · buildBusinessKnowledgeSnapshot — the ONE internal contract a future reasoning layer consumes.
 *
 *   businessId   mandatory, positive, server-derived; the only tenant this call can ever touch
 *   asOf         explicit instant for freshness, exposure and windows (defaults to now)
 *   includeGaps  whether knowledgeGaps are included (default true — "I don't know" is knowledge)
 *
 * No LLM, no embeddings, no cache, no writes. Reads current governed knowledge (not raw history), so
 * its cost is a fixed number of queries regardless of how many years of evidence the business has.
 * Logging the snapshot's CONTENTS is forbidden; only `stats` may be reported.
 */
import { assembleSnapshot, stable } from "./assemble";
import type { BusinessKnowledgeSnapshot } from "./snapshot.contract";
import { loadDomainState, loadStoredKnowledge } from "./snapshot-sources";

/** Stored-knowledge queries (9 in one tenant transaction) + the two domain engines. Fixed, not per row. */
const QUERY_BUDGET = 9;

export async function buildBusinessKnowledgeSnapshot(
  businessId: number,
  opts: { asOf?: Date; includeGaps?: boolean } = {},
): Promise<BusinessKnowledgeSnapshot & { buildMs: number }> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new Error("buildBusinessKnowledgeSnapshot: a positive, server-derived businessId is required");
  }
  const started = Date.now();
  const asOf = opts.asOf ?? new Date();
  const [stored, domain] = await Promise.all([
    loadStoredKnowledge(businessId, asOf),
    loadDomainState(businessId, asOf),
  ]);
  const { truncated, ...snapshot } = assembleSnapshot(businessId, asOf, stored, domain, {
    includeGaps: opts.includeGaps ?? true,
  });

  const sections = {
    knowledge: snapshot.knowledge,
    relationships: snapshot.relationships,
    crossDomainFindings: snapshot.crossDomainFindings,
    conflicts: snapshot.conflicts,
    knowledgeGaps: snapshot.knowledgeGaps,
  };
  const sizes = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, stable(v).length]));
  const largestSection = Object.entries(sizes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return {
    ...snapshot,
    stats: {
      counts: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])),
      truncated,
      serializedBytes: stable(snapshot).length,
      largestSection,
      queries: QUERY_BUDGET,
    },
    buildMs: Date.now() - started,
  };
}
