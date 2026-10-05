import { COMPOSABLE_SECTIONS, type ComposerDraft, type DraftSection, type StructuralError } from "./blueprint-schema";
import type { LandingComposerContext } from "./composer-context";

/**
 * P3-C · Deterministic blueprint validator — independent of the prompt. A draft is SAFE only if every
 * check below passes; the model's own claims about itself are never consulted.
 *
 * Violation classes (what the composer does with them):
 *   STRUCTURAL_REPAIRABLE  shape / length / a required section missing → ONE controlled repair attempt
 *   AUTHORITY_VIOLATION    changed conversion, CTA on SURFACE_ONLY, strengthened trust, non-public text → fail closed
 *   UNSUPPORTED_REFERENCE  any ref outside the composer context (other tenant, unapproved, invented) → fail closed
 *   UNSUPPORTED_CLAIM      superlatives, testimonials / reviews / ratings, counts, years, prices, URLs,
 *                          availability promises, popularity, a section implying a missing capability → fail closed
 * Nothing is silently removed or rewritten: a draft either passes as is, or it is rejected.
 */

export type ViolationClass = "STRUCTURAL_REPAIRABLE" | "AUTHORITY_VIOLATION" | "UNSUPPORTED_REFERENCE" | "UNSUPPORTED_CLAIM";
export type Violation = { class: ViolationClass; code: string; path: string };

/** Material the composer never saw but the validator must be able to recognise if a model emits it. */
export type ValidatorGuard = {
  /** Text of owner statements that are NOT publishable (internal, unapproved, claim-like awaiting review). */
  nonPublicTexts: string[];
};

/* ─── copy lexicons (Hebrew + English). Deterministic, conservative: a hit rejects. ─── */

