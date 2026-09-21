import type { Metadata } from "next";
import Link from "next/link";
import { Section } from "@/components/corporate/Section";
import { ProductProof, type ProofArea } from "@/components/corporate/ProductProof";
import { PrimaryCta } from "@/components/ui/primary-cta";
import {
  isPublicSignupEnabled,
  SIGNUP_DISABLED_TITLE_HE,
  SIGNUP_DISABLED_MESSAGE_HE,
} from "@/lib/auth/signup-gate";

/**
 * Dubiz Homepage — FINAL CANDIDATE.
 *
 * Not production. `/home` (Homepage v1) and `/home-prototype` (V2.1) are both
 * untouched and stay available for side-by-side visual QA. This route is the
 * promotion candidate and nothing links to it yet.
 *
 * ## Lineage
 *
 * Product decision (locked): **Prototype V2.1 is the base.** This is not a V3
 * and it does not return to the `/home` information architecture. What V2.1 got
 * right is kept verbatim in spirit: a fold that opens on a MOMENT rather than a
 * claim, Hebrew set right-aligned, no decorative emoji, no decorative pills, and
 * before→after as the way the product is explained.
 *
 * What the browser audit found missing has been folded back in:
 *
 *   CHANGE 1  A single product-orientation sentence, promoted to the second beat
 *             of the fold, so "is this my world" and "what is this" both land
 *             inside the first few seconds.
 *   CHANGE 2  The product fragment now ends on a component boundary instead of
 *             slicing through an amount row. See `ProductFragment`.
 *   CHANGE 3  Product proof rebuilt: four real areas, one readable at a time.
 *   CHANGE 4  The two before/after sections merged into one. Nine beats, not ten.
 *   CHANGE 5  Legitimacy expanded from a thin strip to a compact, right-aligned
 *             block that actually answers the tax-authority / accountant question.
 *   CHANGE 6  The honest five-question FAQ restored from the ratified copy.
 *   CHANGE 7  Weight ceiling 600 — Heebo ships 300–600, so `font-bold` (700) and
 *             `font-extrabold` (800) were both being synthesised by the browser.
 *   CHANGE 8  Exactly two `.dz-btn-primary` on the page. Header login is a ghost.
 *
 * ## Copy
 *
 * V2.1's strings were prototype PLACEHOLDERs and had never been through the copy
 * gate — three of them actually violated it (a persona ceiling forbidden by
 * §12, an autonomous-send implication forbidden by §8, and an aging claim). Every
 * string here is recorded, sourced and gate-checked in
 * `docs/dubiz-homepage-final-candidate-copy-v2-1.md`, which was written BEFORE
 * this file. Do not add a string to this page that is not in that document.
 *
 * Governed by: `dubiz-homepage-pre-copy-gate-v1.md` · `dubiz-homepage-copy-v1.md`
 * · `dubiz-homepage-visual-design-spec-v1.md`. Visual system: Dubiz Mist.
 */

/**
 * The whole CTA contract is derived from `PUBLIC_SIGNUP_ENABLED`, which is read
 * from the server environment. Without this the route prerenders and the flag's
 * value at BUILD time gets baked into the HTML — flipping it in Vercel would then
 * change nothing until the next deploy, which is exactly the "hard-coded copy"
 * failure this page is required to avoid. `/home-prototype` opts out for the same
 * reason.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Dubiz — מועמד לדף הבית" },
  description: "מועמד פנימי לדף הבית — לא לפרסום.",
  robots: { index: false, follow: false },
};

/* ───────────────────────── FOLD · what is already in order ─────────────────────
 * Representative and static. Each row is a STATE, never an action Dubiz took on
 * its own: V2.1's version ("בזמן שעבדת … חשבונית — נשלחה ונרשמה") implied
 * autonomous outbound work, which §8 forbids and which the safety section three
 * screens later explicitly denies. A payment link is "מוכן", never "נשלח".
 * ---------------------------------------------------------------------------- */
