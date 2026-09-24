/**
 * M4 · The RULE contract — one shape every learning rule in the system conforms to.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is a contract: a rule declares who it is, what evidence it wants, how much of that evidence it
 * needs before it will say anything, over what horizon, and what makes its answer go out of date. It
 * is NOT a DSL. There is no expression language, no generic selector grammar, no rule interpreter.
 * Each rule's derivation stays ordinary TypeScript in its own file, because the domain knowledge in
 * "what counts as a late payment" is the valuable part and flattening it into configuration would
 * trade clarity for a uniformity nobody asked for.
 *
 * The one thing that IS uniform is the frame around the derivation, and that frame is what makes the
 * guarantees checkable in one place rather than re-argued per rule:
 *
 *   PROVENANCE      every output names its rule, its version, its window and its evidence
 *   SUPPORT         every rule states a minimum and returns INSUFFICIENT_EVIDENCE below it
 *   PURITY          `derive` sees rows and a clock reading; it cannot reach a database or `Date.now()`
 *   TENANCY         `load` is the ONLY seam that touches data, and it is tenant-bound
 *   FRESHNESS       every rule says, in words, what makes its answer stop being true
 *
 * WHY `derive` RETURNS AN ARRAY
 * A business-level rule ("how fast does this owner file paperwork") produces one measure. An
 * entity-level rule ("how regularly does this owner buy from each supplier") produces one PER
 * SUPPLIER, and the count is a property of the data, not of the rule. One return type covers both,
 * and the writer's slot key already carries `entityType`/`entityId`, so nothing downstream has to
 * know which kind it is looking at.
 */
import type { MeasureResult, MeasureUnit } from "./measure.contract";

/** The domains that can produce knowledge. A closed set: an unlisted domain is a typo, not a feature. */
export type KnowledgeDomain = "documents" | "payables" | "inventory" | "suppliers";

/**
 * What the measure is ABOUT, when it is not about the business as a whole.
 *
 * Governed strings rather than an enum in the database, for the reason `measureKey` is a string: the
 * set grows per milestone, and a migration per entity kind would be friction with no safety gain. But
 * governed HERE, so a rule cannot invent "vendour" and have it silently persist.
 *
 * `party` is the one that is not a domain row: a document's vendor is a STRING, not a record, so a
 * per-vendor measure has nothing to point at until the identity layer has anchored that string to a
 * `Party`. That is deliberate rather than awkward — it means a vendor-level habit can only exist for a
 * vendor Dubiz has actually resolved, and an unresolved vendor produces no knowledge instead of
 * knowledge attached to a spelling.
 */
export type KnowledgeEntityType = "supplier" | "payee" | "inventory-item" | "party";

/**
 * Why a rule's answer can stop being authoritative.
 *
 * Stated per rule and carried into the stored measure's detail, so a consumer can be told not just
 * that something is STALE but what kind of change made it so. These are the shapes that actually
 * occur in this codebase; the list is closed on purpose, and a rule needing a new one is a design
 * conversation rather than a string.
 */
export type FreshnessTrigger =
  /** Newer evidence exists that the stored derivation did not see. */
  | "NEW_EVIDENCE"
  /** The window has rolled far enough that the stored one no longer describes the present. */
  | "WINDOW_ROLLED"
  /** The evidence the measure was built from was reversed, corrected or deleted. */
  | "EVIDENCE_REVERSED"
  /** The subject entity no longer exists, or no longer has evidence of its own. */
  | "ENTITY_GONE"
  /** The owner said something that overrides what was inferred. */
  | "OWNER_CORRECTION"
  /** The rule itself changed; the old version's output is superseded rather than merely stale. */
  | "RULE_VERSION_CHANGED";

/**
 * A rule's identity and its declared behaviour. Everything here is fixed at authoring time — nothing
 * in this record may vary per business, which is what makes two tenants' results comparable in kind
 * (never in value: no baseline is ever computed across businesses).
 */
