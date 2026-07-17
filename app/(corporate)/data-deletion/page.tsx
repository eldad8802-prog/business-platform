import type { Metadata } from "next";
import Link from "next/link";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "מחיקת נתוני חיבור Meta",
  description:
    "כיצד למחוק מ-Dubiz את נתוני החיבור ל-WhatsApp/Meta — מה נמחק, מה נשמר, וכיצד לפנות לבקשת מחיקה מלאה. Dubiz מופעל על ידי PRO MAX GROUP.",
};

export default function CorporateDataDeletionPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-4xl">
          מחיקת נתוני חיבור Meta
        </h1>
        <p className="mt-3 text-sm text-gray-500">עודכן לאחרונה: 17 ביולי 2026</p>
        <p className="mt-4 text-sm leading-7 text-gray-600 sm:text-base">
          עמוד זה מסביר כיצד למחוק מ-Dubiz את נתוני החיבור שנוצרו כאשר בעל עסק
          מחבר את חשבון ה-WhatsApp Business שלו דרך Meta. ההסבר מתייחס למידע
          ש-Dubiz שומרת במערכותיה בלבד.
        </p>
      </header>

      <div className="mt-10 max-w-3xl space-y-9 text-sm leading-7 text-gray-600 sm:text-base">
        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            מחיקת נתוני החיבור ל-Meta מתוך Dubiz
          </h2>
          <p className="mt-3">
            בעל עסק יכול למחוק את נתוני החיבור בכל עת, ישירות מתוך Dubiz:
          </p>
          <p className="mt-3 font-semibold text-[var(--mkt-ink)]">
            הגדרות ← WhatsApp ← מחיקת נתוני Meta
          </p>
          <p className="mt-3">הפעולה מוחקת ממערכות Dubiz את נתוני החיבור, לרבות:</p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>אסימון הגישה (Access token) המוצפן.</li>
            <li>מזהה מספר הטלפון (Phone Number ID).</li>
            <li>מזהה חשבון ה-WhatsApp Business (WABA ID).</li>
            <li>מספר הטלפון המוצג.</li>
            <li>מטא-דאטה של מצב החיבור והשגיאות.</li>
          </ul>
          <p className="mt-3">תוכל לחבר מחדש את WhatsApp Business בכל עת.</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            מה אינו נמחק בפעולה זו
          </h2>
          <p className="mt-3">
            מדובר במחיקת <span className="font-semibold text-[var(--mkt-ink)]">נתוני
            החיבור ל-Meta</span> בלבד — לא במחיקת חשבון Dubiz. הפעולה{" "}
            <span className="font-semibold text-[var(--mkt-ink)]">אינה</span>{" "}
            מוחקת אוטומטית:
          </p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>שיחות.</li>
            <li>הודעות שכבר נשמרו ב-Dubiz.</li>
            <li>לקוחות.</li>
            <li>נתוני העסק.</li>
            <li>מסמכים או מידע עסקי אחר.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            הנכסים בצד Meta
          </h2>
          <p className="mt-3">
            עמוד זה מתייחס למידע ש-Dubiz שומרת במערכותיה. חשבון ה-WhatsApp
            Business שלך, מספר הטלפון וההרשאות מנוהלים בצד Meta ואינם מנוהלים על
            ידי Dubiz. לניהול או להסרה של נכסים אלה בצד Meta, יש להשתמש בהגדרות
            העסק של Meta (Meta Business Settings).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            בקשת מחיקה מלאה
          </h2>
          <p className="mt-3">
            למחיקת חשבון Dubiz או מידע עסקי נוסף מעבר לנתוני החיבור ל-Meta, ניתן
            לפנות אל PRO MAX GROUP בכתובת{" "}
            <a
              href="mailto:support@promaxgroup.co.il"
              className="text-[var(--mkt-link)] underline"
            >
              support@promaxgroup.co.il
            </a>{" "}
            או דרך{" "}
            <Link href="/contact" className="text-[var(--mkt-link)] underline">
              עמוד יצירת הקשר
            </Link>
            . נטפל בבקשתך בהתאם לדין החל. ראו גם את{" "}
            <Link href="/privacy" className="text-[var(--mkt-link)] underline">
              מדיניות הפרטיות
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">זהות המפעיל</h2>
          <p className="mt-3">
            Dubiz is operated by PRO MAX GROUP. שירות Dubiz מופעל על ידי PRO MAX
            GROUP.
          </p>
        </section>
      </div>
    </CorporateContainer>
  );
}
