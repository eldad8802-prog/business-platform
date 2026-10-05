/**
 * Test-only deterministic composer models (CI never calls a real model). goodDraft writes valid Hebrew
 * copy from the composer context using refs only; fakeModel wraps any producer as a ComposerModel.
 */
import type { ComposerDraft, DraftSection } from "../composer/blueprint-schema";
import type { LandingComposerContext } from "../composer/composer-context";
import type { ComposerModel } from "../composer/landing-composer";


export const HEBREW = /[֐-׿]/;
export const ctxFromPrompt = (user: string): LandingComposerContext => JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1));

export function label(objective: string, channel: string): string {
  if (objective === "BOOK") return channel === "PHONE" ? "קבעו תור בטלפון" : channel === "EMAIL" ? "קבעו תור במייל" : "קבעו תור בהודעה";
  if (objective === "REQUEST_QUOTE") return channel === "PHONE" ? "בקשו הצעת מחיר בטלפון" : channel === "EMAIL" ? "בקשו הצעת מחיר במייל" : channel === "DUBIZ_FORM" ? "בקשו הצעת מחיר" : "בקשו הצעת מחיר בהודעה";
  switch (channel) {
    case "PHONE": return "התקשרו אלינו";
    case "WHATSAPP_LINK":
    case "WHATSAPP_CLOUD": return "שלחו הודעה בוואטסאפ";
    case "EMAIL": return "כתבו לנו במייל";
    case "IN_PERSON": return "הגיעו אלינו";
    case "DUBIZ_FORM": return "השאירו פרטים";
    default: return "פנו אלינו";
  }
}

/** A well-behaved composer: copy from the data, refs only, no facts written. */
export function goodDraft(ctx: LandingComposerContext): ComposerDraft {
  const s = ctx.strategy;
  const none = s.primaryAction.kind === "NONE";
  const offeringsOf = (kind: "SERVICE" | "PRODUCT" | null) => (kind ? ctx.offerings.filter((o) => o.kind === kind) : ctx.offerings.filter((o) => o.ownerFeatured).length ? ctx.offerings.filter((o) => o.ownerFeatured) : ctx.offerings)
    .slice(0, 6).map((o) => ({ offeringRef: o.ref, blurb: "פרטים נוספים כאן בדף." }));
  const sections: DraftSection[] = [];
  for (const plan of s.sections) {
    if (plan.section === "HERO" || !plan.composable) continue;
    switch (plan.section) {
      case "PRIMARY_ACTION":
      case "CONTACT_PANEL":
        if (!none) sections.push({ sectionType: plan.section, heading: "איך פונים אלינו", body: "נשמח לשמוע מכם." });
        break;
      case "ABOUT":
        sections.push({ sectionType: "ABOUT", heading: "על העסק", body: "קצת עלינו.", statementRefs: ctx.statements.filter((x) => x.dimension === "DESCRIPTION").map((x) => x.ref) });
        break;
      case "SERVICE_AREA":
        sections.push({ sectionType: "SERVICE_AREA", heading: "איפה אנחנו עובדים", statementRefs: ctx.statements.filter((x) => x.dimension === "SERVICE_AREA").map((x) => x.ref) });
        break;
      case "SERVICES_OVERVIEW":
        sections.push({ sectionType: "SERVICES_OVERVIEW", heading: "השירותים", intro: "מה אפשר לקבל אצלנו.", items: offeringsOf("SERVICE") });
        break;
      case "PRODUCTS_SHOWCASE":
        sections.push({ sectionType: "PRODUCTS_SHOWCASE", heading: "המוצרים", intro: "מבחר מהמוצרים שלנו.", items: offeringsOf("PRODUCT") });
        break;
      case "FEATURED_OFFERINGS":
        sections.push({ sectionType: "FEATURED_OFFERINGS", heading: "שווה להכיר", intro: "כמה דברים שבחרנו להציג.", items: offeringsOf(null) });
        break;
      case "TRUST_PROOF":
        sections.push({ sectionType: "TRUST_PROOF", heading: "כדאי לדעת", intro: "מידע שהעסק מסר עליו.", trustClaimRefs: ctx.trustClaims.map((c) => c.ref) });
        break;
      case "QUOTE_PROCESS":
        sections.push({ sectionType: "QUOTE_PROCESS", heading: "איך זה עובד", steps: ["מספרים לנו מה צריך", "אנחנו עוברים על הפרטים", "מקבלים הצעה מסודרת"] });
        break;
      case "BOOKING_INFO":
        sections.push({ sectionType: "BOOKING_INFO", heading: "איך קובעים", steps: ["בוחרים שירות", "פונים אלינו", "מתאמים מועד"] });
        break;
      case "LOCATION_AND_HOURS":
        sections.push({ sectionType: "LOCATION_AND_HOURS", heading: "איפה ומתי", factRefs: ctx.facts.filter((f) => f.key === "PUBLIC_ADDRESS" || f.key === "OPENING_HOURS").map((f) => f.ref) });
        break;
    }
  }
  return {
    pageIntent: "דף שמציג את העסק בצורה ברורה",
    hero: { headline: `ברוכים הבאים ל${ctx.businessName ?? "עסק"}`, subheadline: "כל מה שחשוב לדעת עלינו, במקום אחד.", assetRef: ctx.assets[0]?.ref ?? null },
    sections,
    primaryActionLabel: s.primaryAction.kind === "ACTION" ? label(s.primaryAction.objective, s.primaryAction.channel) : null,
    secondaryActionLabel: s.secondaryAction.kind === "ACTION" ? label(s.secondaryAction.objective, s.secondaryAction.channel) : null,
    metaTitle: ctx.businessName ?? "העסק",
    metaDescription: "דף העסק",
  };
}

export type Produce = (ctx: LandingComposerContext, attempt: number) => unknown;
export function fakeModel(produce: Produce): ComposerModel & { calls: number; prompts: string[] } {
  const m = {
    name: "fake",
    model: "fake-composer",
    calls: 0,
    prompts: [] as string[],
    async complete(_system: string, user: string) {
      m.calls += 1;
      m.prompts.push(user);
      const out = produce(ctxFromPrompt(user), m.calls);
      return { ok: true as const, text: typeof out === "string" ? out : JSON.stringify(out), inputTokens: 100, outputTokens: 50, latencyMs: 3 };
    },
  };
  return m;
}
export const good = () => fakeModel((ctx) => goodDraft(ctx));
