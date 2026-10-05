import {
  CONVERSION_CHANNELS,
  OBJECTIVE_CHANNELS,
  OBJECTIVE_CODES,
  type ConversionChannelCode,
} from "@/lib/services/identity/identity-vocabulary";

/**
 * P3-A · Conversion resolver — pure, deterministic, computed on read, never stored.
 *
 * Conversion is OBJECTIVE × CHANNEL ("request a quote via WhatsApp"), never a bare CTA. Three things
 * are kept apart and never collapsed:
 *   CAPABILITY      what the business can actually fulfil now (public-use-approved facts, the real
 *                   WhatsApp connection, the owner's fulfilment declarations, what Dubiz supports);
 *   PREFERENCE      the owner's PRIMARY / SECONDARY objective (and its optional channel) — P2 rows;
 *   RECOMMENDATION  what the business's own evidence suggests, ONLY among usable paths.
 * A preference that cannot be fulfilled is surfaced as a CONFLICT and the effective primary is
 * UNRESOLVED (fallback SURFACE_ONLY) — never silently replaced by the recommendation.
 *
 *   connected WhatsApp ≠ the owner wants WhatsApp      a billing phone ≠ an approved public phone
 *   an address ≠ a storefront (ACCEPTS_VISITS)         products existing ≠ an online purchase
 *   "external shop" declaration ≠ a URL it may publish (no canonical public shop-link authority exists)
 */

export const CONVERSION_RULES_VERSION = "p3.conversion.v1";

/**
 * The official WhatsApp Business (Cloud API) path works in code but its Production message flow has
 * not been proven end to end. Until it is, a WHATSAPP_CLOUD path is PLATFORM_UNPROVEN: the owner may
 * choose it (it stays visibly flagged), Dubiz never recommends it.
 */
export const WHATSAPP_CLOUD_PLATFORM_PROVEN = false;

export type CapabilityState =
  | "AVAILABLE"
  | "AVAILABLE_UNOBSERVED"
  | "PLATFORM_UNPROVEN"
  | "DEGRADED"
  | "NOT_AUTHORIZED"
  | "NOT_DECLARED"
  | "NOT_CONFIGURED"
  | "NOT_SUPPORTED_BY_PLATFORM";

export type BlockingReason =
  | "PUBLIC_PHONE_NOT_APPROVED"
  | "PUBLIC_PHONE_MISSING"
  | "PUBLIC_EMAIL_NOT_APPROVED"
  | "PUBLIC_EMAIL_MISSING"
  | "PUBLIC_WHATSAPP_NOT_APPROVED"
  | "WHATSAPP_NOT_CONNECTED"
  | "WHATSAPP_CONNECTION_ERROR"
  | "WHATSAPP_ON_PHONE_NOT_DECLARED"
  | "ADDRESS_NOT_APPROVED"
  | "HOURS_NOT_APPROVED"
  | "VISITS_NOT_DECLARED"
  | "NO_CANONICAL_SHOP_LINK_AUTHORITY"
  | "WEB_FORM_NOT_ENABLED"
  | "NOT_SUPPORTED_BY_DUBIZ"
  | "BOOKING_BY_MESSAGE_NOT_DECLARED"
  | "QUOTES_ON_REQUEST_NOT_DECLARED"
  | "EXTERNAL_SHOP_NOT_DECLARED"
  | "AUTHORITY_LAPSED"
  | "TOO_FEW_OFFERINGS"
  | "PLATFORM_UNPROVEN";

export type FactAuthorityState = "UNKNOWN" | "KNOWN" | "OWNER_CONFIRMED" | "PUBLIC_USE_APPROVED";

