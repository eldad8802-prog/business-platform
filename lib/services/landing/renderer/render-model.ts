import { BLUEPRINT_VERSION } from "../composer/blueprint-schema";
import type { BlueprintAction, BlueprintAssetRef, BlueprintSection, LandingBlueprint } from "../composer/blueprint-assembly";
import type { LandingComposerContext } from "../composer/composer-context";
import { visualProfileFor, type LandingVisualProfile } from "./visual-profile";

/**
 * P3-D · RenderModel — the ONLY input of the landing renderer, built SERVER-SIDE from a blueprint that
 * just passed the P3-C validation path (never from client JSON). Deterministic, no model call.
 *
 *   - fails closed on an unknown blueprint version, an unknown section, an invalid action state or a
 *     reference the blueprint does not itself carry (forged / foreign);
 *   - CTA destinations are DERIVED here from the business's public-use-approved facts (the same
 *     canonical source P3-A/P3-C used): never from the model, never from the client;
 *   - assets resolve to an owner-only preview URL by asset ref — never a storage key or bucket path;
 *   - generated assets stay ILLUSTRATIVE;
 *   - the mode is OWNER_PREVIEW: actions are shown, never performed (no tel:/wa.me/mailto/submit is
 *     wired in preview — `href` is computed for display / a future publish step only).
 */

export const RENDERER_VERSION = "p3d.renderer.v1";
export const SUPPORTED_BLUEPRINT_VERSIONS: readonly string[] = [BLUEPRINT_VERSION];
export const RENDER_SECTION_TYPES = [
  "PRIMARY_ACTION", "CONTACT_PANEL", "ABOUT", "SERVICES_OVERVIEW", "PRODUCTS_SHOWCASE", "FEATURED_OFFERINGS",
  "TRUST_PROOF", "QUOTE_PROCESS", "BOOKING_INFO", "LOCATION_AND_HOURS", "SERVICE_AREA",
] as const;
export type RenderSectionType = (typeof RENDER_SECTION_TYPES)[number];
export const ACTION_CHANNELS = ["PHONE", "WHATSAPP_LINK", "WHATSAPP_CLOUD", "EMAIL", "IN_PERSON", "DUBIZ_FORM"] as const;

export class RendererError extends Error {
  constructor(readonly code: string) {
    super(`Landing renderer refused the blueprint: ${code}`);
    this.name = "RendererError";
  }
}

export type RenderImage = { ref: string; src: string; alt: string; illustrative: boolean };

export type RenderAction = {
  label: string;
  objective: string;
  channel: (typeof ACTION_CHANNELS)[number];
  /** What the visitor would do — the UI behaviour class, decided by the channel only. */
  behaviour: "CALL" | "WHATSAPP" | "EMAIL" | "VISIT" | "FORM";
  /** The approved public destination shown to the owner (a phone / email / address). Null for FORM. */
  destinationDisplay: string | null;
  /** The deterministic link a LIVE page would use. Never wired in OWNER_PREVIEW. Null when not derivable. */
  href: string | null;
  available: boolean;
  missingDependency: string | null;
  platformUnproven: boolean;
};

export type RenderOffering = { ref: string; kind: string; name: string; description: string | null; priceText: string | null; blurb: string; image: RenderImage | null };

export type RenderSection =
  | { type: "PRIMARY_ACTION" | "CONTACT_PANEL"; key: string; heading: string; body: string; action: RenderAction | null }
  | { type: "ABOUT"; key: string; heading: string; body: string; statements: string[] }
  | { type: "SERVICE_AREA"; key: string; heading: string; statements: string[] }
  | { type: "SERVICES_OVERVIEW" | "PRODUCTS_SHOWCASE" | "FEATURED_OFFERINGS"; key: string; heading: string; intro: string; offerings: RenderOffering[] }
  | { type: "TRUST_PROOF"; key: string; heading: string; intro: string; claims: { ref: string; wording: string; providedByBusiness: boolean }[] }
  | { type: "QUOTE_PROCESS" | "BOOKING_INFO"; key: string; heading: string; steps: string[] }
  | { type: "LOCATION_AND_HOURS"; key: string; heading: string; facts: { key: string; label: string; value: string }[] };

