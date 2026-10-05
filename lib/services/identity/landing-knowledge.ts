/**
 * Landing knowledge — how far Dubiz's knowledge of a business has come toward the business's
 * FUTURE landing page, derived purely from the canonical BusinessIdentityContext (P3-A).
 *
 * Nothing is stored and nothing new is inferred here. It re-reads what already exists, in the
 * owner's terms:
 *
 *   chapters   four chapters of knowledge, each COMPLETE / IN_PROGRESS / MISSING by an explicit
 *              rule over owner statements, facts, trust claims and the conversion resolver.
 *              Deliberately NOT a percentage: there is no defensible weighting between, say,
 *              "who you serve" and "why choose you", so the model reports states and the count of
 *              complete chapters — both checkable by hand.
 *   told       what the owner stated or confirmed (authority: OWNER_CONFIRMED).
 *   learned    what Dubiz derived from real activity — the P2 deterministic signals, evidence
 *              thresholds already applied (authority: MACHINE_PROPOSAL). A suggestion becomes the
 *              owner's only through the existing adopt path; nothing here applies one.
 *   preview    the future page as SEMANTIC SECTIONS (hero, about, differentiators, trust,
 *              contact, call to action), each filled ONLY from `context.publicUse` — the single
 *              part of the context a public surface may read. A section with nothing approved
 *              reports what is missing instead of inventing copy.
 *
 * This is landing-page KNOWLEDGE, not the Profile's business-details completion (#653), not a
 * health or AI score. Publishing does not exist: `published` is always false.
 *
 * Future strategies (trust-first, conversion-first, discovery-first…) choose, order and phrase
 * these sections differently; the sections carry roles and provenance, never a layout, so a
 * strategy layer can be added on top without changing this model.
 */
import type { BusinessIdentityContext } from "./business-identity-context";

export const LANDING_KNOWLEDGE_VERSION = "landing-knowledge.v1";

export type ChapterKey = "who" | "audience" | "why" | "action";
export type ChapterState = "COMPLETE" | "IN_PROGRESS" | "MISSING";

/** What a chapter still needs, as codes the screen labels. */
export type ChapterNeed =
  | "DESCRIPTION"
  | "CATEGORY"
  | "TARGET_AUDIENCE"
  | "POSITIONING"
  | "DIFFERENTIATOR_OR_TRUST"
  | "PRIMARY_OBJECTIVE"
  | "USABLE_PATH";

export type Chapter = {
  key: ChapterKey;
  state: ChapterState;
  needs: ChapterNeed[];
  /** How many owner-provided items the chapter holds (statements, claims, declarations). */
  told: number;
};

export type LearnedSuggestion = { signalKey: string; kind: string; value: Record<string, string | number | boolean>; dimension: string; code: string };
export type LearnedObservation = { signalKey: string; kind: string; value: Record<string, string | number | boolean> };

export type PreviewRole = "HERO" | "ABOUT" | "DIFFERENTIATORS" | "TRUST" | "CONTACT" | "CALL_TO_ACTION";
export type PreviewStatus = "READY" | "NEEDS_APPROVAL" | "NEEDS_INPUT" | "NOT_AVAILABLE";

export type PreviewItem = {
  /** Where the text came from — always an approved public item. */
  source: "FACT" | "STATEMENT" | "TRUST_CLAIM" | "CONVERSION";
  key: string;
  text: string;
};

export type PreviewSection = {
  role: PreviewRole;
  status: PreviewStatus;
  items: PreviewItem[];
  /** Known material that exists but is not yet approved for public use. */
  awaitingApproval: number;
};

export type LandingKnowledge = {
  version: string;
  chapters: Chapter[];
  completeChapters: number;
  totalChapters: number;
  learned: { suggestions: LearnedSuggestion[]; observations: LearnedObservation[] };
  preview: { published: false; sections: PreviewSection[] };
};

const CHAPTER_ORDER: ChapterKey[] = ["who", "audience", "why", "action"];

function stateOf(needs: unknown[], started: boolean): ChapterState {
  if (needs.length === 0) return "COMPLETE";
  return started ? "IN_PROGRESS" : "MISSING";
}