const IN_ORDER: Array<[string, string]> = [
  ["קבלה מספק", "ספק, סכום ותאריך זוהו"],
  ["חשבונית פתוחה", "₪3,200 · קישור לתשלום מוכן"],
  ["פנייה בוואטסאפ", "ממתינה לתשובה שלך"],
];

/* ───────────────────────── MIRROR · the accumulation ─────────────────────────
 * Four beats, each a separate line. Right-aligned against a rule: centred
 * multi-line Hebrew is the least readable setting there is, and this is the one
 * section that gets read word for word.
 * ---------------------------------------------------------------------------- */
const ACCUMULATION = [
  "לקוח שאל מחיר. אמרת שתחזור אליו. לא חזרת.",
  "קבלה מספק נשארה ברכב.",
  "מישהו לא שילם, ואתה לא זוכר מי.",
  "יש תשלום ב-10 בחודש שאסור לפספס.",
];

/* ───────────────────────── SAFETY · four quiet facts ─────────────────────────
 * Out of the bordered card that made it read like terms of service. No padlocks.
 * ---------------------------------------------------------------------------- */
const SAFETY: Array<[string, string]> = [
  ["אתה בוחר מה מתחבר", "ואפשר לנתק בכל רגע"],
  ["נשמר מה שקשור לעסק", "חשבוניות, תשלומים, פניות של לקוחות"],
  ["כלום לא נשלח בשמך", "לא ללקוח, לא לספק, לא לרשות — בלי שאישרת"],
  ["המידע שלך נשאר שלך", "עם ייצוא מסודר בכל רגע"],
];

/* ───────────────── BEFORE → AFTER (merged with the old projection) ─────────────
 * `had` is an object from his world. `did` is the state Dubiz holds it in. The
 * pair proves CHANGE; a screenshot alone only proves existence.
 *
 * Shape carries meaning here and nowhere else on the page: the `had` side is
 * dashed (unresolved), the `did` side is solid paper (resolved).
 * ---------------------------------------------------------------------------- */
const TRANSFORMATIONS = [
  {
    had: "חשבונית ששלחת לפני חודש ולא זוכר אם שולמה",
    hadNote: "בין המיילים, בוואטסאפ, ובראש",
    did: "פתוח · ₪3,400 · קישור לתשלום מוכן",
    didNote: "מופיע ברשימה אחת עם כל מה שעוד פתוח",
  },
  {
    had: "הודעה מלקוח שנקברה מתחת ל-40 הודעות",
    hadNote: "נשלחה ב-9:15, כשהידיים היו תפוסות",
    did: "פנייה פתוחה · ממתינה לתשובה",
    didNote: "עולה למעלה עד שתטפל, ולא נעלמת",
  },
  {
    had: "קבלה מקומטת מספק, מצולמת בטלפון",
    hadNote: "אחת מתוך ערימה בתא הכפפות",
    did: "ספק · סכום · תאריך — מזוהים ומתויקים",
    didNote: "בסוף החודש כבר ערוך לרואה החשבון",
  },
];

/* ───────────────────────── PRODUCT PROOF · four real areas ────────────────────
 * Crops are measured in SOURCE pixels of the 780×1688 assets and each boundary
 * sits in the GAP between two components — never through text, never through an
 * amount row. See `ProductFragment` for the arithmetic.
 *
 * `conversations.webp` is deliberately NOT used: it was captured before the Mist
 * migration (#311) and still carries the old white/cyan palette, so next to three
 * warm screens it would read as a different product. Re-capturing it is tracked
 * as a follow-up; the breadth line still names השיחות, because that is a verified
 * capability and does not depend on having a current screenshot of it.
 * ---------------------------------------------------------------------------- */
