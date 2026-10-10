import { createHash } from "node:crypto";
import type { BlueprintAction, BlueprintSection, LandingBlueprint } from "../composer/blueprint-assembly";
import { COMPOSER_CONTEXT_VERSION, assetRef, factRef, offeringRef, priceText, statementRef, trustRef, type LandingComposerContext } from "../composer/composer-context";
import type { LandingBusinessContext } from "../landing-business-context";
import { buildRenderModel, RENDERER_VERSION, RendererError, resolveAction, SUPPORTED_BLUEPRINT_VERSIONS, type RenderModel } from "../renderer/render-model";

/**
 * P3-E · Pure rules of a saved landing version. No database, no model, no clock.
 *
 *   - the snapshot is the validated P3-C blueprint, fingerprinted over a canonical (sorted-key) JSON;
 *   - SNAPSHOT INTEGRITY: is the stored snapshot still exactly what was saved, and can this code still
 *     render it? (fingerprint, versions, shape) — a property of the row, decided once;
 *   - CURRENT READINESS: would that snapshot still be publishable TODAY? Re-checked deterministically,
 *     with no AI, against current authority: assets still public-approved, trust claims still
 *     public-effective with the same wording, facts / statements still approved with the same value,
 *     offerings still presentable as saved, conversion destination still derivable, renderer support.
 *     It never changes the row: approval is never revoked automatically.
 */

export const LANDING_PERSISTENCE_VERSION = "p3e.persistence.v1";

/** The renderer versions a saved version may name. A version saved under anything else fails closed. */
export const SUPPORTED_RENDERER_VERSIONS: readonly string[] = [RENDERER_VERSION];

export type LandingVersionStatus = "DRAFT" | "APPROVED" | "SUPERSEDED" | "RETIRED";
export type LandingVersionAuthority = "OWNER_SAVED" | "OWNER_APPROVED";

/** Canonical JSON: object keys sorted at every level, so the fingerprint survives a jsonb round trip. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function snapshotFingerprint(snapshot: unknown): string {
  return createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex");
}

/**
 * The durable idempotency key of an operation. SAVE: one per (business, strategy, blueprint, page state) —
 * the same composition saved twice against the same state is one version. ROLLBACK: one per (business,
 * source, client action key) — a double submit of ONE owner action creates one version, a deliberate second
 * rollback creates another.
 */
export function idempotencyKey(parts: { businessId: number; operation: "SAVE_DRAFT" | "ROLLBACK"; strategyId: string; fingerprint: string; scope: string }): string {
  return createHash("sha256")
    .update(`p3e|${parts.businessId}|${parts.operation}|${parts.strategyId}|${parts.fingerprint}|${parts.scope}`, "utf8")
    .digest("hex");
}

/* ───────────────────────────── snapshot integrity ───────────────────────────── */

export type SavedVersionRow = {
  id: number;
  businessId: number;
  versionNumber: number;
  status: LandingVersionStatus;
  authority: LandingVersionAuthority;
  strategyId: string;
  strategyType: string;
  blueprintVersion: string;
  rendererVersion: string;
  blueprintSnapshot: unknown;
  sourceFingerprint: string;
};

