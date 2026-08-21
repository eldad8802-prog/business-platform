import type { Metadata } from "next";
import Image from "next/image";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";
import { PrimaryCta } from "@/components/ui/primary-cta";
import { TOKEN } from "@/lib/design/tokens";

/**
 * Dubiz Homepage v1 — canonical 9-stage story.
 *
 * Sources: docs/dubiz-homepage-story-reconciliation-v1.md · structural-wireframe-v2 ·
 * pre-copy-gate-v1 · copy-v1 · visual-design-spec-v1. Copy is transcribed verbatim from
 * copy-v1.md. Sells a TRAIT (nothing falls, you still decide), never a character ("מזכירה")
 * and never a category ("מערכת הפעלה"). Product-Truth locked: no scheduler/push/reminders,
 * no aging, no sync/integration, no multi-user, no pricing/free, no blanket compliance,
 * no invented social proof. Primary CTA is the real self-serve /register.
 *
 * Nine stages, order binding; stage 3 (Mechanism) → stage 4 (Safety) stay adjacent in DOM
 * (Adjacent-Objection Law). Visual = DS v1 warm (TOKEN.dsv1), Heebo, .dz-btn-primary.
 */

export const metadata: Metadata = {
  // `absolute` so the app name leads the title instead of the generic "בית".
  // It bypasses the "%s · Dubiz" template from the corporate layout, which
  // would otherwise append a second "· Dubiz". Homepage only — every other
  // corporate page keeps the template unchanged.
  title: { absolute: "Dubiz — ניהול היום־יום של העסק" },
  description:
    "Dubiz מרכזת את היום־יום של העסק שלך — לקוחות, כסף ומסמכים — מהוואטסאפ, מהמייל ומהמסמכים שכבר יש לך. בלי הקמה. מופעל על ידי PRO MAX GROUP.",
};

// DS v1 warm palette (token-driven — no invented colors).
const C = {
  ink: "var(--mkt-ink)",
  muted: TOKEN.dsv1.muted, // #777067
  card: TOKEN.dsv1.card, // #FDF4EB
  line: TOKEN.dsv1.line, // #E9DDD0
  soft: TOKEN.dsv1.surface2, // #F6ECDD
  teal: TOKEN.dsv1.accent, // #246966 — done / positive
  clay: TOKEN.warm.status.late.ink, // #B85C3F — needs attention (NOT alarm red)
  brown: TOKEN.warm.status.partial.ink, // #B88755 — open / partial
};

const cardStyle = {
  backgroundColor: C.card,
  borderColor: C.line,
  boxShadow: TOKEN.dsv1.shadowCard,
} as const;

// ── Fold · Attention items (representative, static — no clock/badge/scheduler) ──
const ATTENTION = [
  { dot: C.brown, text: "לקוח ממתין לתשובה", action: "טיוטה מוכנה" },
  { dot: C.clay, text: "חשבונית פתוחה · ₪3,200", action: "קישור לתשלום" },
  { dot: C.teal, text: "קבלה נקלטה מהוואטסאפ", action: "ספק וסכום זוהו" },
];

// ── Mirror · accumulation (one growing pile, not a card grid) ──
const ACCUMULATION = [
  "לקוח שצריך לחזור אליו",
  "מסמך שמחכה",
  "כסף שעדיין פתוח",
  "הודעה שאסור לשכוח",
  "פריט שנגמר",
  "עוד דבר קטן בראש",
];

// ── Mechanism · intake channels (Product-Truth tiered; no sync/realtime) ──
const CHANNELS = [
  { icon: "💬", label: "השיחות והמסמכים מהוואטסאפ העסקי — מרוכזים אצלך." },
  { icon: "📸", label: "מצלמים קבלה, והפרטים נקלטים לבד." },
  { icon: "✉️", label: "וגם מסמכים שמגיעים במייל." },
];

// ── Proof · real product screens (A claims only; new captions) ──
const PROOF = [
  {
    src: "/landing/customer-card.webp",
    alt: "כרטיס לקוח ב-Dubiz — פרטים, מסמכים, תשלומים ושיחות במקום אחד",
    caption:
      "כל לקוח במקום אחד — פרטים, מסמכים, תשלומים ושיחות. תמיד תדע איפה אתה עומד מולו.",
  },
  {
    src: "/landing/collection.webp",
    alt: "מרכז הגבייה של Dubiz — מה שולם, מה פתוח, וקישור לתשלום",
    caption: "רואים מה שולם ומה עדיין פתוח, ושולחים ללקוח קישור לתשלום בלחיצה.",
  },
  {
    src: "/landing/documents-home.webp",
    alt: "קליטת מסמך ב-Dubiz — זיהוי ספק, סכום ותאריך",
    caption: "מצלמים חשבונית — Dubiz מזהה ספק, סכום ותאריך לבד.",
  },
  {
    src: "/landing/bot-config.webp",
    alt: "בוט Dubiz — מכין טיוטת תשובה שאתה מאשר לפני שליחה",
    caption: "הבוט מכין טיוטת תשובה בשפה שלך — ואתה מאשר לפני שהיא נשלחת.",
  },
];