export type RenderModel = {
  rendererVersion: typeof RENDERER_VERSION;
  blueprintVersion: string;
  mode: "OWNER_PREVIEW";
  strategyType: string;
  strategyId: string;
  meta: { title: string; description: string; robots: "noindex,nofollow" };
  businessName: string | null;
  profile: LandingVisualProfile;
  hero: { headline: string; subheadline: string; image: RenderImage | null; fallback: "TYPOGRAPHIC" | null };
  primaryAction: RenderAction | null;
  secondaryAction: RenderAction | null;
  surfaceOnly: boolean;
  sections: RenderSection[];
  readiness: { publishReady: boolean; missingForPublication: string[]; warnings: string[] };
};

const FACT_LABEL: Record<string, string> = { PUBLIC_ADDRESS: "כתובת", OPENING_HOURS: "שעות פעילות", PUBLIC_PHONE: "טלפון", PUBLIC_EMAIL: "אימייל", CITY: "עיר" };

/** A phone in a deterministic, digits-only form; null if it is not a usable phone. */
function phoneDigits(raw: string): { tel: string; intl: string | null } | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (plus) return { tel: `+${digits}`, intl: digits };
  // Israeli national format (0XXXXXXXX[X]) → country code 972. Anything else is not converted.
  if (/^0\d{8,9}$/.test(digits)) return { tel: digits, intl: `972${digits.slice(1)}` };
  return { tel: digits, intl: null };
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/** Derive the action's destination from APPROVED facts only. Missing → a disabled action, never an invented one. */
export function resolveAction(a: BlueprintAction | null, facts: { key: string; value: string }[]): RenderAction | null {
  if (!a) return null;
  if (!(ACTION_CHANNELS as readonly string[]).includes(a.channel)) throw new RendererError("UNSUPPORTED_ACTION_CHANNEL");
  if (!a.label.trim()) throw new RendererError("ACTION_WITHOUT_LABEL");
  const fact = (k: string) => facts.find((f) => f.key === k)?.value ?? null;
  const base = { label: a.label, objective: a.objective, channel: a.channel as RenderAction["channel"], platformUnproven: a.platformUnproven };
  const missing = (behaviour: RenderAction["behaviour"], dep: string): RenderAction => ({ ...base, behaviour, destinationDisplay: null, href: null, available: false, missingDependency: dep });
  switch (a.channel) {
    case "PHONE": {
      const v = fact("PUBLIC_PHONE");
      const p = v ? phoneDigits(v) : null;
      return p ? { ...base, behaviour: "CALL", destinationDisplay: v, href: `tel:${p.tel}`, available: true, missingDependency: null } : missing("CALL", "PUBLIC_PHONE");
    }
    case "WHATSAPP_LINK": {
      const v = fact("PUBLIC_PHONE");
      const p = v ? phoneDigits(v) : null;
      if (!p) return missing("WHATSAPP", "PUBLIC_PHONE");
      return p.intl ? { ...base, behaviour: "WHATSAPP", destinationDisplay: v, href: `https://wa.me/${p.intl}`, available: true, missingDependency: null } : missing("WHATSAPP", "INTERNATIONAL_PHONE_FORMAT");
    }
    case "WHATSAPP_CLOUD": {
      const v = fact("PUBLIC_WHATSAPP");
      const p = v ? phoneDigits(v) : null;
      return p?.intl ? { ...base, behaviour: "WHATSAPP", destinationDisplay: v, href: `https://wa.me/${p.intl}`, available: true, missingDependency: null } : missing("WHATSAPP", "PUBLIC_WHATSAPP");
    }
    case "EMAIL": {
      const v = fact("PUBLIC_EMAIL");
      return v && EMAIL_RE.test(v) ? { ...base, behaviour: "EMAIL", destinationDisplay: v, href: `mailto:${v}`, available: true, missingDependency: null } : missing("EMAIL", "PUBLIC_EMAIL");
    }
    case "IN_PERSON": {
      // Informational only: the approved address. No map link is synthesised in P3-D.
      const v = fact("PUBLIC_ADDRESS");
      return v ? { ...base, behaviour: "VISIT", destinationDisplay: v, href: null, available: true, missingDependency: null } : missing("VISIT", "PUBLIC_ADDRESS");
    }
    case "DUBIZ_FORM":
      // The website lead form is a separate, owner-enabled M6 surface; the preview never submits.
      return { ...base, behaviour: "FORM", destinationDisplay: null, href: null, available: true, missingDependency: null };
    default:
      throw new RendererError("UNSUPPORTED_ACTION_CHANNEL");
  }
}