export type ConversionInputs = {
  facts: Record<"PUBLIC_PHONE" | "PUBLIC_EMAIL" | "PUBLIC_ADDRESS" | "OPENING_HOURS" | "PUBLIC_WHATSAPP", { state: FactAuthorityState; stale: boolean }>;
  whatsappStatus: "CONNECTED" | "DISCONNECTED" | "REVOKED" | "REVOKED_BY_META" | "ERROR" | null;
  /** M6 website form: the feature is enabled AND an ACTIVE web.form connection exists. */
  webFormLive: boolean;
  declarations: string[];
  objectives: { role: "PRIMARY" | "SECONDARY"; code: string; channel: string | null; statementId: number }[];
  activeServices: number;
  activeProducts: number;
  /** SUPPORTED P2 signal kinds (QUOTE_PRICING, BOOKING_DEMAND, FULFILLMENT_MODE:AT_BUSINESS …). */
  supportedSignals: string[];
};

export type ChannelCapability = { channel: ConversionChannelCode; state: CapabilityState; observed: boolean; blocking: BlockingReason[] };
export type ConversionPath = { objective: string; channel: ConversionChannelCode | null; state: CapabilityState; blocking: BlockingReason[]; terminal: boolean };
export type ConversionConflict = {
  code: "PREFERENCE_CAPABILITY_CONFLICT" | "PREFERENCE_EVIDENCE_DIVERGENCE" | "PREFERENCE_UNSET" | "AUTHORITY_LAPSED" | "CHANNEL_DEGRADED" | "PLATFORM_UNPROVEN";
  objective: string | null;
  channel: ConversionChannelCode | null;
  detail: BlockingReason[];
};
export type ConversionRecommendation = { objective: string; channel: ConversionChannelCode | null; reasons: string[] };

export type ConversionResolution = {
  rulesVersion: string;
  channels: ChannelCapability[];
  paths: ConversionPath[];
  preference: { role: "PRIMARY" | "SECONDARY"; objective: string; channel: string | null; resolvedChannel: ConversionChannelCode | null; state: CapabilityState | "UNRESOLVED" }[];
  effectivePrimary: { objective: string; channel: ConversionChannelCode | null } | "UNRESOLVED" | "UNSET";
  recommendations: ConversionRecommendation[];
  conflicts: ConversionConflict[];
  /** "SURFACE_ONLY" when no usable conversion path exists: show the business, fabricate no CTA. */
  fallback: "NONE" | "SURFACE_ONLY";
  missingAuthority: BlockingReason[];
};

const USABLE: CapabilityState[] = ["AVAILABLE", "AVAILABLE_UNOBSERVED"];
/** What the owner may keep as a choice (flagged). Never recommended. */
const OWNER_SELECTABLE: CapabilityState[] = [...USABLE, "PLATFORM_UNPROVEN"];

function factOk(f: { state: FactAuthorityState }) {
  return f.state === "PUBLIC_USE_APPROVED";
}

