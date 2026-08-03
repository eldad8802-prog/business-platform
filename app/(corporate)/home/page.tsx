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

// Real product screens (phone), shown as a mobile gallery in "המערכת בפעולה".
const SCREENS = [
  {
    src: "/landing/documents-home.webp",
    title: "כל הכסף שלך, סוף סוף במקום אחד",
    body: "צלם חשבונית או קבלה — או תן ל-Dubiz למשוך אותן לבד מ-Gmail ומוואטסאפ. המערכת מזהה ספק, סכום ותאריך לבד, ומראה לך תזרים חודשי נקי. בלי אקסלים, בלי ערימות ניירת ובלי הפתעות בסוף החודש.",
    alt: "מסך המסמכים של Dubiz — תזרים חודשי נטו, קליטת מסמך חכמה ותור אימות",
  },
  {
    src: "/landing/customer-card.webp",
    title: "כל לקוח — סיפור אחד שלם",
    body: "כרטיס לקוח שמרכז הכול: פרטים, מסמכים, תשלומים, שיחות, הערות וקבצים. עם Dubiz תמיד תדע איפה אתה עומד מול כל לקוח, מה נשאר לגבות ומה הבטחת — בלי לחפש בין מיילים והודעות.",
    alt: "כרטיס לקוח ב-Dubiz — פרטים, מסמכים, הערות וקבצים לצד רשימת הלקוחות",
  },
  {
    src: "/landing/inventory-home.webp",
    title: "לא תיתפס שוב בלי מלאי",
    body: "Dubiz מראה לך במבט אחד מה יש במלאי, כמה הוא שווה ומה עומד להיגמר — עם התראות חכמות לפני שנגמר. ככה אתה מזמין בזמן, לא מפספס מכירה ולא כובל כסף על המדפים.",
    alt: "מסך המלאי של Dubiz — שווי מלאי, בריאות המלאי ופריטים שדורשים טיפול",
  },
  {
    src: "/landing/collection.webp",
    title: "שהכסף יגיע אליך בזמן",
    body: "כל הגביות הפתוחות במקום אחד, ממוינות לפי מה שדורש טיפול. Dubiz שולח ללקוח קישור תשלום בלחיצה ומראה לך מי שילם, מי מתעכב וכמה נגבה החודש — כדי שתפסיק לרדוף אחרי הכסף שלך.",
    alt: "מרכז הגבייה של Dubiz — גביות פתוחות, סטטוסים ומצב תשלום",
  },
  {
    src: "/landing/billing.webp",
    title: "חשבונית מקצועית בכמה שניות",
    body: "חשבונית מס, קבלה או הצעת מחיר — Dubiz מפיקה אותן מעוצבות ותקינות מול רשות המסים, שומרת הכול מסודר לרואה החשבון, וממשיכה מכל מקום שבו עצרת. פחות בירוקרטיה, יותר עסק.",
    alt: "מסך החשבוניות של Dubiz — יצירת חשבונית והצעת מחיר וניהול מסמכי חיוב",
  },
  {
    src: "/landing/obligation-types.webp",
    title: "המזכירה שזוכרת כל תשלום",
    body: 'שכירות, ארנונה, ביטוח לאומי, מע"מ, ספקים — Dubiz מכירה את כל סוגי ההתחייבויות של העסק שלך ומזכירה לך לשלם בדיוק בזמן. בוחרים מהרשימה, וזהו: לא עוד קנסות ולא עוד תשלומים שנשכחו.',
    alt: "מסך ההתחייבויות של Dubiz — סוגי התשלומים הקבועים שהמערכת מציעה לעקוב אחריהם",
  },
  {
    src: "/landing/bot-main.webp",
    title: "בוט שמדבר בשם העסק שלך",
    body: "Dubiz בונה לך בוט אישי שעונה ללקוחות בשפה ובאופי שלך, אוסף פרטים ומכין טיוטות — מסביב לשעון. אתה שולט בכל מילה שהוא אומר ומאשר לפני שיוצא. כאילו קיבלת עובד נוסף שלא ישן.",
    alt: "מסך הבוט של Dubiz — הגדרת זהות, אופי, גישה וידע לבוט העסקי",
  },
  {
    src: "/landing/bot-config.webp",
    title: "אתה מחליט, הבוט מבצע",
    body: "מגדירים לבוט מטרה, גבולות ומתי להעביר אליך — ו-Dubiz דואגת שהוא לא ימציא מידע ולא יחרוג ממה שהתרת. שליטה מלאה בלי סיכונים, עם כפתור אחד להפעיל או לעצור בכל רגע.",
    alt: "מסך הפעלת הבוט של Dubiz — הרכבת הבוט מהמטרות והגדרות הבטיחות",
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
            המערכת בפעולה
          </span>
          <h2 className="mx-auto mt-4 max-w-2xl text-2xl font-bold text-[var(--mkt-ink)] sm:text-3xl">
            כל העסק שלך — בכיס אחד
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-gray-600 sm:text-base">
            אלה מסכים אמיתיים מ-Dubiz. ככה נראה לנהל עסק מסודר — הכול מהטלפון,
            בלי בלגן ובלי עשר מערכות נפרדות.
          </p>
        </div>

        <div className="mt-8 grid gap-5 sm:mt-12 sm:grid-cols-2 sm:gap-6 lg:gap-7">
          {SCREENS.map((s) => (
            <article
              key={s.title}
              className="flex flex-col items-center rounded-[28px] bg-white p-6 text-center shadow-sm"
            >
              <div className="w-full max-w-[210px] overflow-hidden rounded-[1.6rem] border border-[var(--mkt-soft-border)] shadow-md">
                <Image
                  src={s.src}
                  alt={s.alt}
                  width={390}
                  height={844}
                  className="h-auto w-full"
                  loading="lazy"
                  sizes="(min-width: 640px) 210px, 60vw"
                />
              </div>
              <h3 className="mt-5 text-base font-bold text-[var(--mkt-ink)] sm:text-lg">
                {s.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-gray-600">{s.body}</p>
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
