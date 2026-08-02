import type { Metadata } from "next";
import Image from "next/image";
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

// Three flagship screens — benefit-first copy, shown large with a mobile companion.
const HERO_SCREENS = [
  {
    title: "כל הכסף שלך במקום אחד",
    value:
      "צלם חשבונית או קבלה — ואנחנו כבר נזהה, נסדר ונראה לך בדיוק כמה נכנס וכמה יצא החודש.",
    desktop: "/landing/documents-home-desktop.webp",
    mobile: "/landing/documents-home-mobile.webp",
    alt: "מסך המסמכים של Dubiz — תזרים חודשי, קליטת מסמך חכמה ותור אימות",
  },
  {
    title: "כל לקוח, סיפור אחד שלם",
    value:
      "פרטים, מסמכים, תשלומים ושיחות — הכול בכרטיס אחד, כדי שתמיד תדע איפה אתה עומד מול כל לקוח.",
    desktop: "/landing/customer-card-desktop.webp",
    mobile: "/landing/customer-card-mobile.webp",
    alt: "כרטיס לקוח ב-Dubiz — פרטים, מסמכים, הערות וקבצים לצד רשימת הלקוחות",
  },
  {
    title: "לא תיתפס בלי מלאי",
    value:
      "במבט אחד רואים מה יש, כמה שווה המלאי ומה עומד להיגמר — לפני שהלקוח כבר מחכה.",
    desktop: "/landing/inventory-home-desktop.webp",
    mobile: "/landing/inventory-home-mobile.webp",
    alt: "מסך המלאי של Dubiz — שווי מלאי, בריאות המלאי ופריטים שדורשים טיפול",
  },
];

// Two supporting screens — shown compact, below the flagships.
const MORE_SCREENS = [
  {
    title: "שהכסף יגיע בזמן",
    value: "כל הגביות הפתוחות במקום אחד, עם קישור תשלום שנשלח ללקוח בלחיצה.",
    desktop: "/landing/collection-desktop.webp",
    alt: "מרכז הגבייה של Dubiz — גביות פתוחות, סטטוסים ומצב תשלום",
  },
  {
    title: "מזכירה שלא שוכחת",
    value: "מזכירה לך מה חייבים לסגור היום, ושומרת את כל השאר לרגע הנכון.",
    desktop: "/landing/secretary-desktop.webp",
    alt: "המזכירה של Dubiz — מה צריך לסגור היום והתחייבויות במעקב",
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

      <section className="mt-14 sm:mt-20">
        <div className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--mkt-soft-border)] bg-[var(--mkt-soft)] px-3 py-1 text-xs font-semibold text-[var(--mkt-link)]">
            הצצה למערכת
          </span>
          <h2 className="mx-auto mt-4 max-w-2xl text-xl font-bold text-[var(--mkt-ink)] sm:text-3xl">
            ככה נראה עסק מסודר
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-gray-600 sm:text-base">
            מסכים אמיתיים מהמערכת — במחשב ובנייד.
          </p>
        </div>

        {/* Flagship screens — large, with a mobile companion */}
        <div className="mt-8 grid gap-5 sm:mt-12 sm:gap-6">
          {HERO_SCREENS.map((s) => (
            <article
              key={s.title}
              className="grid items-center gap-5 rounded-[28px] bg-white p-5 shadow-sm sm:grid-cols-5 sm:gap-8 sm:p-8"
            >
              <div className="sm:col-span-2">
                <h3 className="text-lg font-bold leading-snug text-[var(--mkt-ink)] sm:text-xl">
                  {s.title}
                </h3>
                <p className="mt-2.5 text-sm leading-6 text-gray-600 sm:text-[15px]">
                  {s.value}
                </p>
                <div className="mt-4 w-24 overflow-hidden rounded-2xl border border-[var(--mkt-soft-border)] shadow-sm sm:w-28">
                  <Image
                    src={s.mobile}
                    alt={`${s.alt} — תצוגת מובייל`}
                    width={390}
                    height={844}
                    className="h-auto w-full"
                    loading="lazy"
                  />
                </div>
              </div>
              <div className="overflow-hidden rounded-2xl border border-[var(--mkt-soft-border)] shadow-sm sm:col-span-3">
                <Image
                  src={s.desktop}
                  alt={s.alt}
                  width={1440}
                  height={900}
                  className="h-auto w-full"
                  loading="lazy"
                  sizes="(min-width: 640px) 60vw, 100vw"
                />
              </div>
            </article>
          ))}
        </div>

        {/* Supporting screens — compact, two-up */}
        <div className="mt-5 grid gap-5 sm:mt-6 sm:grid-cols-2 sm:gap-6">
          {MORE_SCREENS.map((s) => (
            <article key={s.title} className="rounded-[28px] bg-white p-5 shadow-sm sm:p-6">
              <h3 className="text-base font-bold text-[var(--mkt-ink)] sm:text-lg">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-gray-600">{s.value}</p>
              <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--mkt-soft-border)] shadow-sm">
                <Image
                  src={s.desktop}
                  alt={s.alt}
                  width={1440}
                  height={900}
                  className="h-auto w-full"
                  loading="lazy"
                  sizes="(min-width: 640px) 45vw, 100vw"
                />
              </div>
            </article>
          ))}
        </div>
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
