import type { Metadata } from "next";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";
import { PrimaryCta } from "@/components/ui/primary-cta";

export const metadata: Metadata = {
  title: "בית",
  description:
    "Dubiz מרכזת את ניהול העסק במקום אחד — שיחות ולקוחות, מסמכים וחשבוניות, מלאי ורכש, ותובנות והמלצות פעולה.",
};

const CAPABILITIES = [
  {
    icon: "💬",
    title: "שיחות ולקוחות",
    body: "ריכוז הפניות והשיחות מול הלקוחות במקום אחד, כדי שלא תפספס פנייה ותדע מה מצב כל לקוח.",
  },
  {
    icon: "📄",
    title: "מסמכים וחשבוניות",
    body: "ניהול מסמכים עסקיים והפקה וסידור של חשבוניות, עם שמירה מסודרת שמקלה על העבודה מול רואה החשבון.",
  },
  {
    icon: "📦",
    title: "מלאי ורכש",
    body: "מעקב אחר פריטים, מלאי ורכש מספקים, כדי לשמור על תמונה מעודכנת של מה שיש ומה שצריך להזמין.",
  },
  {
    icon: "✨",
    title: "תובנות והמלצות פעולה",
    body: "סיכום של מה שקורה בעסק והמלצות פעולה שמסייעות לך להתמקד במשימות החשובות.",
  },
];

export default function CorporateHomePage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <section className="text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--mkt-soft-border)] bg-[var(--mkt-soft)] px-3 py-1 text-xs font-semibold text-[var(--mkt-link)]">
          מערכת הפעלה לעסק
        </span>

        <h1 className="mx-auto mt-5 max-w-3xl text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-5xl">
          Dubiz — מערכת ההפעלה לעסק שלך.
        </h1>

        <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-gray-600 sm:text-lg">
          Dubiz מרכזת את הניהול היומיומי של העסק במקום אחד — שיחות ולקוחות,
          מסמכים וחשבוניות, מלאי ורכש, ולצידם תובנות והמלצות פעולה שעוזרות לך
          להחליט מה חשוב עכשיו. פחות מערכות מפוזרות, יותר סדר.
        </p>

        <div className="mt-8 flex justify-center">
          <PrimaryCta href="/login">כניסה למערכת</PrimaryCta>
        </div>
      </section>

      <section className="mt-14 grid grid-cols-1 gap-4 sm:mt-20 sm:grid-cols-2">
        {CAPABILITIES.map((c) => (
          <div key={c.title} className="rounded-[24px] bg-white p-6 shadow-sm">
            <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--mkt-soft)] text-2xl">
              {c.icon}
            </div>
            <h2 className="text-base font-bold text-[var(--mkt-ink)]">{c.title}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600">{c.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-14 rounded-[28px] bg-white p-7 text-center shadow-sm sm:mt-20 sm:p-10">
        <h2 className="text-xl font-bold text-[var(--mkt-ink)] sm:text-2xl">
          מערכת אחת מסודרת לעסק
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-gray-600 sm:text-base">
          Dubiz נבנתה עבור עסקים קטנים ובינוניים שרוצים לנהל את הפעילות מתוך
          מערכת אחת מסודרת, במקום לעבור בין כלים ורשימות נפרדים. המערכת מציגה לך
          את התמונה המלאה ועוזרת לשמור על סדר שוטף בעבודה היומית.
        </p>
      </section>

      <section className="mt-12 flex flex-col items-center gap-4 text-center sm:mt-16">
        <p className="text-lg font-semibold text-[var(--mkt-ink)]">
          רוצה לראות הכול במקום אחד?
        </p>
        <PrimaryCta href="/login">כניסה למערכת</PrimaryCta>
      </section>
    </CorporateContainer>
  );
}