export function channelCapabilities(input: ConversionInputs): ChannelCapability[] {
  const f = input.facts;
  const has = (d: string) => input.declarations.includes(d);
  const cap = (channel: ConversionChannelCode, state: CapabilityState, observed: boolean, blocking: BlockingReason[] = []): ChannelCapability => ({ channel, state, observed, blocking });
  const factGate = (fact: { state: FactAuthorityState; stale: boolean }, missing: BlockingReason, notApproved: BlockingReason): BlockingReason[] =>
    factOk(fact) ? [] : fact.state === "UNKNOWN" ? [missing] : [fact.stale ? "AUTHORITY_LAPSED" : notApproved];

  const out: ChannelCapability[] = [];
  for (const channel of CONVERSION_CHANNELS) {
    switch (channel) {
      case "PHONE": {
        const b = factGate(f.PUBLIC_PHONE, "PUBLIC_PHONE_MISSING", "PUBLIC_PHONE_NOT_APPROVED");
        out.push(b.length ? cap(channel, f.PUBLIC_PHONE.state === "UNKNOWN" ? "NOT_CONFIGURED" : "NOT_AUTHORIZED", false, b) : cap(channel, "AVAILABLE_UNOBSERVED", false));
        break;
      }
      case "EMAIL": {
        const b = factGate(f.PUBLIC_EMAIL, "PUBLIC_EMAIL_MISSING", "PUBLIC_EMAIL_NOT_APPROVED");
        out.push(b.length ? cap(channel, f.PUBLIC_EMAIL.state === "UNKNOWN" ? "NOT_CONFIGURED" : "NOT_AUTHORIZED", false, b) : cap(channel, "AVAILABLE_UNOBSERVED", false));
        break;
      }
      case "WHATSAPP_CLOUD": {
        const s = input.whatsappStatus;
        if (s === null || s === "DISCONNECTED" || s === "REVOKED") out.push(cap(channel, "NOT_CONFIGURED", true, ["WHATSAPP_NOT_CONNECTED"]));
        else if (s === "ERROR" || s === "REVOKED_BY_META") out.push(cap(channel, "DEGRADED", true, ["WHATSAPP_CONNECTION_ERROR"]));
        else if (!factOk(f.PUBLIC_WHATSAPP)) out.push(cap(channel, "NOT_AUTHORIZED", true, [f.PUBLIC_WHATSAPP.stale ? "AUTHORITY_LAPSED" : "PUBLIC_WHATSAPP_NOT_APPROVED"]));
        else out.push(WHATSAPP_CLOUD_PLATFORM_PROVEN ? cap(channel, "AVAILABLE", true) : cap(channel, "PLATFORM_UNPROVEN", true, ["PLATFORM_UNPROVEN"]));
        break;
      }
      case "WHATSAPP_LINK": {
        const b = factGate(f.PUBLIC_PHONE, "PUBLIC_PHONE_MISSING", "PUBLIC_PHONE_NOT_APPROVED");
        if (b.length) out.push(cap(channel, f.PUBLIC_PHONE.state === "UNKNOWN" ? "NOT_CONFIGURED" : "NOT_AUTHORIZED", false, b));
        else if (!has("WHATSAPP_ON_PUBLIC_PHONE")) out.push(cap(channel, "NOT_DECLARED", false, ["WHATSAPP_ON_PHONE_NOT_DECLARED"]));
        else out.push(cap(channel, "AVAILABLE_UNOBSERVED", false));
        break;
      }
      case "IN_PERSON": {
        // An address alone is never a storefront: the owner must declare visits, and both the address
        // and the opening hours must be approved for public use.
        const b = [
          ...factGate(f.PUBLIC_ADDRESS, "ADDRESS_NOT_APPROVED", "ADDRESS_NOT_APPROVED"),
          ...factGate(f.OPENING_HOURS, "HOURS_NOT_APPROVED", "HOURS_NOT_APPROVED"),
        ];
        if (b.length) out.push(cap(channel, "NOT_AUTHORIZED", false, [...new Set(b)]));
        else if (!has("ACCEPTS_VISITS")) out.push(cap(channel, "NOT_DECLARED", false, ["VISITS_NOT_DECLARED"]));
        else out.push(cap(channel, "AVAILABLE_UNOBSERVED", false));
        break;
      }
      case "EXTERNAL_LINK":
        // No canonical, publication-grade shop/catalog URL authority exists (deliberately not the bot's
        // product link). A declaration of an external shop is not a URL Dubiz may publish.
        out.push(cap(channel, "NOT_AUTHORIZED", false, ["NO_CANONICAL_SHOP_LINK_AUTHORITY"]));
        break;
      case "DUBIZ_FORM":
        out.push(input.webFormLive ? cap(channel, "AVAILABLE", true) : cap(channel, "NOT_CONFIGURED", true, ["WEB_FORM_NOT_ENABLED"]));
        break;
      case "DUBIZ_BOOKING":
      case "DUBIZ_CHECKOUT":
        out.push(cap(channel, "NOT_SUPPORTED_BY_PLATFORM", true, ["NOT_SUPPORTED_BY_DUBIZ"]));
        break;
    }
  }
  return out;
}