const PROOF_AREAS: ProofArea[] = [
  {
    label: "גבייה",
    src: "/landing/collection.webp",
    alt: "מרכז הגבייה של Dubiz — כמה גביות פתוחות, סכום שפג תוקפו, סכום שנגבה החודש וסכום ממתין, ולצידם פעולת קבלת תשלום",
    // Title → summary sentence → the three amounts → the payment action.
    // Ends in the gap below the button, above "דורש טיפול".
    crop: { top: 0, bottom: 700 },
    caption:
      "רואים מה שולם ומה עדיין פתוח, ושולחים ללקוח קישור לתשלום בלחיצה.",
  },
  {
    label: "מסמכים",
    src: "/landing/documents-home.webp",
    alt: "קליטת מסמך ב-Dubiz — צילום או העלאת קובץ, והמערכת מזהה ספק, סכום ותאריך",
    // The complete intake card, gap to gap.
    crop: { top: 395, bottom: 1120 },
    caption: "מצלמים חשבונית — Dubiz מזהה ספק, סכום ותאריך לבד.",
  },
  {
    label: "חשבוניות",
    src: "/landing/billing.webp",
    alt: "מסך החיוב של Dubiz — יצירת חשבונית או הצעת מחיר, וטיוטה שממתינה להמשך עבודה",
    // Heading → the two create actions → the draft that waits for you.
    crop: { top: 140, bottom: 1040 },
    caption:
      "חשבונית או הצעת מחיר נפתחות מכאן, וכל טיוטה ממתינה במקום שבו עצרת.",
  },
  {
    label: "לקוחות",
    src: "/landing/customer-card.webp",
    alt: "כרטיס לקוח ב-Dubiz — פרטי קשר, שם משפטי, מספר עוסק וסטטוס פעילות",
    // The customer card itself, whole.
    crop: { top: 100, bottom: 830 },
    caption:
      "כל לקוח במקום אחד — פרטים, מסמכים, תשלומים ושיחות. תמיד תדע איפה אתה עומד מולו.",
  },
];

/* ───────────────────────── TAIL · the honest five ─────────────────────────────
 * Restored verbatim from the ratified copy. V2.1 cut these to three rewritten
 * placeholders. Question 2 states what does NOT exist and is the single most
 * valuable line on the page — it is never trimmed, on any breakpoint.
 * ---------------------------------------------------------------------------- */
const FAQ = [
  {
    q: "כבר יש לי חשבונית ירוקה / תוכנת חשבוניות.",
    a: "מצוין. Dubiz לא מחליפה אותה — היא מרכזת סביבה את כל השאר: הלקוחות, הגבייה, המסמכים והשיחות. מתחילים בלי לוותר על כלום.",
  },
  {
    q: "זה עובד עם צוות / עובדים?",
    a: "כרגע Dubiz בנויה לבעל העסק שמנהל את היום־יום בעצמו. גישת-צוות עם הרשאות עדיין לא קיימת — אנחנו בונים אותה.",
  },
  {
    q: "מה עם רואה החשבון שלי?",
    a: "הכול יוצא מסודר לרואה החשבון, בפורמט תקין ומוכן להעברה.",
  },
  {
    q: "מה קורה עם הנתונים שלי?",
    a: "נקלט רק מה שקשור לעסק, המידע נשאר שלך, ושום דבר לא יוצא החוצה בלי אישורך.",
  },
  {
    q: "אני חייב להעביר הכול?",
    a: "לא. מתחילים מהמקום שבו העסק כבר חי — וואטסאפ, מייל וקבלות — ומתקדמים בקצב שלך.",
  },
];

/** Weight ceiling 600: Heebo is loaded at 300–600, so anything above is faked. */
function Heading({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      id={id}
      className={`text-2xl font-semibold leading-snug text-[var(--mkt-ink)] sm:text-3xl ${className}`}
    >
      {children}
    </h2>
  );
}

