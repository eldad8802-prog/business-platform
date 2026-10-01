import type { BusinessIdentityDimension } from "@prisma/client";

/**
 * P2 · Derived identity signals — pure, deterministic, never stored.
 *
 * A signal is DERIVED knowledge: what Dubiz can observe from the business's own facts and the
 * owner's own explicit choices. It is internal (authority MACHINE_PROPOSAL), never a public claim,
 * and it only becomes identity when the owner adopts one of its suggestions.
 *
 * WHAT IS DELIBERATELY NOT DERIVED
 *   - premium / value positioning from prices (a price level is not a positioning)
 *   - "popular" / "best-selling" / "trusted by" from demand counts (see DEMAND_CONCENTRATION caveat)
 *   - "fast service" from a quick appointment
 *   - any audience trait of a person: bot audience tags parents / young / seniors are ignored
 *   - tone or audience from a Content Studio run unless that run recorded the value as
 *     OWNER_SELECTED (lib/features/content/choice-provenance.ts). DEFAULTED tones, DERIVED
 *     (goal-computed) audiences, UNKNOWN and LEGACY_AMBIGUOUS runs (persisted before the marker)
 *     are never owner evidence and are never backfilled as such.
 * Below its minimum evidence a signal reports INSUFFICIENT_EVIDENCE and suggests nothing.
 *
 * Reproducibility: the inputs are durable rows (P1 offerings and demand signals, ContentRun /
 * ContentEvent, the bot profile); the rules are pure and versioned; an adoption records
 * `<version>|<signal key>><dimension>:<code>` so the exact rule that proposed it is named.
 */

export const SIGNAL_RULES_VERSION = "p2.signals.v2";

export const SIGNAL_WINDOW_DAYS = 180;

export type IdentityEvidence = {
  services: { id: number; active: boolean; categoryLabel: string | null; fulfillment: string; priceMode: string | null }[];
  products: { id: number; active: boolean; category: string | null }[];
  /** OfferingDemandSignal rows inside the window. Ids and types only. */
  demand: { offeringKind: "SERVICE" | "PRODUCT"; offeringId: number; signalType: string }[];
  /** ContentVariant.variantKey of VARIANT_SELECTED events inside the window. */
  variantSelections: string[];
  /** The owner's explicit bot-builder choices, already allow-listed. Null when there is no bot profile. */
  bot: { tone: string | null; audienceTags: string[]; priorities: string[] } | null;
  /**
   * Content runs inside the window: the tone / audience the run used and how each came to be.
   * Optional so older fixtures stay valid; absent means no content evidence.
   */
  contentChoices?: { tone: string | null; toneSource: string; audienceTypes: string[]; audienceSource: string }[];
};

export type SignalSuggestion = { dimension: BusinessIdentityDimension; code: string };

export type IdentitySignal = {
  /** Stable key: kind + value. The adoption endpoint recomputes signals and matches on it. */
  key: string;
  kind:
    | "OFFERING_MIX"
    | "CATEGORY_BREADTH"
    | "FULFILLMENT_MODE"
    | "QUOTE_PRICING"
    | "BOOKING_DEMAND"
    | "DEMAND_CONCENTRATION"
    | "CONTENT_VARIANT_PREFERENCE"
    | "CONTENT_TONE_PREFERENCE"
    | "CONTENT_AUDIENCE_PREFERENCE"
    | "BOT_TONE"
    | "BOT_AUDIENCE"
    | "BOT_PRIORITY";
  status: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  authority: "MACHINE_PROPOSAL";
  publicUse: "INTERNAL_ONLY";
  /** Structured value — never free text. */
  value: Record<string, string | number | boolean>;
  evidence: { source: string; observations: number; need: number | null };
  suggestions: SignalSuggestion[];
  caveats: string[];
};

const BOT_TONE_TO_TONE: Record<string, string> = { formal: "PROFESSIONAL", friendly: "WARM", casual: "FRIENDLY_CASUAL" };
/** Business-level tags only. parents / young / seniors describe people and are not mapped. */
const BOT_AUDIENCE_TO_AUDIENCE: Record<string, string> = {
  private: "INDIVIDUALS",
  business: "BUSINESSES",
  new_customers: "NEW_CUSTOMERS",
  returning_customers: "RETURNING_CUSTOMERS",
};
const BOT_PRIORITY_TO_POSITIONING: Record<string, string> = {
  fast_service: "SPEED",
  customer_experience: "PERSONAL_SERVICE",
};
/** Content Studio tone (vibeToTone output) → identity tone. */
const CONTENT_TONE_TO_TONE: Record<string, string> = { clear: "PROFESSIONAL", warm: "WARM", energetic: "ENERGETIC", premium: "PREMIUM" };
/** Content audience types that describe a customer relationship; funnel stages (interested/ready/all) are not identity. */
const CONTENT_AUDIENCE_TO_AUDIENCE: Record<string, string> = { new: "NEW_CUSTOMERS", existing: "RETURNING_CUSTOMERS" };