/** The objective's own requirement on top of the channel (a booking by message must be declared, …). */
function objectiveGate(objective: string, channel: ConversionChannelCode, declarations: string[]): BlockingReason | null {
  const messageLike = channel === "PHONE" || channel === "EMAIL" || channel === "WHATSAPP_CLOUD" || channel === "WHATSAPP_LINK";
  if (objective === "BOOK" && messageLike && !declarations.includes("BOOKING_BY_MESSAGE")) return "BOOKING_BY_MESSAGE_NOT_DECLARED";
  if (objective === "REQUEST_QUOTE" && messageLike && !declarations.includes("QUOTES_ON_REQUEST")) return "QUOTES_ON_REQUEST_NOT_DECLARED";
  if (objective === "BUY" && channel === "EXTERNAL_LINK" && !declarations.includes("EXTERNAL_SHOP")) return "EXTERNAL_SHOP_NOT_DECLARED";
  return null;
}

/** Channel order used to pick the best path for an objective (shared with the P3-B strategy engine). */
export const CHANNEL_PREFERENCE_ORDER: ConversionChannelCode[] = ["DUBIZ_FORM", "WHATSAPP_CLOUD", "WHATSAPP_LINK", "PHONE", "IN_PERSON", "EMAIL", "EXTERNAL_LINK", "DUBIZ_BOOKING", "DUBIZ_CHECKOUT"];

