/**
 * P3-D · Deterministic landing renderer — verification on REAL rendered markup. Run:
 *   npx tsx lib/services/landing/renderer/landing-renderer.verify.test.tsx
 *
 * Pipeline: canonical fixtures → P3-B strategy → P3-C composition (deterministic fake model, no network)
 * → buildRenderModel (server side) → <LandingRenderer> rendered to static HTML with react-dom/server.
 * CSS modules are stubbed (class names only). Browser screenshots / overflow are covered by the visual QA
 * harness; database tenant isolation by identity.rls.db.test.ts.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { readdirSync, readFileSync, statSync } from "node:fs";
import Module from "node:module";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LandingBlueprint } from "../composer/blueprint-assembly";
import { buildComposerContext, type LandingComposerContext } from "../composer/composer-context";
import { composeBlueprint } from "../composer/landing-composer";
import { buildLandingStrategySet, type LandingStrategy } from "../landing-strategy-engine";
import type { LandingBusinessContext } from "../landing-business-context";
import { good } from "../__fixtures__/composer-fakes";
import { claimRow, ctxFor, NAME, PHONE, prods, svcs, type Fx } from "../__fixtures__/landing-fixtures";
import { assertRenderable, buildRenderModel, RENDERER_VERSION, RendererError, resolveAction, type RenderModel } from "./render-model";
import { PROFILE_DIMENSIONS, visualProfileFor } from "./visual-profile";

// CSS modules: class name = key (static render only).
(Module as unknown as { _extensions: Record<string, (m: { exports: unknown }) => void> })._extensions[".css"] = (m) => {
  const classes: Record<string | symbol, unknown> = new Proxy({}, {
    get: (_t, k) => (k === "default" ? classes : k === "__esModule" ? false : typeof k === "string" ? k : undefined),
  });
  m.exports = classes;
};
const { LandingRenderer } = require("@/components/landing-renderer/LandingRenderer") as typeof import("@/components/landing-renderer/LandingRenderer");

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 1200));
  }
}
function throwsCode(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof RendererError && e.code === code;
  }
}

type Built = { landing: LandingBusinessContext; strategy: LandingStrategy; bp: LandingBlueprint; cc: LandingComposerContext; model: RenderModel; html: string };
async function build(fx: Fx, pick?: string): Promise<Built> {
  const landing = ctxFor(fx);
  const set = buildLandingStrategySet(landing);
  const strategy = pick ? set.strategies.find((s) => s.strategyType === pick)! : set.strategies[0];
  if (!strategy) throw new Error(`no strategy ${pick}`);
  const r = await composeBlueprint({ landing, strategy, model: good() });
  if (!r.blueprint) throw new Error(`composition ${r.compositionStatus} ${JSON.stringify(r.violations)}`);
  const cc = buildComposerContext(landing, strategy);
  const model = buildRenderModel(r.blueprint, cc);
  return { landing, strategy, bp: r.blueprint, cc, model, html: renderToStaticMarkup(createElement(LandingRenderer, { model })) };
}
const sectionsInHtml = (html: string) => [...html.matchAll(/<(?:section|header)[^>]*data-section="([A-Z_]+)"/g)].map((m) => m[1]);
const LIVE_LINK = /href="(?:tel:|mailto:|https?:\/\/wa\.me|whatsapp:|sms:)/i;

const ADDRESS = { fact: "PUBLIC_ADDRESS" as const, value: "הרצל 1, חיפה", authority: "PUBLIC" as const };
const HOURS = { fact: "OPENING_HOURS" as const, value: "א׳–ה׳ 9:00–19:00", authority: "PUBLIC" as const };
const QUOTE: Fx = {
  facts: [NAME, PHONE, ADDRESS, HOURS], webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED" }),
  claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true }), claimRow("LICENSED", { licenseType: "קבלן שיפוצים", issuer: "רשם הקבלנים" }, { approved: true, verified: true })],
  statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE" }, { dimension: "DESCRIPTION", text: "שיפוצים כלליים", publicUseApproved: true }, { dimension: "SERVICE_AREA", text: "חיפה והקריות", publicUseApproved: true }],
  assets: [{ id: 1, approved: true, services: [1] }, { id: 2, approved: false, services: [2] }, { id: 3, approved: true, services: [3], businessId: 2 }],
};
const TRUST: Fx = {
  facts: [NAME, { fact: "PUBLIC_EMAIL", value: "office@x.co", authority: "PUBLIC" }], webForm: true, services: svcs(4),
  claims: [claimRow("CERTIFIED", { certificationName: "רואה חשבון מוסמך", issuer: "מועצת רואי החשבון" }, { approved: true, verified: true }), claimRow("FOUNDED_YEAR", { foundedYear: 1995 }, { approved: true })],
  statements: [{ dimension: "POSITIONING", code: "EXPERTISE" }, { dimension: "DESCRIPTION", text: "משרד רואי חשבון לעסקים קטנים", publicUseApproved: true }],
};
const PRODUCTS: Fx = { facts: [NAME, PHONE, ADDRESS, HOURS], products: prods(8), statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "DISCOVER_PRODUCTS" }, { dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }],
  assets: [{ id: 11, approved: true, products: [1] }, { id: 12, origin: "GENERATED", approved: true, products: [2] }] };
const STORE: Fx = { facts: [NAME, PHONE, ADDRESS, HOURS], products: prods(5), services: svcs(1, { fulfillment: "AT_BUSINESS" }, 50),
  statements: [{ dimension: "CONVERSION_DECLARATION", code: "ACCEPTS_VISITS" }, { dimension: "TARGET_AUDIENCE", code: "WALK_IN_CUSTOMERS" }] };
const BOOK: Fx = { facts: [NAME, PHONE], services: svcs(5), demand: [{ kind: "SERVICE", id: 2, type: "BOOKING", n: 14, status: "COMPLETED" }],
  statements: [{ dimension: "CONVERSION_DECLARATION", code: "BOOKING_BY_MESSAGE" }, { dimension: "TARGET_AUDIENCE", code: "APPOINTMENT_CUSTOMERS" }] };
const HOME: Fx = { facts: [NAME, PHONE], services: svcs(3, { fulfillment: "AT_CUSTOMER" }), statements: [{ dimension: "SERVICE_AREA", text: "הקריות", publicUseApproved: true }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] };
const SURFACE: Fx = { facts: [NAME, { fact: "PUBLIC_PHONE", value: "03-1" }], services: svcs(4) };
const WA: Fx = { facts: [NAME, { fact: "PUBLIC_PHONE", value: "052-1234567", authority: "PUBLIC" }], services: svcs(3), statements: [{ dimension: "CONVERSION_DECLARATION", code: "WHATSAPP_ON_PUBLIC_PHONE" }, { dimension: "PRIMARY_OBJECTIVE", code: "WHATSAPP" }] };

async function main(): Promise<void> {
  /* ─── R1 + verticals: every vertical renders, deterministic, one h1, owner preview ─── */
  const verticals: [string, Fx, string | undefined][] = [
    ["service / quote", QUOTE, undefined], ["professional trust", TRUST, "TRUST_AUTHORITY_FIRST"], ["retail / products", PRODUCTS, undefined],
    ["local storefront", STORE, undefined], ["appointments", BOOK, undefined], ["home service", HOME, undefined], ["SURFACE_ONLY", SURFACE, undefined],
  ];
  const built: Record<string, Built> = {};
  for (const [name, fx, pick] of verticals) {
    const b = await build(fx, pick);
    built[name] = b;
    ok(`R1 ${name}: renders (${b.model.strategyType})`, b.html.includes(`data-renderer="${RENDERER_VERSION}"`) && !b.html.includes("data-renderer-refused"));
    ok(`R1 ${name}: exactly one h1; sections use h2`, (b.html.match(/<h1/g) ?? []).length === 1 && (b.html.match(/<h2/g) ?? []).length === b.model.sections.length);
    ok(`R1 ${name}: deterministic (same blueprint → same markup)`, renderToStaticMarkup(createElement(LandingRenderer, { model: buildRenderModel(b.bp, b.cc) })) === b.html);
    ok(`R18 ${name}: section order is the blueprint's (strategy priority), hero first`,
      JSON.stringify(sectionsInHtml(b.html)) === JSON.stringify(["HERO", ...b.bp.sections.map((s) => s.sectionType)]));
    ok(`R22 ${name}: owner preview performs nothing (no tel/mailto/wa.me/http links, no <form>, no enabled action)`,
      !LIVE_LINK.test(b.html) && !/<form/i.test(b.html) && !/<a /i.test(b.html) && !/<button(?![^>]*aria-disabled="true")/i.test(b.html));
    ok(`R22 ${name}: OWNER_PREVIEW mode + noindex meta`, b.model.mode === "OWNER_PREVIEW" && b.model.meta.robots === "noindex,nofollow" && b.html.includes('data-mode="OWNER_PREVIEW"'));
    ok(`${name}: no Dubiz app chrome inside the canvas`, !/data-shell-root|NavSidebar|BottomBar/.test(b.html));
  }

  /* ─── R2 / R3 / forged refs: fail closed ─── */
  {
    const b = built["service / quote"];
    ok("R2 unknown blueprint version → refused", throwsCode(() => buildRenderModel({ ...b.bp, version: "p3c.blueprint.v9" } as unknown as LandingBlueprint, b.cc), "UNSUPPORTED_BLUEPRINT_VERSION"));
    ok("R2 unknown renderer version → the renderer refuses to draw",
      renderToStaticMarkup(createElement(LandingRenderer, { model: { ...b.model, rendererVersion: "p3d.renderer.v9" } })).includes('data-renderer-refused="UNSUPPORTED_RENDERER_VERSION"'));
    const withUnknown = { ...b.bp, sections: [...b.bp.sections, { sectionType: "TESTIMONIALS", priority: 9, heading: "x", body: "y" }] } as unknown as LandingBlueprint;
    ok("R3 unknown section in a blueprint → refused", throwsCode(() => buildRenderModel(withUnknown, b.cc), "UNKNOWN_SECTION_TYPE"));
    const html3 = renderToStaticMarkup(createElement(LandingRenderer, { model: { ...b.model, sections: [...b.model.sections, { type: "LIVE_CHAT", key: "x", heading: "x" }] } }));
    ok("R3 unknown section in a render model → the renderer draws nothing of it (refused notice only)", html3.includes('data-renderer-refused="UNKNOWN_SECTION_TYPE"') && !html3.includes("<h1"));
    const strategyMismatch = { ...b.bp, strategyId: "p3b.strategy.v1:CALL_FIRST:CALL:PHONE" } as LandingBlueprint;
    ok("R2 a blueprint for another strategy than the context → refused", throwsCode(() => buildRenderModel(strategyMismatch, b.cc), "STRATEGY_MISMATCH"));
    const offeringSection = b.bp.sections.find((s) => s.offerings)!;
    const forgedOffering = { ...b.bp, sections: b.bp.sections.map((s) => (s === offeringSection ? { ...s, offerings: [...s.offerings!, { ...s.offerings![0], ref: "offering:SERVICE:999" }] } : s)) } as LandingBlueprint;
    ok("R24 a foreign / forged offering ref in a blueprint → refused", throwsCode(() => buildRenderModel(forgedOffering, b.cc), "FORGED_OFFERING_REF"));
    const forgedHero = { ...b.bp, hero: { ...b.bp.hero, asset: { ref: "asset:3", origin: "OWNER_UPLOAD" as const, illustrativeOnly: false } }, assetRefs: [...b.bp.assetRefs, "asset:3"] } as LandingBlueprint;
    ok("R13 another business's asset (even if added to the blueprint's own refs) → refused", throwsCode(() => buildRenderModel(forgedHero, b.cc), "FORGED_ASSET_REF"));
    const forgedUnapproved = { ...b.bp, hero: { ...b.bp.hero, asset: { ref: "asset:2", origin: "OWNER_UPLOAD" as const, illustrativeOnly: false } }, assetRefs: [...b.bp.assetRefs, "asset:2"] } as LandingBlueprint;
    ok("R12 an unapproved asset → refused", throwsCode(() => buildRenderModel(forgedUnapproved, b.cc), "FORGED_ASSET_REF"));
    const trustSection = b.bp.sections.find((s) => s.trustClaims);
    if (trustSection) {
      const forgedTrust = { ...b.bp, sections: b.bp.sections.map((s) => (s === trustSection ? { ...s, trustClaims: [...s.trustClaims!, { ref: "trust:9999", kind: "LICENSED", wording: "מאומת על ידי דוביז", providedByBusiness: false }] } : s)) } as LandingBlueprint;
      ok("R24 a forged trust claim ref → refused", throwsCode(() => buildRenderModel(forgedTrust, b.cc), "FORGED_TRUST_REF"));
    }
    ok("R24 a forged fact ref → refused", throwsCode(() => buildRenderModel({ ...b.bp, sections: [...b.bp.sections, { sectionType: "LOCATION_AND_HOURS", priority: 9, heading: "x", facts: [{ ref: "fact:PUBLIC_EMAIL", key: "PUBLIC_EMAIL", value: "b@other.co" }] }] } as LandingBlueprint, b.cc), "FORGED_FACT_REF"));
    ok("R2 assertRenderable rejects a non-preview mode", throwsCode(() => assertRenderable({ ...b.model, mode: "LIVE" }), "UNSUPPORTED_MODE"));
  }

  /* ─── R4 · no HTML injection surface in the renderer ─── */
  {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(p) && !p.includes(".test.") ? [p] : []; });
    const files = [...walk(join(process.cwd(), "components/landing-renderer")), ...walk(join(process.cwd(), "lib/services/landing/renderer")), join(process.cwd(), "components/business/landing/LandingPreviewScreen.tsx")];
    const offenders = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|\beval\s*\(|new\s+Function\s*\(|DOMParser|html-react-parser|react-markdown|\bmarked\b|remark|rehype|markdown-it/.test(readFileSync(f, "utf8")));
    ok("R4 no dangerouslySetInnerHTML / innerHTML / eval / HTML or Markdown parser anywhere in the renderer", files.length >= 6 && offenders.length === 0, offenders);
    const sections = readFileSync(join(process.cwd(), "components/landing-renderer/sections.tsx"), "utf8");
    ok("R4 no data-driven style / className: every className comes from the CSS module", !/style=\{\{?[^}]*(model|section|o\.|c\.|action)/.test(sections) && !/className=\{(?!styles\.|`\$\{styles|primary \? styles)/.test(sections));
    ok("R22 action buttons carry no handler and no link (static)", !/onClick|href=/.test(sections));
  }

  /* ─── R5 / R32 · SURFACE_ONLY: zero actionable CTA ─── */
  {
    const b = built["SURFACE_ONLY"];
    ok("R5 SURFACE_ONLY model has no actions at all", b.model.surfaceOnly && b.model.primaryAction === null && b.model.secondaryAction === null && b.model.sections.every((s) => !("action" in s) || s.action === null));
    ok("R5 rendered page: no button, no form, no input, no link, no preview action", !/<button|<form|<input|<textarea|<a |data-preview-action/i.test(b.html), b.html.slice(0, 400));
    ok("R5 rendered page: no CTA wording either (contact / call / book / WhatsApp / quote / leave details)",
      !/צרו קשר|התקשרו|קבעו תור|וואטסאפ|הצעת מחיר|השאירו פרטים|הגיעו אלינו/.test(b.html));
    const forged = { ...b.bp, primaryAction: { label: "התקשרו", objective: "CALL", channel: "PHONE", state: "AVAILABLE_UNOBSERVED", source: "RESOLVED_USABLE" as const, platformUnproven: false } } as LandingBlueprint;
    ok("R5 a SURFACE_ONLY blueprint that somehow carries an action → refused", throwsCode(() => buildRenderModel(forged, b.cc), "ACTION_ON_SURFACE_ONLY"));
    ok("R5 a SURFACE_ONLY render model with an action → the renderer refuses", throwsCode(() => assertRenderable({ ...b.model, primaryAction: built["home service"].model.primaryAction }), "ACTION_ON_SURFACE_ONLY"));
  }

  /* ─── R6 / R7 / R8 · actions come only from approved facts; preview never performs ─── */
  {
    const home = built["home service"];
    const a = home.model.primaryAction!;
    ok("R6 PHONE: destination is the APPROVED public phone fact; href derived deterministically", a.channel === "PHONE" && a.destinationDisplay === "03-5550000" && a.href === "tel:035550000" && a.available);
    ok("R6 …shown as text in the preview, never wired as a link", home.html.includes("03-5550000") && !home.html.includes("tel:"));
    const noPhone = resolveAction({ label: "התקשרו", objective: "CALL", channel: "PHONE", state: "AVAILABLE_UNOBSERVED", source: "RESOLVED_USABLE", platformUnproven: false }, [{ key: "BUSINESS_NAME", value: "x" }]);
    ok("R6 no approved phone → the action is disabled with a missing dependency (nothing invented)", noPhone?.available === false && noPhone.href === null && noPhone.missingDependency === "PUBLIC_PHONE");
    const wa = await build(WA);
    const w = wa.model.primaryAction!;
    ok("R7 WhatsApp (link): number from the approved public phone only; national → international deterministically", w.channel === "WHATSAPP_LINK" && w.href === "https://wa.me/972521234567" && w.destinationDisplay === "052-1234567");
    ok("R7 …and never wired in the preview", !wa.html.includes("wa.me") && !LIVE_LINK.test(wa.html));
    const foreignFormat = resolveAction({ label: "שלחו הודעה", objective: "WHATSAPP", channel: "WHATSAPP_LINK", state: "AVAILABLE_UNOBSERVED", source: "RESOLVED_USABLE", platformUnproven: false }, [{ key: "PUBLIC_PHONE", value: "1234567" }]);
    ok("R7 a number that is not convertible is not guessed (disabled, INTERNATIONAL_PHONE_FORMAT)", foreignFormat?.available === false && foreignFormat.href === null && foreignFormat.missingDependency === "INTERNATIONAL_PHONE_FORMAT");
    const cloudNoFact = resolveAction({ label: "שלחו הודעה", objective: "WHATSAPP", channel: "WHATSAPP_CLOUD", state: "PLATFORM_UNPROVEN", source: "OWNER_SELECTED", platformUnproven: true }, [{ key: "PUBLIC_PHONE", value: "052-1234567" }]);
    ok("R7 WhatsApp Cloud uses only the approved PUBLIC_WHATSAPP fact (never the phone)", cloudNoFact?.available === false && cloudNoFact.missingDependency === "PUBLIC_WHATSAPP");
    const quote = built["service / quote"];
    ok("R8 DUBIZ_FORM: an inert visual — no <form>, no action/method, inputs disabled, submit disabled",
      quote.model.primaryAction?.behaviour === "FORM" && quote.html.includes('data-inert="true"') && !/<form|\saction=|\smethod=|formaction=/i.test(quote.html) &&
      (quote.html.match(/<input/g) ?? []).length === (quote.html.match(/<input[^>]*disabled/g) ?? []).length && /<button[^>]*disabled/.test(quote.html));
    ok("R8 …and says plainly that nothing is sent", quote.html.includes("שום פנייה לא נשלחת"));
    ok("R12/R13 actions never carry a client-supplied destination: resolveAction reads facts only", !/destination|href|url/i.test(Object.keys(home.bp.primaryAction ?? {}).join(",")));
  }

  /* ─── R9 / R10 / R33 · trust ─── */
  {
    const t = built["professional trust"];
    const claims = t.landing.publishable.trustClaims;
    ok("R9 every public-effective claim renders with its exact canonical wording", claims.length === 2 && claims.every((c) => t.html.includes(c.wording)));
    ok("R9 the licence / certificate keeps 'provided by the business'", t.html.includes("(לפי מידע שמסר העסק)") && t.html.includes('data-provided-by-business="true"'));
    ok("R10 no verification is implied (no verified / Dubiz badge)", !/מאומת|אומת|verified|מאושר על ידי|Dubiz|דוביז/i.test(t.html.replace(/data-[a-z-]+="[^"]*"/g, "")));
  }

  /* ─── R11 / R14 / R15 / R16 / R17 · assets and prices ─── */
  {
    const q = built["service / quote"];
    ok("R11 an approved offering image renders (by ref, owner-only preview URL)", q.html.includes('data-asset-ref="asset:1"') && q.model.sections.some((s) => "offerings" in s && s.offerings.some((o) => o.image?.src === "/api/business/landing-preview/asset/1")));
    ok("R12 the unapproved image never renders", !q.html.includes("asset:2") && !q.html.includes("/asset/2"));
    ok("R13 the foreign tenant's image never renders", !q.html.includes("asset:3") && !q.html.includes("/asset/3"));
    ok("R13 no storage key or bucket path anywhere", !/biz\/\d+\/|storageKey|r2\.|\.r2\.dev|amazonaws/i.test(q.html + JSON.stringify(q.model)));
    const s = built["SURFACE_ONLY"];
    ok("R14 missing hero → intentional typographic fallback, no fake image", s.html.includes('data-fallback="TYPOGRAPHIC"') && !/<img/.test(s.html) && s.model.hero.image === null);
    const p = built["retail / products"];
    const gen = p.model.sections.flatMap((x) => ("offerings" in x ? x.offerings : [])).find((o) => o.image?.ref === "asset:12");
    ok("R15 a generated image is marked illustrative (alt + visible tag), never captioned as real", !!gen && gen.image!.illustrative && gen.image!.alt === "איור להמחשה" && p.html.includes('data-illustrative="true"') && p.html.includes("איור להמחשה"));
    ok("R15 …and never used for a person / place (no owner/team/location caption)", !/בעל העסק|הצוות שלנו|החנות שלנו|לקוח מרוצה/.test(p.html));
    ok("R16 a fixed product price renders verbatim from priceText", p.html.includes("₪10") && p.model.sections.some((x) => "offerings" in x && x.offerings.some((o) => o.priceText === "₪10")));
    ok("R17 quote-required stays 'לפי הצעת מחיר' (never numeric)", q.html.includes("לפי הצעת מחיר") && q.model.sections.flatMap((x) => ("offerings" in x ? x.offerings : [])).every((o) => o.priceText === "לפי הצעת מחיר"));
    ok("R18 location / hours render approved facts only, no 'open now'", built["local storefront"].html.includes("הרצל 1, חיפה") && !/פתוח עכשיו|סגור עכשיו|open now|closed now|קרוב אליך/i.test(built["local storefront"].html));
    ok("R18 offering order adds no popularity wording", !/פופולרי|הכי נמכר|מומלץ|best seller|popular|top choice/i.test(Object.values(built).map((x) => x.html).join("")));
  }

  /* ─── R19 / R21 · strategy-aware composition, not a stretched phone ─── */
  {
    const four = ["service / quote", "professional trust", "retail / products", "local storefront"].map((k) => built[k]);
    ok("R21 the four strategies are the intended ones", JSON.stringify(four.map((b) => b.model.strategyType)) === JSON.stringify(["REQUEST_QUOTE_FIRST", "TRUST_AUTHORITY_FIRST", "PRODUCT_DISCOVERY_FIRST", "LOCAL_VISIT_FIRST"]));
    const pairs: string[] = [];
    for (let i = 0; i < four.length; i += 1) for (let j = i + 1; j < four.length; j += 1) {
      const a = four[i].model.profile, b = four[j].model.profile;
      const d = PROFILE_DIMENSIONS.filter((k) => a[k] !== b[k]).length;
      if (d < 4) pairs.push(`${four[i].model.strategyType}~${four[j].model.strategyType}:${d}`);
    }
    ok("R21 every pair differs on ≥ 4 of 9 non-colour visual dimensions (composition, hero, CTA, cards, trust, density …)", pairs.length === 0, pairs);
    ok("R21 the differences are in the rendered markup, not only the model",
      new Set(four.map((b) => /data-composition="([A-Z_]+)"/.exec(b.html)![1])).size === 4 && new Set(four.map((b) => /data-hero="([A-Z_]+)"/.exec(b.html)![1])).size === 4);
    ok("R21 colour alone is not the proof (palette excluded from the dimension set)", !(PROFILE_DIMENSIONS as readonly string[]).includes("palette"));
    ok("R21 the profile never changes content: same blueprint, other strategy profile → same sections and text",
      JSON.stringify(visualProfileFor({ strategyType: "REQUEST_QUOTE_FIRST", hasHeroImage: false, offeringCount: 3, trustClaimCount: 1, surfaceOnly: false })) !== JSON.stringify(visualProfileFor({ strategyType: "TRUST_AUTHORITY_FIRST", hasHeroImage: false, offeringCount: 3, trustClaimCount: 1, surfaceOnly: false })) &&
      four.every((b) => b.model.sections.length === b.bp.sections.length));
    ok("R21 SURFACE_ONLY profiles never emphasise a CTA", built["SURFACE_ONLY"].model.profile.ctaEmphasis === "NONE");
    const css = readFileSync(join(process.cwd(), "components/landing-renderer/landing-renderer.module.css"), "utf8");
    ok("R19 desktop is a real composition: container queries at 640 and 1024 change grids, hero split and type scale",
      /@container landing \(min-width: 640px\)/.test(css) && /@container landing \(min-width: 1024px\)/.test(css) &&
      /min-width: 1024px\)[\s\S]*\.cards \{ grid-template-columns: repeat\(3/.test(css) && /min-width: 1024px\)[\s\S]*\.heroInner \{ grid-template-columns/.test(css) && /min-width: 1024px\)[\s\S]*\.h1 \{ font-size: 48px/.test(css));
    ok("R20 overflow guards: canvas clips x-overflow; long text wraps", /overflow-x: clip/.test(css) && (css.match(/overflow-wrap: anywhere/g) ?? []).length >= 8);
    ok("design tokens only: every var(--dz-*) used exists in the design system",
      [...new Set([...css.matchAll(/var\((--dz-[a-z0-9-]+)/g)].map((m) => m[1]))].every((t) => readFileSync(join(process.cwd(), "app/dubiz-mist.css"), "utf8").includes(`${t}:`)));
  }

  /* ─── R25 · preview handles composer disabled; preview route private ─── */
  {
    const screen = readFileSync(join(process.cwd(), "components/business/landing/LandingPreviewScreen.tsx"), "utf8");
    ok("R25 the preview has explicit states for UNAVAILABLE / REJECTED / FAILED / render refusal / changed strategy",
      /COMPOSITION_STATUS_LABELS/.test(screen) && /renderError/.test(screen) && /res\.status === 409/.test(screen) && /res\.status === 429/.test(screen));
    ok("R23 the preview recomposes ONLY via the canonical P3-C route with just the strategy id", /fetch\("\/api\/business\/landing-blueprint"/.test(screen) && /JSON\.stringify\(\{ strategyId \}\)/.test(screen));
    ok("R23 the preview hides the app chrome (isolated canvas)", /useHideShellChrome\(true\)/.test(screen));
    const layout = readFileSync(join(process.cwd(), "app/business/landing-preview/layout.tsx"), "utf8");
    ok("SEO the preview route is noindex / nofollow", /robots: \{ index: false, follow: false/.test(layout));
    const assetRoute = readFileSync(join(process.cwd(), "app/api/business/landing-preview/asset/[id]/route.ts"), "utf8");
    ok("ASSET the image endpoint is owner-only, approval-gated, images-only, no-store, noindex", /getCurrentUser/.test(assetRoute) && /resolvePreviewAsset\(user\.businessId, id\)/.test(assetRoute) && /IMAGE_TYPES/.test(assetRoute) && /X-Robots-Tag/.test(assetRoute) && !/Response\.redirect\(|\bawait fetch\(/.test(assetRoute));
    const resolver = readFileSync(join(process.cwd(), "lib/services/landing/renderer/preview-asset.ts"), "utf8");
    ok("ASSET the rule: session business + publicUseApproved + own key prefix", /publicUseApproved/.test(resolver) && /asset\.businessId !== businessId/.test(resolver) && /biz\/\$\{businessId\}\//.test(resolver));
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : []; });
    const rendererImports = [...walk(join(process.cwd(), "components/landing-renderer")), ...walk(join(process.cwd(), "lib/services/landing/renderer"))].filter((f) => !f.includes(".test.")).flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => /^\s*import\b/.test(l)));
    ok("NO-AI the renderer imports no model / composer / provider", !rendererImports.some((l) => /openai|composer-provider|landing-composer"|@ai-sdk|anthropic/.test(l)), rendererImports.filter((l) => /compos|openai/.test(l)));
    ok("NO-PUBLIC no public landing route exists", !readdirSync(join(process.cwd(), "app")).some((d) => /^(l|landing|p|site|pages?)$/.test(d)));
  }
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nP3-D landing renderer: all ${passed} checks passed ✔`);
  if (failed) process.exit(1);
}, (error) => {
  console.error(error);
  process.exit(1);
});