export const THRESHOLDS = {
  offeringMix: 3,
  categoryBreadth: 6,
  broadCategories: 4,
  quotePricing: 2,
  bookingDemand: 10,
  demandConcentration: 20,
  demandTopShare: 0.4,
  variantSelections: 5,
  variantTopShare: 0.6,
  contentOwnerChoices: 3,
  contentToneTopShare: 2 / 3,
} as const;

function signal(
  kind: IdentitySignal["kind"],
  status: IdentitySignal["status"],
  value: IdentitySignal["value"],
  evidence: IdentitySignal["evidence"],
  suggestions: SignalSuggestion[] = [],
  caveats: string[] = [],
): IdentitySignal {
  const valuePart = Object.keys(value)
    .sort()
    .map((k) => `${k}=${value[k]}`)
    .join(",");
  return {
    key: `${kind}:${status === "SUPPORTED" ? valuePart : "insufficient"}`,
    kind,
    status,
    authority: "MACHINE_PROPOSAL",
    publicUse: "INTERNAL_ONLY",
    value,
    evidence,
    suggestions: status === "SUPPORTED" ? suggestions : [],
    caveats,
  };
}

function topShare(counts: Map<string, number>): { key: string; count: number; total: number } | null {
  let total = 0;
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    total += count;
    if (!best || count > best.count) best = { key, count };
  }
  return best ? { ...best, total } : null;
}