export function assetPreviewSrc(ref: string): string {
  const m = /^asset:(\d+)$/.exec(ref);
  if (!m) throw new RendererError("FORGED_ASSET_REF");
  return `/api/business/landing-preview/asset/${m[1]}`;
}

/**
 * Pure. Build the render model from a VALIDATED blueprint and the composer context it was composed
 * from (approved facts + approved asset metadata). Throws RendererError on anything it does not
 * fully understand.
 */
export function buildRenderModel(bp: LandingBlueprint, ctx: LandingComposerContext): RenderModel {
  if (!SUPPORTED_BLUEPRINT_VERSIONS.includes(bp.version)) throw new RendererError("UNSUPPORTED_BLUEPRINT_VERSION");
  if (bp.authority !== "MACHINE_PROPOSAL") throw new RendererError("UNEXPECTED_AUTHORITY");
  if (bp.strategyId !== ctx.strategy.id || bp.strategyType !== ctx.strategy.type) throw new RendererError("STRATEGY_MISMATCH");

  const allowed = {
    offerings: new Set(bp.offeringRefs),
    trust: new Set(bp.trustClaimRefs),
    assets: new Set(bp.assetRefs),
    facts: new Set(bp.factRefs),
    statements: new Set(bp.statementRefs),
    ctxAssets: new Set(ctx.assets.map((a) => a.ref)),
  };
  const image = (a: BlueprintAssetRef | null | undefined, alt: string): RenderImage | null => {
    if (!a) return null;
    if (!allowed.assets.has(a.ref) || !allowed.ctxAssets.has(a.ref)) throw new RendererError("FORGED_ASSET_REF");
    return { ref: a.ref, src: assetPreviewSrc(a.ref), alt: a.illustrativeOnly ? "איור להמחשה" : alt, illustrative: a.illustrativeOnly };
  };

  // ── actions: SURFACE_ONLY has none, anywhere ──
  const primaryAction = resolveAction(bp.primaryAction, ctx.facts);
  const secondaryAction = resolveAction(bp.secondaryAction, ctx.facts);
  if (bp.surfaceOnly && (primaryAction || secondaryAction || bp.hero.action || bp.sections.some((s) => s.action))) throw new RendererError("ACTION_ON_SURFACE_ONLY");
  if (!bp.surfaceOnly && !primaryAction) throw new RendererError("MISSING_PRIMARY_ACTION");

  const sections: RenderSection[] = bp.sections.map((s: BlueprintSection, i) => {
    const key = `${s.sectionType}-${i}`;
    if (!(RENDER_SECTION_TYPES as readonly string[]).includes(s.sectionType)) throw new RendererError("UNKNOWN_SECTION_TYPE");
    const type = s.sectionType as RenderSectionType;
    switch (type) {
      case "PRIMARY_ACTION":
      case "CONTACT_PANEL":
        if (bp.surfaceOnly) throw new RendererError("ACTION_ON_SURFACE_ONLY");
        return { type, key, heading: s.heading, body: s.body ?? "", action: s.action ? primaryAction : null };
      case "ABOUT":
        (s.statements ?? []).forEach((x) => { if (!allowed.statements.has(x.ref)) throw new RendererError("FORGED_STATEMENT_REF"); });
        return { type, key, heading: s.heading, body: s.body ?? "", statements: (s.statements ?? []).map((x) => x.text) };
      case "SERVICE_AREA":
        (s.statements ?? []).forEach((x) => { if (!allowed.statements.has(x.ref)) throw new RendererError("FORGED_STATEMENT_REF"); });
        return { type, key, heading: s.heading, statements: (s.statements ?? []).map((x) => x.text) };
      case "SERVICES_OVERVIEW":
      case "PRODUCTS_SHOWCASE":
      case "FEATURED_OFFERINGS":
        return {
          type, key, heading: s.heading, intro: s.intro ?? "",
          offerings: (s.offerings ?? []).map((o) => {
            if (!allowed.offerings.has(o.ref)) throw new RendererError("FORGED_OFFERING_REF");
            return { ref: o.ref, kind: o.kind, name: o.name, description: o.description, priceText: o.priceText, blurb: o.blurb, image: image(o.assets[0] ?? null, `תמונה של ${o.name}`) };
          }),
        };
      case "TRUST_PROOF":
        return {
          type, key, heading: s.heading, intro: s.intro ?? "",
          claims: (s.trustClaims ?? []).map((c) => {
            if (!allowed.trust.has(c.ref)) throw new RendererError("FORGED_TRUST_REF");
            return { ref: c.ref, wording: c.wording, providedByBusiness: c.providedByBusiness };
          }),
        };
      case "QUOTE_PROCESS":
      case "BOOKING_INFO":
        return { type, key, heading: s.heading, steps: [...(s.steps ?? [])] };
      case "LOCATION_AND_HOURS":
        return {
          type, key, heading: s.heading,
          facts: (s.facts ?? []).map((f) => {
            if (!allowed.facts.has(f.ref)) throw new RendererError("FORGED_FACT_REF");
            return { key: f.key, label: FACT_LABEL[f.key] ?? f.key, value: f.value };
          }),
        };
      default:
        throw new RendererError("UNKNOWN_SECTION_TYPE");
    }
  });

  const heroImage = image(bp.hero.asset, bp.metadata.title ? `${bp.metadata.title}` : "תמונה ראשית");
  const offeringCount = sections.reduce((n, s) => n + ("offerings" in s ? s.offerings.length : 0), 0);
  const trustCount = sections.reduce((n, s) => n + ("claims" in s ? s.claims.length : 0), 0);

  return {
    rendererVersion: RENDERER_VERSION,
    blueprintVersion: bp.version,
    mode: "OWNER_PREVIEW",
    strategyType: bp.strategyType,
    strategyId: bp.strategyId,
    meta: { title: bp.metadata.title, description: bp.metadata.description, robots: "noindex,nofollow" },
    businessName: ctx.businessName,
    profile: visualProfileFor({ strategyType: bp.strategyType, hasHeroImage: !!heroImage, offeringCount, trustClaimCount: trustCount, surfaceOnly: bp.surfaceOnly }),
    hero: { headline: bp.hero.headline, subheadline: bp.hero.subheadline, image: heroImage, fallback: heroImage ? null : "TYPOGRAPHIC" },
    primaryAction,
    secondaryAction,
    surfaceOnly: bp.surfaceOnly,
    sections,
    readiness: { publishReady: bp.readiness.publishReady, missingForPublication: [...bp.readiness.missingForPublication], warnings: [...bp.readiness.warnings] },
  };
}

/**
 * Client-side guard: the renderer re-checks the shape it receives (versions, closed section set, action
 * invariants) and refuses to draw anything it does not recognise. Defence in depth — the server already
 * built the model.
 */
export function assertRenderable(m: unknown): asserts m is RenderModel {
  const x = m as Partial<RenderModel> | null;
  if (!x || x.rendererVersion !== RENDERER_VERSION) throw new RendererError("UNSUPPORTED_RENDERER_VERSION");
  if (!x.blueprintVersion || !SUPPORTED_BLUEPRINT_VERSIONS.includes(x.blueprintVersion)) throw new RendererError("UNSUPPORTED_BLUEPRINT_VERSION");
  if (x.mode !== "OWNER_PREVIEW") throw new RendererError("UNSUPPORTED_MODE");
  if (!Array.isArray(x.sections) || x.sections.some((s) => !(RENDER_SECTION_TYPES as readonly string[]).includes((s as { type?: string })?.type ?? ""))) throw new RendererError("UNKNOWN_SECTION_TYPE");
  if (x.surfaceOnly && (x.primaryAction || x.secondaryAction || x.sections.some((s) => "action" in s && s.action))) throw new RendererError("ACTION_ON_SURFACE_ONLY");
}