const SUPERLATIVE = /(number\s*(1|one)|#\s*1\b|\bno\.?\s*1\b|\bleading\b|\bbest\b|\btop[-\s]?rated\b|\bfastest\b|\bcheapest\b|most\s+trusted|\brecommended\b|\bunbeatable\b|\b(?:the\s+)?only\s+\w+\s+(?:in|that)\b|מספר\s*(1|אחת?)\b|המוביל|המובילה|המובילים|הכי\s|הטוב(?:ה|ים)?\s+ביותר|הזול(?:ה|ים)?\s+ביותר|המהיר(?:ה|ים)?\s+ביותר|האמין(?:ה|ים)?\s+ביותר|המקצועי(?:ת|ים)?\s+ביותר|מומלצ(?:ת|ים|ות)?|מומלץ|ללא\s+מתחרים|אין\s+כמונו|הראשון\s+בישראל|בלעדי)/i;
const TESTIMONIAL_REVIEW = /(\btestimonial|\breview|\brating|\bstars?\b|★|☆|\d\s*\/\s*5\b|\d(\.\d)?\s*כוכבים|ביקורות|ביקורת|דירוג|המלצות\s+של\s+לקוחות|לקוחות\s+(?:ממליצים|מספרים|אומרים|מרוצים|אוהבים)|"[^"]{3,}"\s*[-–—]\s*\S+|״[^״]{3,}״)/i;
const CUSTOMER_COUNT = /(\d[\d,.]*\s*\+?\s*(?:לקוחות|לקוחה|משפחות|עסקים|customers|clients|families))|((?:לקוחות|customers|clients)\s*(?:מרוצים)?\s*\d)|(אלפי|מאות|עשרות)\s+(?:לקוחות|משפחות|עסקים)/i;
const YEARS_EXPERIENCE = /(מאז\s+\d{4}|\d+\s*\+?\s*שנ(?:ים|ות)\s+(?:של\s+)?(?:ניסיון|ותק|פעילות)|שנות\s+ניסיון|ותק\s+של|\bsince\s+\d{4}|\d+\s*\+?\s*years)/i;
const CREDENTIAL = /(רישיון|רשיון|מורשה|מורשית|מוסמך|מוסמכת|מוסמכים|הסמכה|תעודה|תעודת|\blicen[cs]ed?\b|\bcertifi(ed|cate|cation)\b|authori[sz]ed\s+dealer|יבואן|משווק\s+מורשה)/i;
const GUARANTEE = /(אחריות|מובטח|מובטחת|הבטחת|ערבות|החזר\s+כספי|\bguarantee|\bwarrant)/i;
const VERIFICATION_STRENGTHENING = /(מאומת|מאומתת|אומת|אושר\s+על\s+ידי|מאושר\s+על\s+ידי|נבדק\s+על\s+ידי|בדוק|רשמי(?:ת)?|מוכר(?:ת)?\s+רשמית|verified|officially|certified\s+by|checked\s+by|approved\s+by)/i;
const PRICE_OR_DISCOUNT = /(₪|ש"ח|ש״ח|\bNIS\b|\bILS\b|שקל|\d+\s*%|הנחה|מבצע|חינם|ללא\s+עלות|במחיר|\bfree\b|\bdiscount|\bsale\b|\$\s*\d|\d+\s*\$)/i;
const AVAILABILITY_PROMISE = /(24\s*\/\s*7|24\s*שעות|מסביב\s+לשעון|תוך\s+\d+|באותו\s+היום|באותו\s+יום|מיידי|מייד|זמינים\s+תמיד|תמיד\s+זמינים|משלוח|הגעה\s+תוך|\bsame[-\s]day\b|\bwithin\s+\d+|\bfree\s+shipping|\bdelivery\b)/i;
const HOURS_OR_ADDRESS = /(\b\d{1,2}:\d{2}\b|\bרח(?:וב|')\s|\bשד(?:רות|')\s|ימים\s+א['׳]?\s*[-–]|\bsun(?:day)?\s*[-–])/i;
const POPULARITY = /(הכי\s+מבוקש|המבוקש(?:ים|ת)?|הנמכר(?:ים|ת)?|האהוב(?:ים|ה)?|לקוחות\s+בוחרים|כולם\s+בוחרים|פופולרי|להיט|רב[-\s]?מכר|\bbest[-\s]?sell|\bpopular\b|\bmost\s+(?:loved|requested|ordered)|\btrending\b|\bfavou?rite\b)/i;
const URL_OR_CONTACT = /(https?:\/\/|www\.|\.co\.il\b|\.com\b|\.net\b|\.org\b|@\w|\b0\d{1,2}[-\s]?\d{3}[-\s]?\d{4}\b|\+972|\/storage\/|\.jpe?g\b|\.png\b|\.webp\b)/i;
const HTML_OR_MARKUP = /(<\s*\/?\s*[a-z][^>]*>|\]\(|\*\*|^#{1,6}\s|```|\bclassName\b|\bstyle\s*=)/im;

/* ─── CTA wording vs the deterministic channel / objective ─── */

const CTA_LEXICON: { pattern: RegExp; allowed: (objective: string, channel: string) => boolean; code: string }[] = [
  { pattern: /(לרכישה|קנו\s+עכשיו|קנה\s+עכשיו|הוסיפו\s+לסל|לסל|לקופה|הזמינו\s+(?:עכשיו|אונליין)|checkout|\bbuy\b|add\s+to\s+cart|order\s+now)/i, allowed: () => false, code: "CTA_UNSUPPORTED_CHECKOUT" },
  { pattern: /(קבעו\s+תור|לקביעת\s+תור|קביעת\s+תור|הזמינו\s+תור|שריינו|\bbook\b|booking|schedule)/i, allowed: (o) => o === "BOOK", code: "CTA_UNSUPPORTED_BOOKING" },
  { pattern: /(וואטסאפ|ווטסאפ|whatsapp|שלחו\s+הודעה|כתבו\s+לנו|הודעה)/i, allowed: (_o, c) => c === "WHATSAPP_LINK" || c === "WHATSAPP_CLOUD" || c === "EMAIL", code: "CTA_CHANNEL_MISMATCH" },
  { pattern: /(התקשרו|חייגו|לשיחה|טלפון|\bcall\b|phone)/i, allowed: (_o, c) => c === "PHONE", code: "CTA_CHANNEL_MISMATCH" },
  { pattern: /(מייל|אימייל|\bemail\b|דוא"ל|דוא״ל)/i, allowed: (_o, c) => c === "EMAIL", code: "CTA_CHANNEL_MISMATCH" },
  { pattern: /(הגיעו|בואו\s+לבקר|לביקור|לחנות|\bvisit\b|directions|נווטו)/i, allowed: (_o, c) => c === "IN_PERSON", code: "CTA_CHANNEL_MISMATCH" },
  { pattern: /(הצעת\s+מחיר|\bquote\b)/i, allowed: (o) => o === "REQUEST_QUOTE", code: "CTA_OBJECTIVE_MISMATCH" },
];

/** Every AI-written string in the draft, with its path. */
function textsOf(draft: ComposerDraft): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [
    { path: "$.pageIntent", text: draft.pageIntent },
    { path: "$.hero.headline", text: draft.hero.headline },
    { path: "$.hero.subheadline", text: draft.hero.subheadline },
    { path: "$.metaTitle", text: draft.metaTitle },
    { path: "$.metaDescription", text: draft.metaDescription },
  ];
  if (draft.primaryActionLabel) out.push({ path: "$.primaryActionLabel", text: draft.primaryActionLabel });
  if (draft.secondaryActionLabel) out.push({ path: "$.secondaryActionLabel", text: draft.secondaryActionLabel });
  // Sections are scanned defensively: an out-of-vocabulary section (already rejected) may have any shape.
  const push = (path: string, text: unknown) => { if (typeof text === "string") out.push({ path, text }); };
  draft.sections.forEach((section, i) => {
    const s = section as unknown as Record<string, unknown>;
    const p = `$.sections[${i}]`;
    for (const k of Object.keys(s)) if (k !== "sectionType" && typeof s[k] === "string" && !/Ref$/.test(k)) push(`${p}.${k}`, s[k]);
    if (Array.isArray(s.items)) s.items.forEach((it, j) => push(`${p}.items[${j}].blurb`, (it as { blurb?: unknown })?.blurb));
    if (Array.isArray(s.steps)) s.steps.forEach((st, j) => push(`${p}.steps[${j}]`, st));
  });
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function structuralViolations(errors: StructuralError[]): Violation[] {
  return errors.map((e) => ({ class: "STRUCTURAL_REPAIRABLE", code: `STRUCTURE_${e.problem}`, path: e.path }));
}

/** Validate a structurally parsed draft against the composer context. Pure. */
export function validateDraft(draft: ComposerDraft, ctx: LandingComposerContext, guard: ValidatorGuard): Violation[] {
  const v: Violation[] = [];
  const add = (cls: ViolationClass, code: string, path: string) => v.push({ class: cls, code, path });
  const strat = ctx.strategy;
  const allowed = {
    offerings: new Set(ctx.offerings.map((o) => o.ref)),
    trust: new Set(ctx.trustClaims.map((c) => c.ref)),
    assets: new Set(ctx.assets.map((a) => a.ref)),
    facts: new Set(ctx.facts.map((f) => f.ref)),
    statements: new Set(ctx.statements.map((s) => s.ref)),
  };

  // ── sections: closed vocabulary, only the strategy's sections, only sections that have data ──
  const planned = new Map(strat.sections.map((s) => [s.section, s]));
  const seen = new Set<string>();
  draft.sections.forEach((s, i) => {
    const path = `$.sections[${i}]`;
    const type = (s as { sectionType: string }).sectionType;
    if ((type === "PRIMARY_ACTION" || type === "CONTACT_PANEL") && strat.primaryAction.kind === "NONE") add("AUTHORITY_VIOLATION", "ACTION_SECTION_ON_SURFACE_ONLY", path);
    if (!(COMPOSABLE_SECTIONS as readonly string[]).includes(type)) return add("UNSUPPORTED_CLAIM", "SECTION_NOT_IN_VOCABULARY", path);
    const plan = planned.get(type as DraftSection["sectionType"]);
    if (!plan) return add("UNSUPPORTED_CLAIM", "SECTION_NOT_IN_STRATEGY", path);
    if (!plan.composable) add("UNSUPPORTED_CLAIM", "SECTION_WITHOUT_AUTHORISED_DATA", path);
    if (seen.has(type)) add("STRUCTURAL_REPAIRABLE", "SECTION_DUPLICATED", path);
    seen.add(type);
  });
  for (const s of strat.sections) {
    const needed = s.section !== "HERO" && s.required && s.composable && !(strat.primaryAction.kind === "NONE" && (s.section === "PRIMARY_ACTION" || s.section === "CONTACT_PANEL"));
    if (needed && !seen.has(s.section)) add("STRUCTURAL_REPAIRABLE", "REQUIRED_SECTION_MISSING", `$.sections<${s.section}>`);
  }

  // ── references: everything must come from the composer context ──
  const ref = (set: Set<string>, value: string, code: string, path: string) => { if (!set.has(value)) add("UNSUPPORTED_REFERENCE", code, path); };
  if (draft.hero.assetRef !== null) {
    if (URL_OR_CONTACT.test(draft.hero.assetRef)) add("UNSUPPORTED_REFERENCE", "ASSET_URL_OR_PATH", "$.hero.assetRef");
    else ref(allowed.assets, draft.hero.assetRef, "ASSET_NOT_ALLOWED", "$.hero.assetRef");
  }
  draft.sections.forEach((s, i) => {
    const p = `$.sections[${i}]`;
    if ("items" in s && Array.isArray(s.items)) {
      const kind = s.sectionType === "PRODUCTS_SHOWCASE" ? "PRODUCT" : s.sectionType === "SERVICES_OVERVIEW" ? "SERVICE" : null;
      s.items.forEach((it, j) => {
        ref(allowed.offerings, it.offeringRef, "OFFERING_NOT_ALLOWED", `${p}.items[${j}].offeringRef`);
        if (kind && allowed.offerings.has(it.offeringRef) && !it.offeringRef.startsWith(`offering:${kind}:`)) add("STRUCTURAL_REPAIRABLE", "OFFERING_KIND_MISMATCH", `${p}.items[${j}].offeringRef`);
      });
      if (!s.items.length) add("STRUCTURAL_REPAIRABLE", "OFFERING_SECTION_EMPTY", `${p}.items`);
    }
    if ("trustClaimRefs" in s && Array.isArray(s.trustClaimRefs)) {
      s.trustClaimRefs.forEach((r, j) => ref(allowed.trust, r, "TRUST_CLAIM_NOT_ALLOWED", `${p}.trustClaimRefs[${j}]`));
      if (!s.trustClaimRefs.length) add("STRUCTURAL_REPAIRABLE", "TRUST_SECTION_EMPTY", `${p}.trustClaimRefs`);
    }
    if ("factRefs" in s && Array.isArray(s.factRefs)) s.factRefs.forEach((r, j) => ref(allowed.facts, r, "FACT_NOT_ALLOWED", `${p}.factRefs[${j}]`));
    if ("statementRefs" in s && Array.isArray(s.statementRefs)) s.statementRefs.forEach((r, j) => ref(allowed.statements, r, "STATEMENT_NOT_ALLOWED", `${p}.statementRefs[${j}]`));
  });

  // ── conversion: labels only, and only where an action exists; wording must match the channel ──
  const checkLabel = (label: string | null, action: LandingComposerContext["strategy"]["primaryAction"], path: string) => {
    if (label === null) return;
    if (action.kind === "NONE") return add("AUTHORITY_VIOLATION", "CTA_ON_SURFACE_ONLY", path);
    for (const rule of CTA_LEXICON) if (rule.pattern.test(label) && !rule.allowed(action.objective, action.channel)) add("AUTHORITY_VIOLATION", rule.code, path);
  };
  checkLabel(draft.primaryActionLabel, strat.primaryAction, "$.primaryActionLabel");
  checkLabel(draft.secondaryActionLabel, strat.secondaryAction, "$.secondaryActionLabel");
  if (strat.primaryAction.kind === "ACTION" && draft.primaryActionLabel === null) add("STRUCTURAL_REPAIRABLE", "PRIMARY_ACTION_LABEL_MISSING", "$.primaryActionLabel");

  // ── copy: claims only via refs; nothing invented, strengthened or leaked ──
  v.push(...copyViolations(textsOf(draft), guard));

  return v;
}

/**
 * Claim / authority checks over AI-written strings. Also run on a structurally BROKEN draft (every
 * string in the raw JSON), so a claim violation can never ride along into a "structural" repair.
 */
export function copyViolations(texts: { path: string; text: string }[], guard: ValidatorGuard): Violation[] {
  const v: Violation[] = [];
  const add = (cls: ViolationClass, code: string, path: string) => v.push({ class: cls, code, path });
  const nonPublic = guard.nonPublicTexts.map(norm).filter((t) => t.length >= 8);
  for (const { path, text } of texts) {
    if (HTML_OR_MARKUP.test(text)) add("STRUCTURAL_REPAIRABLE", "MARKUP_IN_COPY", path);
    if (URL_OR_CONTACT.test(text)) add("UNSUPPORTED_CLAIM", "URL_OR_CONTACT_IN_COPY", path);
    if (SUPERLATIVE.test(text)) add("UNSUPPORTED_CLAIM", "SUPERLATIVE", path);
    if (TESTIMONIAL_REVIEW.test(text)) add("UNSUPPORTED_CLAIM", "TESTIMONIAL_OR_REVIEW", path);
    if (CUSTOMER_COUNT.test(text)) add("UNSUPPORTED_CLAIM", "CUSTOMER_COUNT", path);
    if (YEARS_EXPERIENCE.test(text)) add("UNSUPPORTED_CLAIM", "YEARS_IN_BUSINESS", path);
    if (CREDENTIAL.test(text)) add("UNSUPPORTED_CLAIM", "CREDENTIAL_IN_COPY", path);
    if (GUARANTEE.test(text)) add("UNSUPPORTED_CLAIM", "GUARANTEE_IN_COPY", path);
    if (VERIFICATION_STRENGTHENING.test(text)) add("AUTHORITY_VIOLATION", "TRUST_STRENGTHENED", path);
    if (PRICE_OR_DISCOUNT.test(text)) add("UNSUPPORTED_CLAIM", "PRICE_OR_DISCOUNT_IN_COPY", path);
    if (AVAILABILITY_PROMISE.test(text)) add("UNSUPPORTED_CLAIM", "AVAILABILITY_OR_DELIVERY_PROMISE", path);
    if (HOURS_OR_ADDRESS.test(text)) add("UNSUPPORTED_CLAIM", "HOURS_OR_ADDRESS_IN_COPY", path);
    if (POPULARITY.test(text)) add("UNSUPPORTED_CLAIM", "POPULARITY_WORDING", path);
    const n = norm(text);
    if (nonPublic.some((t) => n.includes(t))) add("AUTHORITY_VIOLATION", "NON_PUBLIC_TEXT_IN_COPY", path);
  }
  return v;
}

/** Every string value of arbitrary (possibly malformed) model JSON, except refs and section types. */
export function looseTexts(value: unknown, path = "$"): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((x, i) => looseTexts(x, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== "sectionType" && !/Refs?$/.test(k))
      .flatMap(([k, x]) => looseTexts(x, `${path}.${k}`));
  }
  return [];
}

export const REPAIRABLE_ONLY = (violations: Violation[]) => violations.length > 0 && violations.every((x) => x.class === "STRUCTURAL_REPAIRABLE");