export function deriveIdentitySignals(evidence: IdentityEvidence): IdentitySignal[] {
  const out: IdentitySignal[] = [];
  const services = evidence.services.filter((s) => s.active);
  const products = evidence.products.filter((p) => p.active);
  const offeringCount = services.length + products.length;

  // OFFERING_MIX — what the catalog is made of. Informational; objectives stay the owner's call.
  if (offeringCount < THRESHOLDS.offeringMix) {
    out.push(signal("OFFERING_MIX", "INSUFFICIENT_EVIDENCE", {}, { source: "offerings", observations: offeringCount, need: THRESHOLDS.offeringMix }));
  } else {
    const serviceShare = services.length / offeringCount;
    const mix = serviceShare >= 0.8 ? "SERVICE_LED" : serviceShare <= 0.2 ? "PRODUCT_LED" : "HYBRID";
    out.push(signal("OFFERING_MIX", "SUPPORTED", { mix, services: services.length, products: products.length }, { source: "offerings", observations: offeringCount, need: null }));
  }

  // CATEGORY_BREADTH — from the owner's own category labels only.
  const labels = [
    ...services.map((s) => s.categoryLabel?.trim().toLowerCase() || null),
    ...products.map((p) => p.category?.trim().toLowerCase() || null),
  ].filter((l): l is string => !!l);
  const distinct = new Set(labels).size;
  if (labels.length < THRESHOLDS.categoryBreadth) {
    out.push(signal("CATEGORY_BREADTH", "INSUFFICIENT_EVIDENCE", {}, { source: "offering categories", observations: labels.length, need: THRESHOLDS.categoryBreadth }));
  } else if (distinct >= THRESHOLDS.broadCategories) {
    out.push(signal("CATEGORY_BREADTH", "SUPPORTED", { breadth: "BROAD", categories: distinct }, { source: "offering categories", observations: labels.length, need: null }, [{ dimension: "POSITIONING", code: "BREADTH" }]));
  } else if (distinct === 1) {
    out.push(signal("CATEGORY_BREADTH", "SUPPORTED", { breadth: "FOCUSED", categories: 1 }, { source: "offering categories", observations: labels.length, need: null }, [{ dimension: "POSITIONING", code: "SPECIALIZATION" }], ["a focused catalog is not proof of expertise"]));
  } else {
    out.push(signal("CATEGORY_BREADTH", "SUPPORTED", { breadth: "MIXED", categories: distinct }, { source: "offering categories", observations: labels.length, need: null }));
  }

  // FULFILLMENT_MODE — the owner set it explicitly on a service (UNSPECIFIED is not evidence).
  for (const [mode, audience] of [["AT_CUSTOMER", "HOME_SERVICE_CUSTOMERS"], ["ONLINE", "REMOTE_CUSTOMERS"], ["AT_BUSINESS", "LOCAL_CUSTOMERS"]] as const) {
    const n = services.filter((s) => s.fulfillment === mode).length;
    if (n > 0) {
      out.push(signal("FULFILLMENT_MODE", "SUPPORTED", { fulfillment: mode, services: n }, { source: "service fulfillment", observations: n, need: null }, [{ dimension: "TARGET_AUDIENCE", code: audience }]));
    }
  }

  // QUOTE_PRICING — most priced services say "quote required".
  const priced = services.filter((s) => s.priceMode !== null);
  const quoted = priced.filter((s) => s.priceMode === "QUOTE_REQUIRED").length;
  if (quoted >= THRESHOLDS.quotePricing && quoted * 2 >= priced.length) {
    out.push(signal("QUOTE_PRICING", "SUPPORTED", { quoteRequired: quoted, priced: priced.length }, { source: "service price modes", observations: priced.length, need: null }, [{ dimension: "SECONDARY_OBJECTIVE", code: "REQUEST_QUOTE" }]));
  }

  // BOOKING_DEMAND — real appointments with an explicitly selected service.
  const bookings = evidence.demand.filter((d) => d.signalType === "BOOKING").length;
  if (bookings >= THRESHOLDS.bookingDemand) {
    out.push(signal("BOOKING_DEMAND", "SUPPORTED", { bookings }, { source: `booking signals, ${SIGNAL_WINDOW_DAYS}d`, observations: bookings, need: null }, [{ dimension: "TARGET_AUDIENCE", code: "APPOINTMENT_CUSTOMERS" }, { dimension: "SECONDARY_OBJECTIVE", code: "BOOK" }]));
  } else if (bookings > 0) {
    out.push(signal("BOOKING_DEMAND", "INSUFFICIENT_EVIDENCE", {}, { source: `booking signals, ${SIGNAL_WINDOW_DAYS}d`, observations: bookings, need: THRESHOLDS.bookingDemand }));
  }

  // DEMAND_CONCENTRATION — internal offering emphasis input. Never a popularity claim, never sets
  // featuredByOwner, suggests nothing.
  const demandTotal = evidence.demand.length;
  if (demandTotal >= THRESHOLDS.demandConcentration) {
    const counts = new Map<string, number>();
    for (const d of evidence.demand) counts.set(`${d.offeringKind}#${d.offeringId}`, (counts.get(`${d.offeringKind}#${d.offeringId}`) ?? 0) + 1);
    const top = topShare(counts)!;
    if (top.count / top.total >= THRESHOLDS.demandTopShare) {
      const [kind, id] = top.key.split("#");
      out.push(signal("DEMAND_CONCENTRATION", "SUPPORTED", { offeringKind: kind, offeringId: Number(id), sharePct: Math.round((top.count / top.total) * 100) }, { source: `demand signals, ${SIGNAL_WINDOW_DAYS}d`, observations: demandTotal, need: null }, [], ["internal emphasis input only — not evidence for a 'most popular' claim", "does not set featuredByOwner"]));
    }
  } else if (demandTotal > 0) {
    out.push(signal("DEMAND_CONCENTRATION", "INSUFFICIENT_EVIDENCE", {}, { source: `demand signals, ${SIGNAL_WINDOW_DAYS}d`, observations: demandTotal, need: THRESHOLDS.demandConcentration }));
  }

  // CONTENT_VARIANT_PREFERENCE — which generated variant the owner keeps picking. Informational.
  const picks = evidence.variantSelections.length;
  if (picks >= THRESHOLDS.variantSelections) {
    const counts = new Map<string, number>();
    for (const v of evidence.variantSelections) counts.set(v, (counts.get(v) ?? 0) + 1);
    const top = topShare(counts)!;
    if (top.count / top.total >= THRESHOLDS.variantTopShare) {
      out.push(signal("CONTENT_VARIANT_PREFERENCE", "SUPPORTED", { variantKey: top.key, sharePct: Math.round((top.count / top.total) * 100) }, { source: `content selections, ${SIGNAL_WINDOW_DAYS}d`, observations: picks, need: null }));
    }
  } else if (picks > 0) {
    out.push(signal("CONTENT_VARIANT_PREFERENCE", "INSUFFICIENT_EVIDENCE", {}, { source: `content selections, ${SIGNAL_WINDOW_DAYS}d`, observations: picks, need: THRESHOLDS.variantSelections }));
  }

  // CONTENT_TONE_PREFERENCE — only runs whose tone the owner explicitly selected.
  const choices = evidence.contentChoices ?? [];
  const ownerTones = choices.filter((c) => c.toneSource === "OWNER_SELECTED" && c.tone && CONTENT_TONE_TO_TONE[c.tone]);
  if (ownerTones.length >= THRESHOLDS.contentOwnerChoices) {
    const counts = new Map<string, number>();
    for (const c of ownerTones) counts.set(c.tone!, (counts.get(c.tone!) ?? 0) + 1);
    const top = topShare(counts)!;
    if (top.count / top.total >= THRESHOLDS.contentToneTopShare) {
      out.push(signal("CONTENT_TONE_PREFERENCE", "SUPPORTED", { contentTone: top.key, sharePct: Math.round((top.count / top.total) * 100) }, { source: `owner-selected content tones, ${SIGNAL_WINDOW_DAYS}d`, observations: ownerTones.length, need: null }, [{ dimension: "TONE", code: CONTENT_TONE_TO_TONE[top.key] }]));
    }
  } else if (ownerTones.length > 0) {
    out.push(signal("CONTENT_TONE_PREFERENCE", "INSUFFICIENT_EVIDENCE", {}, { source: `owner-selected content tones, ${SIGNAL_WINDOW_DAYS}d`, observations: ownerTones.length, need: THRESHOLDS.contentOwnerChoices }));
  }

  // CONTENT_AUDIENCE_PREFERENCE — only audiences the owner explicitly selected (none can be today:
  // the flow computes them from the goal and labels them DERIVED).
  const ownerAudiences = choices.filter((c) => c.audienceSource === "OWNER_SELECTED");
  const audienceCounts = new Map<string, number>();
  for (const c of ownerAudiences) for (const t of new Set(c.audienceTypes)) if (CONTENT_AUDIENCE_TO_AUDIENCE[t]) audienceCounts.set(t, (audienceCounts.get(t) ?? 0) + 1);
  for (const [t, n] of [...audienceCounts.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    if (n >= THRESHOLDS.contentOwnerChoices) {
      out.push(signal("CONTENT_AUDIENCE_PREFERENCE", "SUPPORTED", { contentAudience: t, runs: n }, { source: `owner-selected content audiences, ${SIGNAL_WINDOW_DAYS}d`, observations: n, need: null }, [{ dimension: "TARGET_AUDIENCE", code: CONTENT_AUDIENCE_TO_AUDIENCE[t] }]));
    }
  }

  // BOT_* — explicit owner choices made for the bot; offered for the whole business, never copied.
  if (evidence.bot) {
    const tone = evidence.bot.tone ? BOT_TONE_TO_TONE[evidence.bot.tone] : undefined;
    if (tone) out.push(signal("BOT_TONE", "SUPPORTED", { botTone: evidence.bot.tone! }, { source: "bot builder choice", observations: 1, need: null }, [{ dimension: "TONE", code: tone }]));
    for (const tag of [...new Set(evidence.bot.audienceTags)].sort()) {
      const code = BOT_AUDIENCE_TO_AUDIENCE[tag];
      if (code) out.push(signal("BOT_AUDIENCE", "SUPPORTED", { botAudience: tag }, { source: "bot builder choice", observations: 1, need: null }, [{ dimension: "TARGET_AUDIENCE", code }]));
    }
    for (const priority of [...new Set(evidence.bot.priorities)].sort()) {
      const code = BOT_PRIORITY_TO_POSITIONING[priority];
      if (code) out.push(signal("BOT_PRIORITY", "SUPPORTED", { botPriority: priority }, { source: "bot builder choice", observations: 1, need: null }, [{ dimension: "POSITIONING", code }], ["a bot priority is an aspiration the owner chose, not measured speed"]));
    }
  }

  return out;
}

/** The sourceRef stored on an adopted statement: rules version + signal key + the suggestion taken. */
export function suggestionRef(signalKey: string, s: SignalSuggestion): string {
  return `${SIGNAL_RULES_VERSION}|${signalKey}>${s.dimension}:${s.code}`.slice(0, 120);
}