export type SnapshotIntegrity = { ok: boolean; problems: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const isAction = (v: unknown) => v === null || (isObj(v) && typeof v.label === "string" && typeof v.channel === "string" && typeof v.objective === "string");

/** Structural check of a stored snapshot — enough for the renderer to be handed it safely. */
export function blueprintShapeProblems(bp: unknown): string[] {
  if (!isObj(bp)) return ["SNAPSHOT_NOT_OBJECT"];
  const p: string[] = [];
  for (const k of ["version", "strategyId", "strategyType", "pageIntent", "composerVersion", "promptVersion", "composerContextVersion", "strategyEngineVersion"]) {
    if (typeof bp[k] !== "string") p.push(`SNAPSHOT_FIELD:${k}`);
  }
  if (bp.authority !== "MACHINE_PROPOSAL") p.push("SNAPSHOT_AUTHORITY");
  if (typeof bp.businessId !== "number") p.push("SNAPSHOT_FIELD:businessId");
  if (typeof bp.surfaceOnly !== "boolean") p.push("SNAPSHOT_FIELD:surfaceOnly");
  if (!isObj(bp.metadata) || typeof bp.metadata.title !== "string" || typeof bp.metadata.description !== "string") p.push("SNAPSHOT_FIELD:metadata");
  if (!isObj(bp.hero) || typeof bp.hero.headline !== "string" || typeof bp.hero.subheadline !== "string" || !isAction(bp.hero.action ?? null)) p.push("SNAPSHOT_FIELD:hero");
  if (!Array.isArray(bp.sections) || bp.sections.some((s) => !isObj(s) || typeof s.sectionType !== "string" || typeof s.heading !== "string")) p.push("SNAPSHOT_FIELD:sections");
  if (!isAction(bp.primaryAction ?? null) || !isAction(bp.secondaryAction ?? null)) p.push("SNAPSHOT_FIELD:actions");
  for (const k of ["offeringRefs", "trustClaimRefs", "assetRefs", "factRefs", "statementRefs", "missingAssets", "publicationConstraints"]) {
    if (!isStrArr(bp[k])) p.push(`SNAPSHOT_FIELD:${k}`);
  }
  const r = bp.readiness;
  if (!isObj(r) || typeof r.publishReady !== "boolean" || !isStrArr(r.missingForPublication) || !isStrArr(r.warnings)) p.push("SNAPSHOT_FIELD:readiness");
  return p;
}

/** Is the stored row still exactly what was saved, and can this code render it? Fails closed. */
export function checkSnapshotIntegrity(row: SavedVersionRow): SnapshotIntegrity {
  const problems = blueprintShapeProblems(row.blueprintSnapshot);
  if (snapshotFingerprint(row.blueprintSnapshot) !== row.sourceFingerprint) problems.push("FINGERPRINT_MISMATCH");
  if (!SUPPORTED_BLUEPRINT_VERSIONS.includes(row.blueprintVersion)) problems.push("UNSUPPORTED_BLUEPRINT_VERSION");
  if (!SUPPORTED_RENDERER_VERSIONS.includes(row.rendererVersion)) problems.push("UNSUPPORTED_RENDERER_VERSION");
  const bp = row.blueprintSnapshot as Partial<LandingBlueprint> | null;
  if (isObj(bp)) {
    if (bp.businessId !== row.businessId) problems.push("SNAPSHOT_BUSINESS_MISMATCH");
    if (bp.strategyId !== row.strategyId || bp.strategyType !== row.strategyType || bp.version !== row.blueprintVersion) problems.push("SNAPSHOT_ROW_MISMATCH");
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** The readiness recorded INSIDE the snapshot when it was composed — never recomputed. */
export function snapshotReadiness(bp: LandingBlueprint): { publishReady: boolean; missingForPublication: string[]; warnings: string[] } {
  return { publishReady: bp.readiness.publishReady, missingForPublication: [...bp.readiness.missingForPublication], warnings: [...bp.readiness.warnings] };
}

/* ───────────────────────────── current readiness ───────────────────────────── */

export type CurrentReadiness = {
  publishReady: boolean;
  /** Current-authority problems found today (deterministic re-check, no AI). */
  blockers: string[];
  /** What the snapshot itself was missing when composed (content of the version; unchanged by today). */
  fromSnapshot: string[];
  checks: { assets: boolean; trust: boolean; facts: boolean; statements: boolean; offerings: boolean; conversion: boolean; renderer: boolean };
};

function sectionItems<T>(bp: LandingBlueprint, pick: (s: BlueprintSection) => T[] | undefined): T[] {
  return bp.sections.flatMap((s) => pick(s) ?? []);
}

/** Pure: re-check a saved snapshot against TODAY's authority. Never mutates; never revokes anything. */
export function computeCurrentReadiness(bp: LandingBlueprint, landing: LandingBusinessContext, rendererVersion: string): CurrentReadiness {
  const blockers: string[] = [];
  const pub = landing.publishable;

  // Assets: still public-use-approved.
  const approvedAssets = new Set(landing.assets.publicApproved.map((a) => assetRef(a.id)));
  const assetProblems = bp.assetRefs.filter((r) => !approvedAssets.has(r)).map((r) => `ASSET_NOT_PUBLIC_APPROVED:${r}`);

  // Trust: still public-effective, with the same canonical wording.
  const trustNow = new Map(pub.trustClaims.map((c) => [trustRef(c.id), c.wording]));
  const trustProblems = sectionItems(bp, (s) => s.trustClaims).flatMap((c) =>
    !trustNow.has(c.ref) ? [`TRUST_CLAIM_NOT_PUBLIC_EFFECTIVE:${c.ref}`] : trustNow.get(c.ref) !== c.wording ? [`TRUST_CLAIM_WORDING_CHANGED:${c.ref}`] : []);

  // Facts: still approved for public use, with the same value.
  const factsNow = new Map(pub.facts.map((f) => [factRef(f.key), f.value]));
  const factProblems = sectionItems(bp, (s) => s.facts).flatMap((f) =>
    !factsNow.has(f.ref) ? [`FACT_NOT_APPROVED:${f.key}`] : factsNow.get(f.ref) !== f.value ? [`FACT_VALUE_CHANGED:${f.key}`] : []);

  // Statements: still approved (and not awaiting claim review), with the same text.
  const statementsNow = new Map(pub.statements.map((s) => [statementRef(s.id), s.text]));
  const statementProblems = sectionItems(bp, (s) => s.statements).flatMap((x) =>
    !statementsNow.has(x.ref) ? [`STATEMENT_NOT_APPROVED:${x.ref}`] : statementsNow.get(x.ref) !== x.text ? [`STATEMENT_TEXT_CHANGED:${x.ref}`] : []);

  // Offerings: still an active, presentable catalog entry, presented as saved.
  const offeringsNow = new Map(landing.offerings.active.filter((o) => o.publiclyPresentable).map((o) => [offeringRef(o.kind, o.id), o]));
  const offeringProblems = sectionItems(bp, (s) => s.offerings).flatMap((o) => {
    const now = offeringsNow.get(o.ref);
    if (!now) return [`OFFERING_NOT_AVAILABLE:${o.ref}`];
    return now.name !== o.name || now.description !== o.description || priceText(now.priceMode, now.priceAmount, now.priceMax) !== o.priceText ? [`OFFERING_CHANGED:${o.ref}`] : [];
  });

  // Conversion: the action's destination is still derivable from approved facts (the same rule the renderer uses).
  const factList = pub.facts.map((f) => ({ key: f.key, value: f.value }));
  const conversionProblems: string[] = [];
  const checkAction = (a: BlueprintAction | null, which: string) => {
    if (!a) return;
    try {
      const r = resolveAction(a, factList);
      if (r && !r.available) conversionProblems.push(`CONVERSION_DESTINATION_MISSING:${which}:${r.missingDependency}`);
    } catch (e) {
      conversionProblems.push(`CONVERSION_UNSUPPORTED:${which}:${e instanceof RendererError ? e.code : "ERROR"}`);
    }
  };
  checkAction(bp.primaryAction, "PRIMARY");
  checkAction(bp.secondaryAction, "SECONDARY");

  // Renderer: this code still renders the snapshot's versions.
  const rendererProblems = [
    ...(SUPPORTED_BLUEPRINT_VERSIONS.includes(bp.version) ? [] : ["UNSUPPORTED_BLUEPRINT_VERSION"]),
    ...(SUPPORTED_RENDERER_VERSIONS.includes(rendererVersion) ? [] : ["UNSUPPORTED_RENDERER_VERSION"]),
  ];

  blockers.push(...assetProblems, ...trustProblems, ...factProblems, ...statementProblems, ...offeringProblems, ...conversionProblems, ...rendererProblems);
  const fromSnapshot = [...bp.readiness.missingForPublication];
  const uniq = [...new Set(blockers)].sort();
  return {
    publishReady: uniq.length === 0 && fromSnapshot.length === 0,
    blockers: uniq,
    fromSnapshot,
    checks: {
      assets: assetProblems.length === 0,
      trust: trustProblems.length === 0,
      facts: factProblems.length === 0,
      statements: statementProblems.length === 0,
      offerings: offeringProblems.length === 0,
      conversion: conversionProblems.length === 0,
      renderer: rendererProblems.length === 0,
    },
  };
}

/* ───────────────────────────── rendering a saved version ───────────────────────────── */

/**
 * The render context of a SAVED version: the snapshot's own strategy, and TODAY's approved facts and
 * public-approved assets (a destination or an image is never taken from the snapshot — it is re-derived
 * from current authority, exactly as for a fresh preview).
 */
export function savedVersionRenderContext(bp: LandingBlueprint, landing: LandingBusinessContext): LandingComposerContext {
  const facts = landing.publishable.facts.map((f) => ({ ref: factRef(f.key), key: f.key, value: f.value }));
  return {
    version: COMPOSER_CONTEXT_VERSION,
    language: "he",
    strategy: {
      id: bp.strategyId, type: bp.strategyType, objective: "", visitorIntent: "", narrativeApproach: "", proofEmphasis: "", trustEmphasis: "",
      sections: [], primaryAction: { kind: "NONE" }, secondaryAction: { kind: "NONE" }, publicationConstraints: [...bp.publicationConstraints],
    },
    businessName: facts.find((f) => f.key === "BUSINESS_NAME")?.value ?? null,
    facts,
    statements: [],
    trustClaims: [],
    offerings: [],
    assets: landing.assets.publicApproved.map((a) => ({ ref: assetRef(a.id), role: a.role, origin: a.origin, offeringRefs: a.linkedOfferings.map((l) => offeringRef(l.kind, l.id)) })),
  };
}

/**
 * The render VIEW of a saved snapshot: the snapshot itself, minus any image whose asset is no longer
 * public-approved (the preview shows the typographic fallback instead of a refused image). The stored
 * snapshot is never changed; this is a read-time projection.
 */
export function savedVersionRenderView(bp: LandingBlueprint, approvedAssetRefs: Set<string>): LandingBlueprint {
  const keep = <T extends { ref: string }>(a: T | null) => (a && approvedAssetRefs.has(a.ref) ? a : null);
  return {
    ...bp,
    hero: { ...bp.hero, asset: keep(bp.hero.asset) },
    sections: bp.sections.map((s) => (s.offerings ? { ...s, offerings: s.offerings.map((o) => ({ ...o, assets: o.assets.filter((a) => approvedAssetRefs.has(a.ref)) })) } : s)),
    assetRefs: bp.assetRefs.filter((r) => approvedAssetRefs.has(r)),
  };
}

/** Build the owner-preview render model of a saved version. Throws RendererError when it cannot (fails closed). */
export function renderSavedVersion(bp: LandingBlueprint, landing: LandingBusinessContext): RenderModel {
  const approved = new Set(landing.assets.publicApproved.map((a) => assetRef(a.id)));
  return buildRenderModel(savedVersionRenderView(bp, approved), savedVersionRenderContext(bp, landing));
}
