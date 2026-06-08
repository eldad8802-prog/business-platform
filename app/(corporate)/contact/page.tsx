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
        <h1 className="text-3xl font-extrabold leading-tight text-[#0C2138] sm:text-4xl">
          צור קשר
        </h1>
        <p className="mt-4 text-sm leading-7 text-gray-600 sm:text-base">
          נשמח לעמוד לרשותך. לכל שאלה, בקשת תמיכה או פנייה בנושא המוצר, אפשר
          ליצור איתנו קשר באמצעות הפרטים הבאים, ונחזור אליך בהקדם האפשרי.
        </p>
      </header>

      <section className="mt-10 max-w-xl rounded-[24px] bg-white p-6 shadow-sm sm:p-7">
        <dl className="space-y-5 text-sm sm:text-base">
          <div>
            <dt className="font-bold text-[#0C2138]">אימייל</dt>
            <dd className="mt-1">
              <a
                href="mailto:support@promaxgroup.co.il"
                className="text-[#1E6BFF] underline"
              >
                support@promaxgroup.co.il
              </a>
            </dd>
          </div>

          <div>
            <dt className="font-bold text-[#0C2138]">טלפון עסקי</dt>
            <dd className="mt-1 text-gray-600">+972-50-566-8802</dd>
          </div>

          <div>
            <dt className="font-bold text-[#0C2138]">כתובת</dt>
            <dd className="mt-1 text-gray-600">הקבלן 25 דירה 16, ירושלים</dd>
          </div>

          <div>
            <dt className="font-bold text-[#0C2138]">מפעילת השירות</dt>
            <dd className="mt-1 text-gray-600">PRO MAX GROUP</dd>
          </div>

          <div>
            <dt className="font-bold text-[#0C2138]">עוסק פטור</dt>
            <dd className="mt-1 text-gray-600">312260110</dd>
          </div>
        </dl>
      </section>

      <p className="mt-8 max-w-2xl text-xs leading-6 text-gray-500 sm:text-sm">
        כשאתה פונה אלינו במייל, אנחנו משתמשים בפרטים שתמסור (כגון כתובת האימייל
        ותוכן הפנייה) אך ורק לצורך מענה לפנייה ומתן תמיכה. איננו עושים בפרטים אלו
        שימוש שאינו קשור לטיפול בפנייתך. לפרטים נוספים ראה את מדיניות הפרטיות.
      </p>
    </CorporateContainer>
  );
}
