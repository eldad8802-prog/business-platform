import type { Metadata } from "next";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "אודות",
  description:
    "Dubiz הוא מוצר המופעל על ידי PRO MAX GROUP — מערכת הפעלה לעסקים קטנים ובינוניים לניהול שיחות, מסמכים, חשבוניות, מלאי ורכש.",
};

export default function CorporateAboutPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-4xl">
          אודות Dubiz
        </h1>
      </header>

      <div className="mt-10 space-y-10">
        <section className="max-w-3xl">
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">מי אנחנו</h2>
          <p className="mt-3 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
            Dubiz הוא מוצר המופעל על ידי PRO MAX GROUP. אנחנו בונים כלי ניהול
            עסקי שמטרתו לפשט את ההתנהלות היומיומית של עסקים קטנים ובינוניים,
            ולרכז במקום אחד את הפעולות שחשובות לניהול שוטף ובריא.
          </p>
        </section>

        <section className="max-w-3xl">
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">מה Dubiz עושה</h2>
          <p className="mt-3 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
            Dubiz משמשת כמערכת הפעלה לעסק (Business Operating System): היא מרכזת
            שיחות ולקוחות, מסמכים וחשבוניות, מלאי ורכש, ולצד אלה מציגה תובנות
            והמלצות פעולה. במקום לנהל את העסק על פני מספר כלים נפרדים, Dubiz
            מאחדת את התהליכים החשובים לסביבה אחת ברורה ומסודרת.
          </p>
        </section>

        <section className="max-w-3xl">
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">למי זה מתאים</h2>
          <p className="mt-3 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
            Dubiz מתאימה לבעלי עסקים קטנים ובינוניים, עצמאים ובעלי מקצוע שרוצים
            לשמור על סדר בעבודה השוטפת — לעקוב אחר לקוחות ופניות, לנהל מסמכים
            וחשבוניות, ולשמור על תמונה מעודכנת של המלאי והרכש, מבלי להסתבך עם
            מערכות מורכבות.
          </p>
        </section>

        <section className="max-w-3xl rounded-[24px] bg-[var(--dz-surface)] p-6 shadow-sm sm:p-7">
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">על PRO MAX GROUP</h2>
          <p className="mt-3 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
            Dubiz is operated by PRO MAX GROUP. PRO MAX GROUP אחראית לפיתוח
            המוצר, לתחזוקתו ולשירות הניתן למשתמשים.
          </p>
        </section>
      </div>
    </CorporateContainer>
  );
}