export default function HomeCandidatePage() {
  // Single source of truth — the same server-side gate `/register` itself uses.
  // No second flag, no duplicated logic, no hard-coded copy: this page only reads
  // the decision. While registration is closed the page must not invite a
  // stranger to sign up and then hand them a "registration is closed" screen, so
  // the destination, the label, the ask and the quiet link are ALL derived.
  const signupOpen = isPublicSignupEnabled();
  const ctaHref = signupOpen ? "/register" : "/login";
  const ctaLabel = signupOpen ? "התחילו עכשיו" : "כניסה למשתמשים קיימים";

  return (
    <>
      {/* ================================================================= */}
      {/* S1 · FOLD — moment → product orientation → framing → support      */}
      {/* ================================================================= */}
      <Section tone="base" pad="lg" padB="sm">
        {/*
          Application identity. States as real visible text that this application
          is named Dubiz and is operated by PRO MAX GROUP, matching the OAuth
          consent-screen name and the footer / privacy / terms / about pages.
          A compliance constraint, not a marketing line — and a regression in
          V2.1, which dropped it entirely.
        */}
        <p className="text-sm text-[var(--dz-text-secondary)]">
          <span className="font-semibold text-[var(--mkt-ink)]">Dubiz</span>{" "}
          — מופעל על ידי PRO MAX GROUP
        </p>

        <div className="mt-7 flex flex-col gap-12 sm:mt-9 sm:flex-row sm:items-center sm:gap-14">
          <div className="sm:flex-[1.15]">
            {/* Persona. Behaviour, not headcount: a numeric ceiling
                ("אדם אחד עד שלושה") is forbidden by pre-copy-gate §12. */}
            <p className="text-[13px] font-semibold tracking-wide text-[var(--mkt-link)]">
              לבעל עסק שמנהל את היום־יום בעצמו
            </p>

            {/* BEAT 1 — the moment. Short enough to land before it is read. */}
            <h1 className="mt-4 text-[30px] font-semibold leading-[1.18] text-[var(--mkt-ink)] sm:text-[46px]">
              הידיים באמצע עבודה,
              <br />
              והטלפון מצלצל.
            </h1>

            {/* BEAT 2 — CHANGE 1. One sentence, and only one. It arrives before
                the framing so a stranger knows what this is within seconds,
                without displacing the moment as the loudest thing on the page. */}
            <p className="mt-5 max-w-md text-lg leading-8 text-[var(--mkt-ink)] sm:text-xl">
              Dubiz מרכזת במקום אחד את החשבוניות, התשלומים והפניות של העסק —
              ומסדרת אותם.
            </p>

            {/* BEAT 3 — the release. Never an accusation. */}
            <p className="mt-4 max-w-md text-base leading-7 text-[var(--dz-text-secondary)]">
              זה לא חוסר סדר. פשוט אין לך משרד — ויש לך משרד לנהל.
            </p>

            {/* BEAT 4 — where it works from. Ratified copy-v1 phrasing; email is
                deliberately third in a list and never leads (Gmail is a B-tier
                claim, gated on Google verification). */}
            <p className="mt-3 max-w-md text-base leading-7 text-[var(--dz-text-secondary)]">
              עובדת על מה שכבר יש לך — מהוואטסאפ, מהמייל ומהמסמכים. בלי הקמה.
            </p>

            <div className="mt-8">
              <PrimaryCta href={ctaHref} className="max-sm:w-full">
                {ctaLabel}
              </PrimaryCta>
            </div>
          </div>

          {/*
            Fold visual — evidence of WORK, not a product screenshot. For this
            persona a dashboard above the fold is an instant "another app"
            signal; the product itself gets its turn further down, at a size
            where it can actually be read.
          */}
          <div className="sm:flex-1">
            <div className="rounded-[26px] border border-[var(--mkt-soft-border)] dz-mist p-5 sm:p-6">
              <p className="text-[12px] font-semibold tracking-wide text-[var(--dz-text-muted)]">
                מה כבר מסודר
              </p>
              <ul className="mt-4 space-y-4">
                {IN_ORDER.map(([what, state]) => (
                  <li key={what} className="flex items-baseline gap-3">
                    <span
                      aria-hidden
                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mkt-link)]"
                    />
                    <span className="text-[15px] leading-6 text-[var(--mkt-ink)]">
                      <span className="font-semibold">{what}</span>
                      <span className="text-[var(--dz-text-secondary)]">
                        {" "}
                        — {state}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S2 · MIRROR — the accumulation, and a turn that opens S3           */}
      {/* ================================================================= */}
      <Section tone="warm" pad="lg" labelledById="s-mirror">
        <div className="max-w-2xl">
          <Heading id="s-mirror">וזה לא רגע אחד ביום.</Heading>

          <ul className="mt-8 space-y-5 border-r-2 border-[var(--mkt-soft-border)] pr-5 sm:space-y-6 sm:pr-7">
            {ACCUMULATION.map((line) => (
              <li
                key={line}
                className="text-lg leading-8 text-[var(--mkt-ink)] sm:text-xl"
              >
                {line}
              </li>
            ))}
          </ul>

          <p className="mt-8 text-base leading-8 text-[var(--dz-text-secondary)] sm:text-lg">
            כל אחד מהם קטן. ביחד הם תפקיד מלא — ואתה עושה אותו בערב, אחרי יום
            עבודה שלם.
          </p>

          <p className="mt-7 text-xl font-semibold leading-9 text-[var(--mkt-ink)] sm:text-2xl">
            אף אחד לא ביקש ממך להיות שני אנשים.
          </p>

          {/*
            THE TURN. Without it the section lands and stops — recognition with
            nothing pulling forward, which the usability walk identified as the
            page's highest drop-off point.
          */}
          <p className="mt-4 text-base leading-8 text-[var(--dz-text-secondary)] sm:text-lg">
            והתפקיד הזה לא צריך להיעלם. הוא רק צריך שמישהו אחר יעשה אותו.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S3 · MECHANISM — it starts where the business already is           */}
      {/* ================================================================= */}
      <Section tone="base" pad="md" labelledById="s-mechanism">
        <div className="max-w-2xl">
          <Heading id="s-mechanism">
            זה מתחיל מהמקום שבו העסק שלך כבר נמצא
          </Heading>
          <p className="mt-4 text-base leading-7 text-[var(--dz-text-secondary)]">
            לא מתחילים מהזנה של לקוחות ופריטים. מחברים את מה שכבר קיים — וזה
            מתחיל לעבוד.
          </p>
        </div>

        <div className="mt-9 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
          {/* Source chips: shape carrying meaning — these name the actual
              intake channels. No icons, and certainly no emoji. */}
          <div className="grid w-full grid-cols-3 gap-3 sm:w-auto">
            {["וואטסאפ", "מייל", "צילום מסמך"].map((src) => (
              <div
                key={src}
                className="rounded-2xl border border-[var(--mkt-soft-border)] dz-mist px-3 py-5 text-center text-sm font-semibold text-[var(--mkt-ink)]"
              >
                {src}
              </div>
            ))}
          </div>

          {/* RTL: points right-to-left on desktop, downward on mobile. */}
          <div
            aria-hidden
            className="self-center text-2xl text-[var(--dz-text-muted)] max-sm:-rotate-90 sm:self-auto"
          >
            ←
          </div>

          <div className="w-full rounded-2xl bg-[var(--mkt-soft)] px-5 py-5 text-center sm:w-auto sm:px-8">
            <p className="text-sm font-semibold text-[var(--mkt-ink)] sm:text-base">
              מסודר, בלי שהזנת כלום
            </p>
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S4 · SAFETY — adjacent to the mechanism, by law                    */}
      {/* ================================================================= */}
      <Section tone="warm" pad="sm" labelledById="s-safety">
        <h3
          id="s-safety"
          className="text-lg font-semibold text-[var(--mkt-ink)] sm:text-xl"
        >
          שום דבר לא יוצא בלעדיך
        </h3>

        <div className="mt-6 grid gap-5 sm:grid-cols-2 sm:gap-x-10">
          {SAFETY.map(([head, sub]) => (
            <div key={head}>
              <p className="text-[15px] font-semibold text-[var(--mkt-ink)]">
                {head}
              </p>
              <p className="mt-1 text-[14px] leading-6 text-[var(--dz-text-secondary)]">
                {sub}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S5 · BEFORE → AFTER  (CHANGE 4: merged with the old projection)    */}
      {/* ================================================================= */}
      <Section tone="base" pad="xl" labelledById="s-before-after">
        <div className="max-w-2xl">
          <Heading id="s-before-after">
            מה שיש לך היום — ומה Dubiz עושה איתו
          </Heading>
        </div>

        {/*
          Mobile: the arrow is NOT its own row. Stacked as box → arrow row → box,
          three pairs grew this section to ~1.3k px at 360. The arrow instead
          sits on the seam between the two halves of a pair, so each pair reads as
          one unit and the page loses a row per pair without losing the "became".
        */}
        <div className="mt-10 space-y-5 sm:mt-12 sm:space-y-8">
          {TRANSFORMATIONS.map((t) => (
            <article
              key={t.had}
              className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-5"
            >
              {/* HAD — dashed: unresolved. Deliberately plainer than the result. */}
              <div className="flex-1 rounded-[22px] border border-dashed border-[var(--mkt-soft-border)] px-4 py-4 sm:px-5 sm:py-5">
                <p className="text-[15px] font-semibold leading-6 text-[var(--dz-text-secondary)]">
                  {t.had}
                </p>
                <p className="mt-1.5 text-[13px] leading-5 text-[var(--dz-text-muted)]">
                  {t.hadNote}
                </p>
              </div>

              {/* Desktop connector: its own column, pointing right-to-left. */}
              <div
                aria-hidden
                className="hidden self-center text-xl text-[var(--dz-text-muted)] sm:block"
              >
                ←
              </div>

              {/* DID — solid paper: resolved. Carries the weight of the pair. */}
              <div className="relative flex-1 rounded-[22px] dz-mist px-4 py-4 sm:px-5 sm:py-5">
                {/* Mobile connector: straddles the 12px seam between the halves. */}
                <span
                  aria-hidden
                  className="absolute -top-[18px] right-5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--mkt-page)] text-sm text-[var(--dz-text-muted)] sm:hidden"
                >
                  ↓
                </span>
                <p className="text-[15px] font-semibold leading-6 text-[var(--mkt-ink)]">
                  {t.did}
                </p>
                <p className="mt-1.5 text-[13px] leading-5 text-[var(--dz-text-secondary)]">
                  {t.didNote}
                </p>
              </div>
            </article>
          ))}
        </div>

        {/*
          The merged projection. The old "השבוע שלך, בעוד חודש" section told the
          same before/after story a second time; all that survives of it is the
          breadth line and the landing line — which is the whole point of
          revealing breadth without unrolling a catalogue.
        */}
        <div className="mt-12 max-w-2xl border-t border-[var(--mkt-soft-border)] pt-8 sm:mt-14">
          <p className="text-base leading-8 text-[var(--dz-text-secondary)] sm:text-lg">
            <span className="font-semibold text-[var(--mkt-ink)]">
              הלקוחות · הכסף · המסמכים · השיחות
            </span>{" "}
            — כולם סביב אותו עסק, במקום אחד.
          </p>
          <p className="mt-4 text-xl font-semibold leading-9 text-[var(--mkt-ink)] sm:text-2xl">
            אתה מפסיק להחזיק את זה בראש.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S6 · PRODUCT PROOF  (CHANGE 3: four areas, each one readable)      */}
      {/* ================================================================= */}
      <Section tone="warm" pad="lg" labelledById="s-proof">
        <div className="max-w-2xl">
          <Heading id="s-proof">זה לא מצגת. זה כבר עובד.</Heading>
          <p className="mt-3 text-base leading-7 text-[var(--dz-text-secondary)]">
            אלה מסכים אמיתיים מ-Dubiz — לא חזון ולא רשימת המתנה.
          </p>
        </div>

        <ProductProof areas={PROOF_AREAS} />

        {/*
          Quiet action at peak conviction — a text link, never a second primary,
          and only when there is somewhere real to send them.
        */}
        {signupOpen ? (
          <p className="mt-10">
            <Link
              href="/register"
              className="inline-flex min-h-[44px] items-center text-[15px] font-semibold text-[var(--mkt-link)] underline underline-offset-4"
            >
              לראות את זה על העסק שלך
            </Link>
          </p>
        ) : null}
      </Section>

      {/* ================================================================= */}
      {/* S7 · LEGITIMACY  (CHANGE 5: compact, right-aligned, 270901 once)   */}
      {/* ================================================================= */}
      <Section tone="base" pad="md" labelledById="s-legitimacy">
        <div className="max-w-2xl border-r-2 border-[var(--mkt-link)] pr-5 sm:pr-7">
          <Heading id="s-legitimacy">
            מסודר מול רשות המסים — ומסודר לרואה החשבון שלך.
          </Heading>
          <p className="mt-4 text-base leading-8 text-[var(--dz-text-secondary)]">
            החשבוניות והמסמכים יוצאים בפורמט תקין ומסודר. Dubiz היא{" "}
            <span className="font-semibold text-[var(--mkt-ink)]">
              תוכנה רשומה ברשות המסים (270901)
            </span>
            , והכול מוכן להעברה לרואה החשבון — בלי שתצטרך להבין בזה.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S8 · THE ASK — every part of it derived from the signup gate       */}
      {/* ================================================================= */}
      <Section tone="warm" pad="lg" labelledById="s-ask">
        <div className="max-w-md">
          {signupOpen ? (
            <>
              <Heading id="s-ask">הדבר הראשון לוקח כמה דקות</Heading>

              <ol className="mt-8 space-y-4">
                {[
                  "נרשמים",
                  "מחברים מקור אחד — או מצלמים מסמך",
                  "רואים מה Dubiz עשתה איתו",
                ].map((step, i) => (
                  <li key={step} className="flex items-baseline gap-3">
                    <span
                      aria-hidden
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full dz-mist text-[13px] font-semibold text-[var(--mkt-ink)]"
                    >
                      {i + 1}
                    </span>
                    <span className="text-[15px] leading-7 text-[var(--mkt-ink)]">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <>
              {/*
                Registration is closed. Saying "sign up in two minutes" here and
                then handing the visitor a closed-registration screen is the one
                thing this page must never do — so the heading and the body come
                from the gate's own approved strings rather than being restated.
              */}
              <Heading id="s-ask">{SIGNUP_DISABLED_TITLE_HE}</Heading>
              <p className="mt-6 text-base leading-8 text-[var(--dz-text-secondary)]">
                {SIGNUP_DISABLED_MESSAGE_HE}
              </p>
            </>
          )}

          <div className="mt-9">
            <PrimaryCta href={ctaHref} className="max-sm:w-full">
              {ctaLabel}
            </PrimaryCta>
          </div>

          {/*
            NO PRICE ON THIS PAGE — by decision, not by omission. There is no
            ratified pricing model, and a placeholder, a "coming soon" or a
            reserved empty band all read as an unfinished product. Do not
            reintroduce a slot here.
          */}
          <p className="mt-6 text-sm leading-6 text-[var(--dz-text-secondary)]">
            הנתונים שלך נשארים שלך, עם ייצוא מסודר בכל רגע.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S9 · FAQ  (CHANGE 6: the ratified five, in full, at every width)   */}
      {/* ================================================================= */}
      <Section tone="base" pad="md" labelledById="s-faq">
        <div className="max-w-2xl">
          <h2
            id="s-faq"
            className="text-xl font-semibold text-[var(--mkt-ink)] sm:text-2xl"
          >
            שאלות שאולי עולות לך
          </h2>

          <div className="mt-7 divide-y divide-[var(--mkt-soft-border)]">
            {FAQ.map((item) => (
              <details key={item.q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-[var(--mkt-ink)]">
                  {item.q}
                  <span
                    aria-hidden
                    className="shrink-0 text-lg text-[var(--mkt-link)] transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-[15px] leading-7 text-[var(--dz-text-secondary)]">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}