export function resolveConversion(input: ConversionInputs): ConversionResolution {
  const channels = channelCapabilities(input);
  const byChannel = new Map(channels.map((c) => [c.channel, c]));

  const paths: ConversionPath[] = [];
  for (const objective of OBJECTIVE_CODES) {
    if (objective === "DISCOVER_SERVICES" || objective === "DISCOVER_PRODUCTS") {
      const n = objective === "DISCOVER_SERVICES" ? input.activeServices : input.activeProducts;
      // Discovery is on-page: never a terminal conversion, only useful with an actionable path below it.
      paths.push({ objective, channel: null, state: n >= 3 ? "AVAILABLE" : "NOT_CONFIGURED", blocking: n >= 3 ? [] : ["TOO_FEW_OFFERINGS"], terminal: false });
      continue;
    }
    for (const channel of OBJECTIVE_CHANNELS[objective]) {
      const c = byChannel.get(channel)!;
      const gate = objectiveGate(objective, channel, input.declarations);
      const usableChannel = OWNER_SELECTABLE.includes(c.state);
      paths.push(
        gate && usableChannel
          ? { objective, channel, state: "NOT_DECLARED", blocking: [gate], terminal: true }
          : { objective, channel, state: c.state, blocking: gate ? [...c.blocking, gate] : c.blocking, terminal: true },
      );
    }
  }

  const pathFor = (objective: string, channel: string | null): ConversionPath | null => {
    const candidates = paths.filter((p) => p.objective === objective && (channel === null || p.channel === channel));
    if (!candidates.length) return null;
    if (channel !== null) return candidates[0];
    // No channel stated by the owner: the best path the business can actually serve for this objective.
    const rank = (p: ConversionPath) => {
      const s = USABLE.includes(p.state) ? 0 : p.state === "PLATFORM_UNPROVEN" ? 1 : 2;
      return s * 100 + (p.channel ? CHANNEL_PREFERENCE_ORDER.indexOf(p.channel) : 0);
    };
    return [...candidates].sort((a, b) => rank(a) - rank(b))[0];
  };

  const conflicts: ConversionConflict[] = [];
  const preference = input.objectives.map((o) => {
    const p = pathFor(o.code, o.channel);
    const state: CapabilityState | "UNRESOLVED" = p ? p.state : "UNRESOLVED";
    if (p && p.terminal) {
      if (p.state === "PLATFORM_UNPROVEN") conflicts.push({ code: "PLATFORM_UNPROVEN", objective: o.code, channel: p.channel, detail: ["PLATFORM_UNPROVEN"] });
      else if (p.state === "DEGRADED") conflicts.push({ code: "CHANNEL_DEGRADED", objective: o.code, channel: p.channel, detail: p.blocking });
      else if (p.blocking.includes("AUTHORITY_LAPSED")) conflicts.push({ code: "AUTHORITY_LAPSED", objective: o.code, channel: p.channel, detail: p.blocking });
      else if (!USABLE.includes(p.state)) conflicts.push({ code: "PREFERENCE_CAPABILITY_CONFLICT", objective: o.code, channel: p.channel, detail: p.blocking });
    } else if (p && !p.terminal && !USABLE.includes(p.state)) {
      conflicts.push({ code: "PREFERENCE_CAPABILITY_CONFLICT", objective: o.code, channel: null, detail: p.blocking });
    }
    return { role: o.role, objective: o.code, channel: o.channel, resolvedChannel: p?.channel ?? null, state };
  });

  const primary = preference.find((p) => p.role === "PRIMARY") ?? null;
  let effectivePrimary: ConversionResolution["effectivePrimary"];
  if (!primary) {
    effectivePrimary = "UNSET";
    conflicts.push({ code: "PREFERENCE_UNSET", objective: null, channel: null, detail: [] });
  } else if (primary.state !== "UNRESOLVED" && OWNER_SELECTABLE.includes(primary.state)) {
    // The owner's choice stands (a PLATFORM_UNPROVEN choice stands too — flagged above).
    effectivePrimary = { objective: primary.objective, channel: primary.resolvedChannel };
  } else {
    effectivePrimary = "UNRESOLVED";
  }

  // Recommendations: evidence-led, ONLY among usable terminal paths. PLATFORM_UNPROVEN never qualifies.
  const usable = paths.filter((p) => p.terminal && USABLE.includes(p.state));
  const best = (objective: string) => usable.filter((p) => p.objective === objective).sort((a, b) => CHANNEL_PREFERENCE_ORDER.indexOf(a.channel!) - CHANNEL_PREFERENCE_ORDER.indexOf(b.channel!))[0] ?? null;
  const recommendations: ConversionRecommendation[] = [];
  const push = (objective: string, reasons: string[]) => {
    const p = best(objective);
    if (p && !recommendations.some((r) => r.objective === objective)) recommendations.push({ objective, channel: p.channel, reasons });
  };
  if (input.supportedSignals.includes("QUOTE_PRICING")) push("REQUEST_QUOTE", ["most priced services are quoted"]);
  if (input.supportedSignals.includes("BOOKING_DEMAND")) push("BOOK", ["completed bookings in the last 180 days"]);
  if (input.declarations.includes("ACCEPTS_VISITS")) push("VISIT_STORE", ["the business declared it accepts visits"]);
  if (input.supportedSignals.includes("FULFILLMENT_MODE:AT_CUSTOMER")) push("CALL", ["services are delivered at the customer"]);
  push("WHATSAPP", ["a usable WhatsApp path exists"]);
  push("CALL", ["an approved public phone exists"]);
  push("LEAVE_LEAD", ["a usable lead path exists"]);

  const top = recommendations[0];
  if (primary && top && top.objective !== primary.objective && effectivePrimary !== "UNRESOLVED" && effectivePrimary !== "UNSET" && top.reasons.some((r) => !r.startsWith("a usable") && !r.startsWith("an approved"))) {
    conflicts.push({ code: "PREFERENCE_EVIDENCE_DIVERGENCE", objective: primary.objective, channel: null, detail: [] });
  }

  const missingAuthority = [...new Set(channels.filter((c) => c.state === "NOT_AUTHORIZED").flatMap((c) => c.blocking))];
  return {
    rulesVersion: CONVERSION_RULES_VERSION,
    channels,
    paths,
    preference,
    effectivePrimary,
    recommendations,
    conflicts,
    fallback: usable.length ? "NONE" : "SURFACE_ONLY",
    missingAuthority,
  };
}