// ── Self-Projection · breadth as outcome (not a module catalogue) ──
const AROUND_BUSINESS = ["הלקוחות", "הכסף", "המסמכים", "השיחות"];

// ── Tail · honest FAQ ──
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-2xl font-bold leading-snug sm:text-3xl"
      style={{ color: C.ink }}
    >
      {children}
    </h2>
  );
}

export default function CorporateHomePage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      {/*
       * Application identity line. States, as real visible text above the fold,
       * that this application is named "Dubiz" and is operated by PRO MAX GROUP
       * — matching the OAuth consent-screen app name and the identical statement
       * in the footer, privacy, terms and about pages. Not decoration and not a
       * marketing message: it is deliberately outside the governed Homepage v1
       * stage copy (no H1 / eyebrow / support change).
       */}
      <p
        className="mb-7 text-center text-sm sm:mb-9 lg:text-start"
        style={{ color: C.muted }}
      >
        {/* 600 (not 700): Heebo is loaded at 300–600, so font-bold would be
            synthetically emboldened by the browser. */}
        <span className="font-semibold" style={{ color: C.ink }}>
          Dubiz
        </span>{" "}
        — מופעל על ידי PRO MAX GROUP
      </p>

      {/* ───────────────────────── STAGE 1 · FOLD ───────────────────────── */}
      <section className="grid items-center gap-8 sm:gap-10 lg:grid-cols-2">
        <div className="text-center lg:text-start">
          <span
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
            style={{ backgroundColor: C.soft, borderColor: C.line, color: C.teal }}
          >
            תוכנה רשומה ברשות המסים · 270901
          </span>

          <h1
            className="mx-auto mt-5 max-w-xl text-3xl font-extrabold leading-tight sm:text-5xl lg:mx-0"
            style={{ color: C.ink }}
          >
            כל היום־יום של העסק שלך — מסודר, בלי שתחזיק הכול בראש.
          </h1>

          <p
            className="mx-auto mt-5 max-w-lg text-base leading-7 sm:text-lg lg:mx-0"
            style={{ color: C.muted }}
          >
            Dubiz מרכזת את מה שחשוב בעסק — מהוואטסאפ, מהמייל ומהמסמכים שכבר יש לך.
            בלי הקמה.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
            <PrimaryCta href="/register" block>
              התחילו עכשיו
            </PrimaryCta>
            <a
              href="#how-it-works"
              className="text-sm font-semibold underline underline-offset-4"
              style={{ color: C.teal }}
            >
              ראו איך זה עובד
            </a>
          </div>
        </div>

        {/* Attention surface — "מה כבר מסודר" (representative, static) */}
        <div className="rounded-[24px] border p-5 sm:p-6" style={cardStyle}>
          <p className="mb-4 text-xs font-semibold" style={{ color: C.muted }}>
            מה כבר מסודר
          </p>
          <ul className="flex flex-col gap-3">
            {ATTENTION.map((item) => (
              <li
                key={item.text}
                className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3"
                style={{ border: `1px solid ${C.line}` }}
              >
                <span className="flex items-center gap-3 text-sm" style={{ color: C.ink }}>
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: item.dot }}
                    aria-hidden="true"
                  />
                  {item.text}
                </span>
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                  style={{ backgroundColor: C.soft, color: C.teal }}
                >
                  {item.action}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ───────────────────────── STAGE 2 · MIRROR ───────────────────────── */}
      <section className="mt-16 text-center sm:mt-24">
        <SectionHeading>
          פתחת עסק כדי לעבוד במקצוע שלך — לא כדי להיות גם המשרד.
        </SectionHeading>
        <p
          className="mx-auto mt-4 max-w-2xl text-base leading-8 sm:text-lg"
          style={{ color: C.muted }}
        >
          ואז, לאט לאט, נוסף לך תפקיד שלם שאף אחד לא לקח: לרשום, לחייב, לגבות,
          לחזור ללקוח, לזכור את הספק, לא לפספס את המע&quot;מ. הכול נשאר לך בראש —
          אחרי שעות העבודה.
        </p>

        <ul className="mx-auto mt-8 flex max-w-xl flex-col gap-2">
          {ACCUMULATION.map((item, i) => (
            <li
              key={item}
              className="flex items-center gap-3 rounded-2xl px-4 py-2.5 text-start text-sm"
              style={{
                backgroundColor: C.soft,
                color: C.ink,
                // subtle "growing pile" — each row nudged slightly
                marginInlineStart: `${i * 8}px`,
              }}
            >
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: C.brown }}
                aria-hidden="true"
              />
              {item}
            </li>
          ))}
        </ul>

        <p className="mt-6 text-base font-semibold" style={{ color: C.ink }}>
          אתה לא בלגניסט. פשוט נפל עליך תפקיד שני.
        </p>
      </section>

      {/* ─────────────────── STAGE 3 · MECHANISM / DIFFERENCE ─────────────────── */}
      {/* NOTE: stage 3 and stage 4 are intentionally adjacent (Adjacent-Objection Law) */}
      <section id="how-it-works" className="mt-16 sm:mt-24">
        <div className="text-center">
          <SectionHeading>
            Dubiz מתחילה מהמקום שבו העסק שלך כבר חי.
          </SectionHeading>
          <p
            className="mx-auto mt-4 max-w-2xl text-base leading-8 sm:text-lg"
            style={{ color: C.muted }}
          >
            אתה לא מזין כלום ולא מעביר שום דבר. שולח קבלה בוואטסאפ, מצלם חשבונית,
            או נותן ל-Dubiz לקלוט אותן מהמייל — והיא מזהה לבד ספק, סכום ותאריך.
          </p>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {CHANNELS.map((c) => (
            <div
              key={c.label}
              className="rounded-[20px] border p-5 text-start"
              style={cardStyle}
            >
              <span className="text-2xl" aria-hidden="true">
                {c.icon}
              </span>
              <p className="mt-3 text-sm leading-6" style={{ color: C.ink }}>
                {c.label}
              </p>
            </div>
          ))}
        </div>

        {/* Micro-proof: representative captured receipt (not a fake screenshot) */}
        <div
          className="mx-auto mt-8 max-w-md rounded-[20px] border p-5"
          style={cardStyle}
        >
          <p className="text-xs font-semibold" style={{ color: C.muted }}>
            כך נראית קבלה אחרי שנקלטה — בלי שהקלדת
          </p>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            {[
              ["ספק", "פרו מקס גרופ בע״מ"],
              ["סכום", "₪1,240"],
              ["תאריך", "12/08/2026"],
            ].map(([k, v]) => (
              <div
                key={k}
                className="flex items-center justify-between rounded-xl bg-white px-3 py-2"
                style={{ border: `1px solid ${C.line}` }}
              >
                <dt style={{ color: C.muted }}>{k}</dt>
                <dd className="font-semibold" style={{ color: C.ink }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="mt-6 text-center text-base font-semibold" style={{ color: C.ink }}>
          פחות להזין, פחות להעתיק, פחות לזכור.
        </p>
      </section>

      {/* ───────────── STAGE 4 · SAFETY / CONTROL / PRIVACY (adjacent) ───────────── */}
      <section className="mt-12 sm:mt-16">
        <div
          className="rounded-[28px] border p-6 text-center sm:p-8"
          style={cardStyle}
        >
          <SectionHeading>
            אתה רואה מה נכנס — ושום דבר לא יוצא בלעדיך.
          </SectionHeading>
          <ul className="mx-auto mt-5 flex max-w-2xl flex-col gap-3 text-start">
            {[
              "נקלט רק מה שקשור לעסק — לא כל הוואטסאפ שלך.",
              "המידע שלך נשאר שלך, ואתה מנתק את החיבור מתי שתרצה.",
              "כל תשובה ללקוח וכל מסמך שיוצא החוצה — מחכה לאישור שלך.",
            ].map((fact) => (
              <li key={fact} className="flex items-start gap-3 text-sm" style={{ color: C.ink }}>
                <span
                  className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  style={{ backgroundColor: C.soft, color: C.teal }}
                  aria-hidden="true"
                >
                  ✓
                </span>
                {fact}
              </li>
            ))}
          </ul>
          <p className="mt-6 text-base font-semibold" style={{ color: C.ink }}>
            אתה עדיין בעל הבית.
          </p>
        </div>
      </section>

      {/* ───────────────────────── STAGE 5 · PROOF ───────────────────────── */}
      <section className="mt-16 sm:mt-24">
        <div className="text-center">
          <SectionHeading>זה לא מצגת. זה כבר עובד.</SectionHeading>
          <p
            className="mx-auto mt-3 max-w-2xl text-sm leading-7 sm:text-base"
            style={{ color: C.muted }}
          >
            אלה מסכים אמיתיים מ-Dubiz — לא חזון ולא רשימת המתנה.
          </p>
        </div>

        {/* horizontal scroll on mobile, grid on desktop */}
        <ul className="mt-8 flex snap-x gap-5 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible">
          {PROOF.map((p) => (
            <li
              key={p.src}
              className="flex w-[78vw] shrink-0 snap-start flex-col items-center rounded-[24px] border p-5 text-center sm:w-auto"
              style={cardStyle}
            >
              <div
                className="w-full max-w-[220px] overflow-hidden rounded-[1.4rem]"
                style={{ border: `1px solid ${C.line}` }}
              >
                <Image
                  src={p.src}
                  alt={p.alt}
                  width={390}
                  height={844}
                  className="h-auto w-full"
                  loading="lazy"
                  sizes="(min-width: 640px) 220px, 78vw"
                />
              </div>
              <p className="mt-4 text-sm leading-6" style={{ color: C.ink }}>
                {p.caption}
              </p>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex justify-center">
          <PrimaryCta href="/register">התחילו עכשיו</PrimaryCta>
        </div>
      </section>

      {/* ───────────────────────── STAGE 6 · LEGITIMACY ───────────────────────── */}
      <section className="mt-16 sm:mt-24">
        <div
          className="rounded-[28px] border p-6 text-center sm:p-8"
          style={{ backgroundColor: C.soft, borderColor: C.line }}
        >
          <SectionHeading>
            מסודר מול רשות המסים — ומסודר לרואה החשבון שלך.
          </SectionHeading>
          <p
            className="mx-auto mt-4 max-w-2xl text-base leading-8"
            style={{ color: C.muted }}
          >
            החשבוניות והמסמכים יוצאים בפורמט תקין ומסודר. Dubiz היא תוכנה רשומה
            ברשות המסים (270901), והכול מוכן להעברה לרואה החשבון — בלי שתצטרך
            להבין בזה.
          </p>
          <p className="mt-5 text-base font-semibold" style={{ color: C.ink }}>
            אתה מכוסה מול הרשויות.
          </p>
        </div>
      </section>

      {/* ─────────────────── STAGE 7 · SELF-PROJECTION ─────────────────── */}
      <section className="mt-16 text-center sm:mt-24">
        <SectionHeading>ככה נראה השבוע שלך עם Dubiz.</SectionHeading>
        <p
          className="mx-auto mt-4 max-w-2xl text-base leading-8 sm:text-lg"
          style={{ color: C.muted }}
        >
          אתה נכנס בבוקר ורואה מה חשוב — מי מחכה לתשובה, מה עדיין פתוח, מה נקלט.
          לא ערימה, לא חיפוש בין הודעות, ולא עוד דברים שאתה מחזיק בראש.
        </p>

        <div className="mx-auto mt-7 flex max-w-lg flex-wrap items-center justify-center gap-2">
          {AROUND_BUSINESS.map((item) => (
            <span
              key={item}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: C.soft, color: C.teal }}
            >
              {item}
            </span>
          ))}
          <span className="text-sm" style={{ color: C.muted }}>
            — כולם סביב אותו עסק, במקום אחד.
          </span>
        </div>

        <p className="mt-6 text-base font-semibold" style={{ color: C.ink }}>
          אתה חוזר להיות בעל העסק, לא המשרד שלו.
        </p>
      </section>

      {/* ───────────────────────── STAGE 8 · THE ASK ───────────────────────── */}
      <section className="mt-16 sm:mt-24">
        <div
          className="rounded-[28px] p-8 text-center sm:p-12"
          style={{ backgroundColor: C.card, border: `1px solid ${C.line}`, boxShadow: TOKEN.dsv1.shadowCard }}
        >
          <h2 className="text-2xl font-extrabold sm:text-4xl" style={{ color: C.ink }}>
            תפסיק להחזיק את כל העסק בראש.
          </h2>
          <p
            className="mx-auto mt-4 max-w-xl text-base leading-7"
            style={{ color: C.muted }}
          >
            מתחילים בכמה דקות, בלי הקמה ובלי להעביר הכול ביום אחד. הנתונים שלך
            נשארים שלך, עם ייצוא מסודר בכל רגע.
          </p>
          <div className="mt-7 flex justify-center">
            <PrimaryCta href="/register">התחילו עכשיו</PrimaryCta>
          </div>
        </div>
      </section>

      {/* ───────────────────────── STAGE 9 · TAIL / FAQ ───────────────────────── */}
      <section className="mt-16 sm:mt-20">
        <h2 className="text-center text-xl font-bold sm:text-2xl" style={{ color: C.ink }}>
          שאלות שאולי עולות לך
        </h2>
        <div className="mx-auto mt-6 flex max-w-2xl flex-col gap-3">
          {FAQ.map((item) => (
            <details
              key={item.q}
              className="group rounded-2xl border px-5 py-4"
              style={cardStyle}
            >
              <summary
                className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold"
                style={{ color: C.ink }}
              >
                {item.q}
                <span
                  className="shrink-0 text-lg transition-transform group-open:rotate-45"
                  style={{ color: C.teal }}
                  aria-hidden="true"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-6" style={{ color: C.muted }}>
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </section>
    </CorporateContainer>
  );
}
