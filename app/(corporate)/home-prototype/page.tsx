import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { isPublicSignupEnabled } from "@/lib/auth/signup-gate";

/**
 * Homepage Prototype V2.1 — drop-off fixes + price removed.
 *
 * V2.1 CHANGES (scope-limited; no other structural change):
 *  1. Price is GONE from the page entirely — no slot, no "coming soon", no
 *     reserved band. There is no ratified pricing model, and every form of
 *     placeholder reads as an unfinished product. Pricing returns in its own
 *     sprint. See the note in S8.
 *  2. S2 now ends on a TURN, not a full stop. The usability walk found the
 *     mirror landing with nothing pulling forward — the page's biggest leak.
 *  3. One real product artifact in S5, replacing the empty Tier-3 slot.
 *  4. A quiet text action right after the proof, where conviction peaks and
 *     the next button was a screen and a half away.
 *
 * ---
 * Homepage Prototype V2 — Hero & Proof rebuilt.
 *
 * NOT production. NOT final copy. The live corporate home (`/home`) is untouched.
 *
 * WHAT CHANGED FROM V1 (and why):
 *
 * P0.1 Hero — V1 opened with a claim ("העסק מתנהל") next to a product
 *   screenshot, which answered "how does the app look" instead of "is this my
 *   world". V2 opens with ONE recognisable moment, then the release, then the
 *   orientation. Promise comes third, not first. No app screenshot: a dashboard
 *   is an instant ad-blindness trigger for this persona.
 *
 * P0.2 Proof — V1 showed three full app screens: that proves the product
 *   EXISTS, a question nobody asked. V2 shows three transformations
 *   (what he has → what Dubiz did with it). Proof of change, not of existence.
 *
 * Hero/S2 split (discovered while building): the fold carries ONE moment;
 *   S2 carries the ACCUMULATION + the release. Escalation, not repetition.
 *
 * P1 applied: persona line, S2 strengthened, S4 out of the disclaimer card,
 *   CTA block + enlarged, S5d removed, FAQ 4→3, deliberate height variation.
 *
 * Design system: DS v1 warm via marketing vars + the canonical `.dz-btn-primary`
 * (<PrimaryCta />). No new colors.
 *
 * Strings marked PLACEHOLDER are directional draft text, not approved copy.
 */

export const metadata: Metadata = {
  title: "Prototype V2.1",
  description: "אב טיפוס פנימי של דף הבית — לא לפרסום.",
  robots: { index: false, follow: false },
};

/**
 * Rendered per request rather than prerendered. The CTAs below read the
 * canonical public-signup gate (`lib/auth/signup-gate`), and a statically baked
 * page would freeze whatever the flag happened to be at build time — so a later
 * flip of PUBLIC_SIGNUP_ENABLED would not reach this page until the next deploy.
 * This is a noindex internal prototype; the cost of dynamic rendering is nil.
 */
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------------- */

type Tone = "base" | "warm" | "card";

const TONE: Record<Tone, string> = {
  base: "bg-[var(--mkt-page)]",
  warm: "bg-[var(--mkt-soft)]",
  card: "bg-white",
};

/** Height is a rhythm instrument, not a default. Every step differs. */
const PAD = {
  xs: "py-6 sm:py-7",
  sm: "py-10 sm:py-12",
  md: "py-14 sm:py-18",
  lg: "py-18 sm:py-24",
  xl: "py-20 sm:py-28",
} as const;

/** Bottom-only override, for sections whose trailing gap reads as "page ended". */
const PAD_B = {
  xs: "pb-6 sm:pb-7",
  sm: "pb-10 sm:pb-12",
  md: "pb-14 sm:pb-18",
  lg: "pb-18 sm:pb-24",
  xl: "pb-20 sm:pb-28",
} as const;