export type RuleDescriptor = {
  /** Catalogue identity, e.g. "AP-01". Stable across versions; it is the rule, not the release. */
  readonly ruleId: string;
  readonly domain: KnowledgeDomain;
  /** Identity of the OUTPUT, e.g. "payables.payment_timing". One rule, one measure key. */
  readonly measureKey: string;
  /**
   * The governed derivation-policy lineage this rule's version is pinned to. Resolved through the
   * existing policy registry — there is no second version registry, and a rule whose lineage is not
   * registered fails closed rather than writing an unversioned artifact.
   */
  readonly policyKey: string;
  readonly versionLabel: string;
  /** Null when the measure describes the business itself. */
  readonly entityType: KnowledgeEntityType | null;
  /** Below this many observations the rule returns INSUFFICIENT_EVIDENCE and stores it. */
  readonly minSupport: number;
  /** The rolling horizon, in days. Chosen per rule: a supplier cadence and a filing habit differ. */
  readonly windowDays: number;
  readonly valueUnit: MeasureUnit;
  /** Which of the closed triggers apply to this rule. Documentation that ships with the artifact. */
  readonly freshness: readonly FreshnessTrigger[];
  /** One sentence, in English, of what the rule claims. Rendered in reports; never shown to an owner. */
  readonly question: string;
};

/**
 * THE ONLY SEAM THAT TOUCHES DATA.
 *
 * It must be tenant-bound (`tenantTx`), and everything it returns must belong to `businessId`. The
 * writer re-checks that per evidence ref, because a loader bug would otherwise become a genuine
 * cross-tenant derivation — knowledge about A built partly from B — and no row-level policy can see
 * it, since the artifact's own `businessId` would look perfectly valid.
 *
 * It also receives `now`, so it can bound the query to the window instead of loading a tenant's whole
 * history and filtering in memory. The rules filter again to the same window, so the two must agree;
 * a source that loaded LESS than its rules' window would silently shrink the evidence set.
 */
export interface EvidenceSource<TObs> {
  /** Identity for de-duplication. Two rules naming the same key share one load per derivation run. */
  readonly key: string;
  /** The widest window any rule on this source needs, in days. The load is bounded by it. */
  readonly windowDays: number;
  load(businessId: number, now: Date): Promise<TObs[]>;
}

/**
 * A rule.
 *
 * `TObs` is the rule's own observation type — a small, explicit record built by `load` from whatever
 * rows the domain keeps. Rules never see Prisma models: a derivation that could reach a relation could
 * reach another tenant's, and an observation type that names its fields is a contract the rule's tests
 * can construct without a database.
 */
export interface KnowledgeRule<TObs> {
  readonly descriptor: RuleDescriptor;

  /**
   * Where the observations come from. Declared rather than performed, so that several rules reading
   * the same evidence cost one query between them instead of one each — four payables rules all
   * describe the same settlement history, and running that query four times would be a design that
   * gets slower every time the catalogue grows.
   */
  readonly source: EvidenceSource<TObs>;

  /**
   * PURE. Same observations plus the same `now` produce the same result, byte for byte, including the
   * evidence fingerprint. No clock, no database, no randomness, no dependence on the order rows
   * happened to arrive in — every rule sorts its own sample canonically before fingerprinting it.
   */
  derive(observations: readonly TObs[], now: Date): MeasureResult[];
}

/** Erase the observation type so rules of different shapes can live in one catalogue. */
export type AnyKnowledgeRule = {
  readonly descriptor: RuleDescriptor;
  readonly source: EvidenceSource<unknown>;
  derive(observations: readonly unknown[], now: Date): MeasureResult[];
};

/** Narrow a concrete rule into the catalogue's erased shape. Type-level only; no runtime cost. */
export function asCatalogueRule<TObs>(rule: KnowledgeRule<TObs>): AnyKnowledgeRule {
  return rule as unknown as AnyKnowledgeRule;
}

/**
 * The canonical detail payload for a refusal.
 *
 * Every rule's INSUFFICIENT_EVIDENCE says the same two things in the same two keys, so a consumer can
 * explain any silence in the system without knowing which rule produced it. "4 of the 5 needed" is a
 * sentence the product can render; an empty measure is one it has to apologise for.
 */
export function insufficientDetail(
  minSupport: number,
  have: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { minSupport, have, ...(extra ?? {}) };
}

/** Whole days between two instants, never negative. The shared unit for every temporal rule. */
export const DAY_MS = 86_400_000;

export function daysBetween(earlier: Date, later: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / DAY_MS);
}

/** Two decimal places. Applied to every stored value so rebuild comparisons are exact, not approximate. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