export function buildLandingKnowledge(ctx: BusinessIdentityContext): LandingKnowledge {
  const { identity, trust, conversion } = ctx;
  const statementsIn = (d: string) => identity.statements.filter((s) => s.dimension === d);
  const has = (d: string) => statementsIn(d).length > 0;
  const category = identity.profile.find((p) => p.key === "category")?.value ?? null;

  // ── chapter 1 · who the business is ──
  const whoNeeds: ChapterNeed[] = [...(has("DESCRIPTION") ? [] : (["DESCRIPTION"] as const)), ...(category ? [] : (["CATEGORY"] as const))];
  const whoTold = statementsIn("DESCRIPTION").length + statementsIn("SPECIALIZATION").length + statementsIn("SERVICE_AREA").length;
  const who: Chapter = { key: "who", needs: whoNeeds, told: whoTold, state: stateOf(whoNeeds, whoTold > 0 || !!category) };

  // ── chapter 2 · who it wants to reach ──
  const audienceTold = statementsIn("TARGET_AUDIENCE").length;
  const audienceNeeds: ChapterNeed[] = audienceTold ? [] : ["TARGET_AUDIENCE"];
  const audience: Chapter = { key: "audience", needs: audienceNeeds, told: audienceTold, state: stateOf(audienceNeeds, false) };

  // ── chapter 3 · why choose it ──
  const differentiatorOrTrust = has("DIFFERENTIATOR") || trust.claims.length > 0;
  const whyNeeds: ChapterNeed[] = [...(has("POSITIONING") ? [] : (["POSITIONING"] as const)), ...(differentiatorOrTrust ? [] : (["DIFFERENTIATOR_OR_TRUST"] as const))];
  const whyTold = statementsIn("TONE").length + statementsIn("POSITIONING").length + statementsIn("DIFFERENTIATOR").length + trust.claims.length;
  const why: Chapter = { key: "why", needs: whyNeeds, told: whyTold, state: stateOf(whyNeeds, whyTold > 0) };

  // ── chapter 4 · what the customer should do ──
  const primaryUsable = typeof conversion.effectivePrimary === "object";
  const actionNeeds: ChapterNeed[] = [
    ...(has("PRIMARY_OBJECTIVE") ? [] : (["PRIMARY_OBJECTIVE"] as const)),
    ...(has("PRIMARY_OBJECTIVE") && !primaryUsable ? (["USABLE_PATH"] as const) : []),
  ];
  const actionTold = statementsIn("PRIMARY_OBJECTIVE").length + statementsIn("SECONDARY_OBJECTIVE").length + statementsIn("CONVERSION_DECLARATION").length;
  const action: Chapter = { key: "action", needs: actionNeeds, told: actionTold, state: stateOf(actionNeeds, actionTold > 0) };

  const byKey = { who, audience, why, action };
  const chapters = CHAPTER_ORDER.map((k) => byKey[k]);

  // ── learned: supported deterministic signals only ──
  const supported = identity.signals.filter((s) => s.status === "SUPPORTED");
  const suggestions: LearnedSuggestion[] = supported.flatMap((s) =>
    (s.suggestions as Array<{ dimension: string; code: string; alreadyConfirmed: boolean }>)
      .filter((g) => !g.alreadyConfirmed)
      .map((g) => ({ signalKey: s.key, kind: s.kind, value: s.value, dimension: g.dimension, code: g.code })),
  );
  const observations: LearnedObservation[] = supported.filter((s) => s.suggestions.length === 0).map((s) => ({ signalKey: s.key, kind: s.kind, value: s.value }));

  return {
    version: LANDING_KNOWLEDGE_VERSION,
    chapters,
    completeChapters: chapters.filter((c) => c.state === "COMPLETE").length,
    totalChapters: chapters.length,
    learned: { suggestions, observations },
    preview: { published: false, sections: buildPreview(ctx) },
  };
}

/** Sections filled from `publicUse` only. Unapproved material is counted, never shown. */
function buildPreview(ctx: BusinessIdentityContext): PreviewSection[] {
  const { identity, trust, publicUse } = ctx;
  const approvedFact = (k: string) => publicUse.facts.find((f) => f.key === k);
  const approvedStatements = (d: string) => publicUse.statements.filter((s) => s.key === d && !s.needsOwnerReview);
  const knownFact = (k: string) => identity.facts.find((f) => f.fact === k && f.value);
  const unapprovedStatements = (d: string) => identity.statements.filter((s) => s.dimension === d && s.text && !s.publicUseApproved).length;
  const unapprovedFact = (k: string) => (knownFact(k) && !approvedFact(k) ? 1 : 0);

  const section = (role: PreviewRole, items: PreviewItem[], awaitingApproval: number, notAvailable = false): PreviewSection => ({
    role,
    items,
    awaitingApproval,
    status: notAvailable ? "NOT_AVAILABLE" : items.length ? "READY" : awaitingApproval ? "NEEDS_APPROVAL" : "NEEDS_INPUT",
  });
  const factItem = (k: string): PreviewItem[] => {
    const f = approvedFact(k);
    return f ? [{ source: "FACT", key: k, text: f.value }] : [];
  };
  const statementItems = (d: string): PreviewItem[] => approvedStatements(d).map((s) => ({ source: "STATEMENT", key: d, text: s.value }));

  const hero = section("HERO", [...factItem("BUSINESS_NAME"), ...statementItems("DESCRIPTION")], unapprovedFact("BUSINESS_NAME") + unapprovedStatements("DESCRIPTION"));
  const about = section(
    "ABOUT",
    [...statementItems("SPECIALIZATION"), ...statementItems("SERVICE_AREA")],
    unapprovedStatements("SPECIALIZATION") + unapprovedStatements("SERVICE_AREA"),
  );
  const differentiators = section("DIFFERENTIATORS", statementItems("DIFFERENTIATOR"), unapprovedStatements("DIFFERENTIATOR"));
  const trustSection = section(
    "TRUST",
    publicUse.trustClaims.map((c) => ({ source: "TRUST_CLAIM" as const, key: c.kind, text: c.wording })),
    trust.claims.filter((c) => !c.publicEffective).length,
  );
  const contactKeys = ["PUBLIC_PHONE", "PUBLIC_WHATSAPP", "PUBLIC_EMAIL", "PUBLIC_ADDRESS", "OPENING_HOURS", "CITY"];
  const contact = section(
    "CONTACT",
    contactKeys.flatMap(factItem),
    contactKeys.reduce((n, k) => n + unapprovedFact(k), 0),
  );
  const primary = publicUse.conversion.effectivePrimary;
  const cta = section(
    "CALL_TO_ACTION",
    typeof primary === "object" ? [{ source: "CONVERSION", key: primary.objective, text: primary.channel ? `${primary.objective}:${primary.channel}` : primary.objective }] : [],
    0,
    typeof primary !== "object" && publicUse.conversion.fallback === "SURFACE_ONLY",
  );

  return [hero, about, differentiators, trustSection, contact, cta];
}
