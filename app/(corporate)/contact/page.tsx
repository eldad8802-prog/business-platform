import type { Metadata } from "next";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "צור קשר",
  description:
    "יצירת קשר עם Dubiz, המופעל על ידי PRO MAX GROUP — לשאלות, תמיכה ופניות בנושא המוצר.",
};

export default function CorporateContactPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-4xl">
          צור קשר
        </h1>
        <p className="mt-4 text-sm leading-7 text-[var(--dz-text-muted)] sm:text-base">
          נשמח לעמוד לרשותך. לכל שאלה, בקשת תמיכה או פנייה בנושא המוצר, אפשר
          ליצור איתנו קשר באמצעות הפרטים הבאים, ונחזור אליך בהקדם האפשרי.
        </p>
      </header>

      <section className="mt-10 max-w-xl rounded-[24px] dz-mist p-6 shadow-sm sm:p-7">
        <dl className="space-y-5 text-sm sm:text-base">
          <div>
            <dt className="font-bold text-[var(--mkt-ink)]">אימייל</dt>
            <dd className="mt-1">
              <a
                href="mailto:support@promaxgroup.co.il"
                className="text-[var(--mkt-link)] underline"
              >
                support@promaxgroup.co.il
              </a>
            </dd>
          </div>

          <div>
            <dt className="font-bold text-[var(--mkt-ink)]">טלפון עסקי</dt>
            <dd className="mt-1 text-[var(--dz-text-muted)]">+972-50-566-8802</dd>
          </div>

          <div>
            <dt className="font-bold text-[var(--mkt-ink)]">מפעילת השירות</dt>
            <dd className="mt-1 text-[var(--dz-text-muted)]">PRO MAX GROUP</dd>
          </div>
        </dl>
      </section>

      <p className="mt-8 max-w-2xl text-xs leading-6 text-[var(--dz-text-muted)] sm:text-sm">
        כשאתה פונה אלינו במייל, אנחנו משתמשים בפרטים שתמסור (כגון כתובת האימייל
        ותוכן הפנייה) אך ורק לצורך מענה לפנייה ומתן תמיכה. איננו עושים בפרטים אלו
        שימוש שאינו קשור לטיפול בפנייתך. לפרטים נוספים ראה את מדיניות הפרטיות.
      </p>
    </CorporateContainer>
  );
}
