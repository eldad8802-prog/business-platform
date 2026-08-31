import type { Metadata } from "next";
import Link from "next/link";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "מחיקת חשבון ונתונים",
  description:
    "כיצד למחוק את חשבון Dubiz ואת המידע שלך — הפעולה מתוך האפליקציה, מה נמחק, ומה נשמר לפי חובת שמירה חוקית (מסמכי מס והנהלת חשבונות). Dubiz מופעל על ידי PRO MAX GROUP.",
};

export default function CorporateDataDeletionPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-4xl">
          מחיקת חשבון ונתונים
        </h1>
        <p className="mt-3 text-sm text-[var(--dz-text-muted)]">עודכן לאחרונה: 23 באוגוסט 2026</p>
        <p className="mt-4 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
          עמוד זה מסביר כיצד למחוק את חשבון Dubiz ואת המידע שלך, מה נמחק ומה עשוי
          להישמר לפי חובת שמירה שבדין. ניתן לבצע את מחיקת החשבון ישירות מתוך האפליקציה.
        </p>
      </header>

      <div className="mt-10 max-w-3xl space-y-9 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            מחיקת חשבון Dubiz מתוך האפליקציה
          </h2>
          <p className="mt-3">בעל עסק יכול למחוק את חשבונו בכל עת, ישירות מתוך Dubiz:</p>
          <p className="mt-3 font-semibold text-[var(--mkt-ink)]">
            הגדרות ← חשבון ופרטיות ← מחיקת חשבון
          </p>
          <p className="mt-3">המחיקה מסירה או ממזערת (אנונימיזציה) את המידע התפעולי ואת פרטי המשתמש, לרבות:</p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>פרטי המשתמש והכניסה (אימייל, שם, סיסמה) — לאחר המחיקה לא ניתן להתחבר לחשבון.</li>
            <li>פרטי העסק ופרטי הזיהוי לחיוב.</li>
            <li>לקוחות, לידים, שיחות והודעות, והערות/קבצים ב-CRM.</li>
            <li>החיבורים החיצוניים (WhatsApp/Meta, Gmail, סליקה, קופה) — נותקים והאסימונים נמחקים.</li>
          </ul>
          <p className="mt-3 font-semibold text-[var(--mkt-ink)]">הפעולה בלתי הפיכה.</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            מה נשמר לפי חובת שמירה חוקית
          </h2>
          <p className="mt-3">
            מסמכים ורשומות שהדין מחייב לשמור — בעיקר{" "}
            <span className="font-semibold text-[var(--mkt-ink)]">מסמכי מס ורשומות הנהלת
            חשבונות</span> (כגון חשבוניות, קבלות, תיעוד הוצאות ורשומות כספיות) — עשויים
            להישמר לתקופת השמירה הקבועה בדין, ולא ישמשו להפעלת חשבון פעיל. השמירה נדרשת
            על פי דיני המס בישראל.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            מחיקת נתוני החיבור ל-Meta בלבד
          </h2>
          <p className="mt-3">
            אם ברצונך לנתק רק את חיבור ה-WhatsApp/Meta מבלי למחוק את החשבון:
          </p>
          <p className="mt-3 font-semibold text-[var(--mkt-ink)]">
            הגדרות ← חיבורים ← WhatsApp ← מחיקת נתוני Meta
          </p>
          <p className="mt-3">
            פעולה זו מוחקת את נתוני החיבור (אסימון הגישה המוצפן, מזהי הטלפון/WABA ומטא-דאטה
            של החיבור) בלבד, ואינה מוחקת את החשבון. חשבון ה-WhatsApp Business, מספר הטלפון
            וההרשאות מנוהלים בצד Meta ואינם מנוהלים על ידי Dubiz.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            צריכים עזרה?
          </h2>
          <p className="mt-3">
            אם אינך מצליח לבצע את המחיקה מתוך האפליקציה (למשל כאשר יש יותר ממשתמש אחד בעסק),
            ניתן לפנות אל PRO MAX GROUP בכתובת{" "}
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