function Section({
  tone = "base",
  pad = "md",
  padB,
  children,
}: {
  tone?: Tone;
  pad?: keyof typeof PAD;
  padB?: keyof typeof PAD;
  children: React.ReactNode;
}) {
  return (
    <section className={`${TONE[tone]} ${PAD[pad]} ${padB ? PAD_B[padB] : ""}`}>
      <CorporateContainer>{children}</CorporateContainer>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* PROOF — three transformations.                                             */
/*                                                                            */
/* `had` is an object from HIS world (recognisable). `did` is what Dubiz made  */
/* of it. The pair proves CHANGE; a screenshot only proves existence.          */
/*                                                                            */
/* NOTE: the `did` side is typographic in this prototype. It should eventually */
/* become a real cropped fragment of the product record — not a full screen.   */
/* ------------------------------------------------------------------------- */

const TRANSFORMATIONS = [
  {
    /* PLACEHOLDER copy */
    had: "חשבונית ששלחת לפני חודש ולא זוכר אם שולמה",
    hadNote: "בין המיילים, בוואטסאפ, ובראש",
    did: "פתוח · 3,400 ₪ · באיחור 12 יום",
    didNote: "מופיע ברשימה אחת עם קישור תשלום מוכן לשליחה",
  },
  {
    /* PLACEHOLDER copy */
    had: "הודעה מלקוח שנקברה מתחת ל-40 הודעות",
    hadNote: "נשלחה ב-9:15, כשהידיים היו תפוסות",
    did: "פנייה פתוחה · ממתינה לתשובה",
    didNote: "עולה למעלה עד שתטפל, ולא נעלמת",
  },
  {
    /* PLACEHOLDER copy */
    had: "קבלה מקומטת מספק, מצולמת בטלפון",
    hadNote: "אחת מתוך ערימה בתא הכפפות",
    did: "ספק · סכום · תאריך — מזוהים ומתויקים",
    didNote: "בסוף החודש כבר ערוך לרואה החשבון",
  },
];

/* ------------------------------------------------------------------------- */

export default function HomePrototypePage() {
  // Single source of truth: the same server-side gate the /register route uses.
  // No second flag, no duplicated logic — this page only reads the decision.
  //
  // While registration is closed the page must not invite anyone to sign up and
  // then hand them a "registration is closed" screen. The primary CTA becomes an
  // existing-user entrance, and the secondary action — which only makes sense as
  // a signup — is not rendered at all. Set PUBLIC_SIGNUP_ENABLED=true and the
  // original prototype behaviour returns with no code change.
  const signupOpen = isPublicSignupEnabled();
  const ctaHref = signupOpen ? "/register" : "/login";
  const ctaLabel = signupOpen ? "מתחילים בדבר אחד" : "כניסה למשתמשים קיימים";

  return (
    <>
      {/* ================================================================= */}
      {/* S1 · FOLD — one moment → release → orientation → action           */}
      {/* No app screenshot. The visual is evidence of work, not UI.        */}
      {/* ================================================================= */}
      {/* padB: the trailing gap after the evidence card read as "page ended"
          on mobile, right at the first scroll decision. */}
      <Section tone="base" pad="lg" padB="sm">
        <div className="flex flex-col gap-12 sm:flex-row sm:items-center sm:gap-14">
          <div className="sm:flex-[1.15]">
            {/* Persona line — answers "is this for me" before the headline. */}
            <p className="text-[13px] font-semibold tracking-wide text-[var(--mkt-link)]">
              {/* PLACEHOLDER copy */}
              לעסק של אדם אחד עד שלושה
            </p>

            {/* BEAT 1 — the moment. Short enough to land pre-reading. */}
            <h1 className="mt-4 text-[30px] font-extrabold leading-[1.18] text-[var(--mkt-ink)] sm:text-[46px]">
              {/* PLACEHOLDER copy */}
              הידיים באמצע עבודה,
              <br />
              והטלפון מצלצל.
            </h1>

            {/* BEAT 2 — the release. This is what turns recognition into
                being seen. It must never read as an accusation. */}
            <p className="mt-5 max-w-md text-lg font-semibold leading-8 text-[var(--mkt-ink)] sm:text-xl">
              {/* PLACEHOLDER copy */}
              זה לא חוסר סדר. פשוט אין לך משרד — ויש לך משרד לנהל.
            </p>

            {/* BEAT 3 — orientation. The promise arrives third, on purpose. */}
            <p className="mt-4 max-w-md text-base leading-7 text-[var(--dz-text-secondary)]">
              {/* PLACEHOLDER copy */}
              Dubiz אוספת את החשבוניות, התשלומים והפניות מהמקומות שבהם הם כבר
              נמצאים, ומסדרת אותם בזמן שאתה עובד. בלי להקים כלום.
            </p>

            <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
              {/* PLACEHOLDER label */}
              <PrimaryCta href={ctaHref} className="max-sm:w-full">
                {ctaLabel}
              </PrimaryCta>
              <span className="text-[13px] leading-6 text-[var(--dz-text-muted)]">
                תוכנה רשומה ברשות המסים · 270901
              </span>
            </div>
          </div>

          {/*
            Fold visual — "what happened while you worked".
            Deliberately NOT a product screenshot: for this persona a dashboard
            is an instant "another app" signal. This shows WORK, which is what a
            stranger needs to see, while the product itself stays quiet.
            ILLUSTRATIVE: event types, not fabricated customer records.
          */}
          <div className="sm:flex-1">
            <div className="rounded-[26px] border border-[var(--mkt-soft-border)] bg-white p-5 shadow-sm sm:p-6">
              <p className="text-[12px] font-bold tracking-wide text-[var(--dz-text-muted)]">
                {/* PLACEHOLDER copy */}
                בזמן שעבדת
              </p>
              <ul className="mt-4 space-y-4">
                {[
                  ["קבלה מספק", "נקלטה, זוהתה ותויקה"],
                  ["חשבונית", "נשלחה ונרשמה"],
                  ["פנייה בוואטסאפ", "נפתחה וממתינה לך"],
                ].map(([what, state]) => (
                  <li key={what} className="flex items-baseline gap-3">
                    <span
                      aria-hidden
                      className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mkt-link)]"
                    />
                    <span className="text-[15px] leading-6 text-[var(--mkt-ink)]">
                      <span className="font-semibold">{what}</span>
                      <span className="text-[var(--dz-text-secondary)]"> — {state}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S2 · THE MIRROR — the ACCUMULATION, not the moment again          */}
      {/* Escalation from the fold: it isn't one moment, it's every day.    */}
      {/* ================================================================= */}
      <Section tone="warm" pad="lg">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-2xl font-bold leading-snug text-[var(--mkt-ink)] sm:text-[32px]">
            {/* PLACEHOLDER copy */}
            וזה לא רגע אחד ביום.
          </h2>

          {/* Paced list — each line is a separate beat, not a paragraph.
              Right-aligned: centred multi-line Hebrew is the least readable
              setting there is, and this is the one section read word-for-word. */}
          <ul className="mt-8 space-y-5 border-r-2 border-[var(--mkt-soft-border)] pr-5 sm:space-y-6 sm:pr-7">
            {[
              /* PLACEHOLDER copy */
              "לקוח שאל מחיר. אמרת שתחזור אליו. לא חזרת.",
              "קבלה מספק נשארה ברכב.",
              "מישהו לא שילם, ואתה לא זוכר מי.",
              "יש תשלום ב-10 בחודש שאסור לפספס.",
            ].map((line) => (
              <li
                key={line}
                className="text-lg leading-8 text-[var(--mkt-ink)] sm:text-xl"
              >
                {line}
              </li>
            ))}
          </ul>

          <p className="mt-8 text-base leading-8 text-[var(--dz-text-secondary)] sm:text-lg">
            {/* PLACEHOLDER copy */}
            כל אחד מהם קטן. ביחד הם תפקיד מלא — ואתה עושה אותו בערב, אחרי יום
            עבודה שלם.
          </p>

          {/* The pivot line. The emotional center of the page. */}
          <p className="mt-7 text-xl font-bold leading-9 text-[var(--mkt-ink)] sm:text-2xl">
            {/* PLACEHOLDER copy */}
            אף אחד לא ביקש ממך להיות שני אנשים.
          </p>

          {/*
            THE TURN. Without this line S2 lands and stops — recognition with no
            forward motion, which the usability walk identified as the single
            highest drop-off point on the page. It must open a question that S3
            answers, without becoming a rhetorical ad line.
          */}
          <p className="mt-4 text-base leading-8 text-[var(--dz-text-secondary)] sm:text-lg">
            {/* PLACEHOLDER copy */}
            והתפקיד הזה לא צריך להיעלם. הוא רק צריך שמישהו אחר יעשה אותו.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S3 · MECHANISM — unchanged from V1: it worked.                    */}
      {/* ================================================================= */}
      <Section tone="base" pad="md">
        <div className="text-center">
          <h2 className="mx-auto max-w-xl text-2xl font-bold leading-snug text-[var(--mkt-ink)] sm:text-3xl">
            {/* PLACEHOLDER copy */}
            זה מתחיל מהמקום שבו העסק שלך כבר נמצא
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-[var(--dz-text-secondary)]">
            {/* PLACEHOLDER copy */}
            לא מתחילים מהזנה של לקוחות ופריטים. מחברים את מה שכבר קיים — וזה
            מתחיל לעבוד.
          </p>
        </div>

        <div className="mt-10 flex flex-col items-center gap-4 sm:mt-12 sm:flex-row sm:justify-center sm:gap-6">
          <div className="grid w-full grid-cols-3 gap-3 sm:w-auto">
            {["וואטסאפ", "מייל", "צילום מסמך"].map((src) => (
              <div
                key={src}
                className="rounded-2xl border border-[var(--mkt-soft-border)] bg-white px-3 py-5 text-center text-sm font-semibold text-[var(--mkt-ink)] shadow-sm"
              >
                {src}
              </div>
            ))}
          </div>

          {/* RTL: right → left on desktop, top → down on mobile. */}
          <div
            aria-hidden
            className="-rotate-90 text-2xl text-[var(--dz-text-muted)] sm:rotate-0"
          >
            ←
          </div>

          <div className="w-full rounded-2xl bg-[var(--mkt-soft)] px-5 py-5 text-center sm:w-auto sm:px-8">
            <p className="text-sm font-bold text-[var(--mkt-ink)] sm:text-base">
              {/* PLACEHOLDER copy */}
              מסודר, בלי שהזנת כלום
            </p>
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S4 · SAFETY — out of the bordered "terms of service" card.        */}
      {/* Four separate units. Small, calm, no lock icons.                  */}
      {/* ================================================================= */}
      <Section tone="warm" pad="sm">
        <div className="mx-auto max-w-3xl">
          <h3 className="text-center text-lg font-bold text-[var(--mkt-ink)] sm:text-xl">
            {/* PLACEHOLDER copy */}
            שום דבר לא יוצא בלעדיך
          </h3>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 sm:gap-5">
            {[
              /* PLACEHOLDER copy — exact privacy boundary still open */
              ["אתה בוחר מה מתחבר", "ואפשר לנתק בכל רגע"],
              ["נשמר מה שקשור לעסק", "חשבוניות, תשלומים, פניות של לקוחות"],
              [
                "כלום לא נשלח בשמך",
                "לא ללקוח, לא לספק, לא לרשות — בלי שאישרת",
              ],
              ["המידע שלך שלך", "מייצאים הכול ויוצאים, בלי תנאים"],
            ].map(([head, sub]) => (
              <div key={head}>
                <p className="text-[15px] font-bold text-[var(--mkt-ink)]">
                  {head}
                </p>
                <p className="mt-1 text-[14px] leading-6 text-[var(--dz-text-secondary)]">
                  {sub}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S5 · PROOF — three transformations. No app screenshots.           */}
      {/* Proof of CHANGE, not proof of existence.                          */}
      {/* ================================================================= */}
      <Section tone="base" pad="xl">
        <div className="text-center">
          <h2 className="mx-auto max-w-xl text-2xl font-bold leading-snug text-[var(--mkt-ink)] sm:text-3xl">
            {/* PLACEHOLDER copy */}
            מה שיש לך היום — ומה Dubiz עושה איתו
          </h2>
        </div>

        <div className="mt-10 space-y-6 sm:mt-14 sm:space-y-8">
          {TRANSFORMATIONS.map((t) => (
            <article
              key={t.had}
              className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-5"
            >
              {/* HAD — his world. Deliberately plainer than the result. */}
              <div className="flex-1 rounded-[22px] border border-dashed border-[var(--mkt-soft-border)] px-5 py-5">
                <p className="text-[15px] font-semibold leading-6 text-[var(--dz-text-secondary)]">
                  {t.had}
                </p>
                <p className="mt-1.5 text-[13px] leading-5 text-[var(--dz-text-muted)]">
                  {t.hadNote}
                </p>
              </div>

              <div
                aria-hidden
                className="self-center text-xl text-[var(--dz-text-muted)] max-sm:-rotate-90"
              >
                ←
              </div>

              {/* DID — the result. Carries the visual weight of the pair. */}
              <div className="flex-1 rounded-[22px] bg-white px-5 py-5 shadow-sm">
                <p className="text-[15px] font-bold leading-6 text-[var(--mkt-ink)]">
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
          THE ARTIFACT — the first and only product pixels on the page.

          Why it exists: the usability walk found that a visitor reaches ~4
          screens in having never seen the product, and the thought that
          surfaces is not "nice" but "why won't they show me?".

          Why a FRAGMENT and not a screen: a full screen proves the app exists
          — a question nobody asked. A readable fragment shows a real record in
          a real state, at 1:1 on mobile so the text can actually be read.

          Still open: the Tier-3 artifact (an invoice PDF the visitor can open
          and hand to their accountant) needs a public sample route — product
          work, not page work.
        */}
        <div className="mx-auto mt-12 max-w-sm sm:mt-16">
          <p className="mb-3 text-center text-[13px] font-semibold text-[var(--dz-text-muted)]">
            {/* PLACEHOLDER copy */}
            וככה זה נראה אצלך
          </p>
          <div className="overflow-hidden rounded-[22px] border border-[var(--mkt-soft-border)] shadow-md">
            {/* Cropped to the summary region: a real state, no customer rows. */}
            <div className="h-[196px] overflow-hidden">
              <Image
                src="/landing/collection.webp"
                alt="מרכז הגבייה ב-Dubiz — גביות פתוחות, סכום ממתין וסכום באיחור"
                width={390}
                height={844}
                loading="lazy"
                className="w-full object-cover object-top"
                sizes="(min-width: 640px) 384px, 100vw"
              />
            </div>
          </div>
        </div>

        {/*
          QUIET ACTION — the visitor is at peak conviction here and the next
          button is a screen and a half away. One action, one more appearance;
          a text link so it never competes with the primary CTA.
        */}
        {signupOpen ? (
          <p className="mt-8 text-center">
            <Link
              href="/register"
              className="text-[15px] font-semibold text-[var(--mkt-link)] underline underline-offset-4"
            >
              {/* PLACEHOLDER label */}
              לראות את זה על העסק שלך
            </Link>
          </p>
        ) : null}
      </Section>

      {/* ================================================================= */}
      {/* S7 · PROJECTION                                                    */}
      {/* ================================================================= */}
      <Section tone="card" pad="md">
        <div className="text-center">
          <h2 className="mx-auto max-w-xl text-2xl font-bold leading-snug text-[var(--mkt-ink)] sm:text-3xl">
            {/* PLACEHOLDER copy */}
            השבוע שלך, בעוד חודש
          </h2>
        </div>

        <div className="mx-auto mt-8 grid max-w-3xl gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-6">
          <div className="rounded-[24px] border border-[var(--mkt-soft-border)] p-6">
            <p className="text-xs font-bold tracking-wide text-[var(--dz-text-muted)]">
              היום
            </p>
            <ul className="mt-4 space-y-3 text-[15px] leading-7 text-[var(--dz-text-secondary)]">
              {/* PLACEHOLDER copy */}
              <li>אתה זוכר בעצמך מי לא שילם.</li>
              <li>הניירת מחכה לערב.</li>
              <li>אתה בודק בכמה מקומות כדי לדעת איפה אתה עומד.</li>
            </ul>
          </div>

          <div className="rounded-[24px] bg-[var(--mkt-soft)] p-6">
            <p className="text-xs font-bold tracking-wide text-[var(--mkt-link)]">
              עם Dubiz
            </p>
            <ul className="mt-4 space-y-3 text-[15px] font-medium leading-7 text-[var(--mkt-ink)]">
              {/* PLACEHOLDER copy */}
              <li>אתה פותח פעם ביום ורואה מה דורש אותך.</li>
              <li>הניירת כבר מסודרת.</li>
              <li>אתה מפסיק להחזיק את זה בראש.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S6 · LEGITIMACY — a permission slip. Quiet on purpose.            */}
      {/* ================================================================= */}
      <Section tone="base" pad="xs">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 text-center text-[15px] leading-7 text-[var(--dz-text-secondary)] sm:flex-row sm:justify-center sm:gap-8">
          <span>חשבוניות וקבלות תקינות</span>
          <span className="font-semibold text-[var(--mkt-ink)]">
            תוכנה רשומה · 270901
          </span>
          <span>הכול מסודר לרואה החשבון</span>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S8 · THE ASK — enlarged. Block CTA. The single peak.              */}
      {/* ================================================================= */}
      <Section tone="warm" pad="lg">
        <div className="mx-auto max-w-md text-center">
          <h2 className="text-[26px] font-bold leading-snug text-[var(--mkt-ink)] sm:text-[34px]">
            {/* PLACEHOLDER copy — deliberately NOT the CTA label */}
            הדבר הראשון לוקח שתי דקות
          </h2>

          <ol className="mt-8 space-y-4 text-right">
            {[
              /* PLACEHOLDER copy */
              "נרשמים",
              "מחברים מקור אחד — או מצלמים מסמך",
              "רואים מה Dubiz עשתה איתו",
            ].map((step, i) => (
              <li key={step} className="flex items-baseline gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-[13px] font-bold text-[var(--mkt-ink)]">
                  {i + 1}
                </span>
                <span className="text-[15px] leading-7 text-[var(--mkt-ink)]">
                  {step}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-9">
            {/* PLACEHOLDER label. Block on mobile — this is the decision moment. */}
            <PrimaryCta href={ctaHref} className="max-sm:w-full">
              {ctaLabel}
            </PrimaryCta>
          </div>

          {/*
            NO PRICE ON THIS PAGE — by decision, not by omission.
            There is no pricing model ratified yet, and a placeholder, a "coming
            soon", or a reserved empty band all read as an unfinished product.
            The page is built as though price is simply not part of it. Pricing
            gets its own sprint once the commercial model is decided.
            Do not reintroduce a slot here.
          */}
          <p className="mt-6 text-sm leading-6 text-[var(--dz-text-secondary)]">
            אפשר לייצא את הנתונים ולצאת בכל רגע.
          </p>
        </div>
      </Section>

      {/* ================================================================= */}
      {/* S9 · HONEST Q&A — 4 → 3. Text only. No repeated CTA.              */}
      {/* ================================================================= */}
      <Section tone="base" pad="md">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center text-xl font-bold text-[var(--mkt-ink)] sm:text-2xl">
            שאלות ישרות
          </h2>

          <div className="mt-7 divide-y divide-[var(--mkt-soft-border)]">
            {[
              /* PLACEHOLDER copy */
              {
                q: "כבר יש לי תוכנה שמוציאה חשבוניות.",
                a: "Dubiz מוציאה חשבוניות תקינות בעצמה, אז אתה לא מוותר על זה. ההבדל הוא במה שקורה סביב החשבונית — הגבייה, הפניות והניירת.",
              },
              {
                q: "מה רואה החשבון שלי יגיד?",
                a: "הוא מקבל את החומר מסודר ובפורמט שהוא מכיר, כולל ייצוא במבנה האחיד של רשות המסים.",
              },
              {
                q: "ומה קורה למידע שלי אם אחליט לעזוב?",
                a: "אתה מייצא את הכול ויוצא. בלי תשלום, בלי תנאים, בלי לבקש רשות.",
              },
            ].map((item) => (
              <div key={item.q} className="py-5">
                <p className="text-[15px] font-bold text-[var(--mkt-ink)]">
                  {item.q}
                </p>
                <p className="mt-2 text-[15px] leading-7 text-[var(--dz-text-secondary)]">
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}
