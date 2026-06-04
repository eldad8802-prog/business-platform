import type { Metadata } from "next";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "מדיניות פרטיות",
  description:
    "מדיניות הפרטיות של Dubiz, המופעל על ידי PRO MAX GROUP — אילו נתונים נאספים, מטרות השימוש, אבטחה וזכויות המשתמש.",
};

export default function CorporatePrivacyPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-gray-900 sm:text-4xl">
          מדיניות פרטיות
        </h1>
        <p className="mt-3 text-sm text-gray-500">עודכן לאחרונה: 4 ביוני 2026</p>
      </header>

      <div className="mt-10 max-w-3xl space-y-9 text-sm leading-7 text-gray-600 sm:text-base">
        <section>
          <h2 className="text-lg font-bold text-gray-900">מי מפעיל את השירות</h2>
          <p className="mt-3">
            שירות Dubiz מופעל על ידי PRO MAX GROUP (&quot;אנחנו&quot;,
            &quot;החברה&quot;). מדיניות זו מסבירה כיצד אנו אוספים, משתמשים
            ושומרים מידע במסגרת השימוש בשירות.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">
            אילו סוגי מידע נאספים
          </h2>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>פרטי חשבון ומשתמש (כגון שם, כתובת אימייל ופרטי התחברות).</li>
            <li>פרטי העסק שהוזנו על ידך לצורך השימוש במערכת.</li>
            <li>
              תוכן עסקי שאתה מנהל במערכת, כגון לקוחות ושיחות, מסמכים וחשבוניות,
              ופריטי מלאי ורכש.
            </li>
            <li>מידע שנמסר בעת פנייה לתמיכה.</li>
            <li>מידע טכני בסיסי הנדרש לתפעול השירות ולאבטחתו.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">מטרות השימוש</h2>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>אספקת השירות והפעלת יכולותיו עבורך.</li>
            <li>שמירה, ארגון והצגה של המידע העסקי שלך בתוך המערכת.</li>
            <li>מתן תמיכה ומענה לפניות.</li>
            <li>שמירה על אבטחת המערכת, תקינותה ומניעת שימוש לרעה.</li>
            <li>שיפור ותחזוקה של השירות.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">
            אינטגרציות וצדדים שלישיים
          </h2>
          <p className="mt-3">
            השירות עשוי להתחבר, לפי בחירתך ובאישורך, לשירותים חיצוניים כגון
            שירותי דוא&quot;ל והודעות (לרבות שירותים מבוססי WhatsApp / Meta)
            וספקי תשתית. כאשר אתה מחבר שירות חיצוני, ייתכן שמידע יועבר בין Dubiz
            לבין אותו שירות בהיקף הנדרש להפעלת החיבור. השימוש בשירותי צד שלישי
            כפוף גם לתנאים ולמדיניות הפרטיות של אותם ספקים. איננו מוכרים את המידע
            שלך לצדדים שלישיים.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">שמירת מידע ואבטחה</h2>
          <p className="mt-3">
            אנו שומרים את המידע למשך הזמן הדרוש לאספקת השירות ולעמידה בדרישות
            חוקיות, ונוקטים אמצעים סבירים לשמירה על אבטחת המידע מפני גישה, שימוש
            או חשיפה בלתי מורשים. יובהר כי אף שיטת אחסון או העברה אינה מאובטחת
            לחלוטין.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">זכויות משתמש</h2>
          <p className="mt-3">
            בכפוף לדין החל, באפשרותך לבקש לעיין במידע שלך, לתקנו או לעדכנו, וכן
            לבקש מידע על אופן השימוש בו. לפניות בנושא זה ניתן לפנות אלינו בפרטים
            שבהמשך.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">מחיקת מידע</h2>
          <p className="mt-3">
            באפשרותך לבקש את מחיקת המידע האישי שלך, בכפוף למגבלות ולחובות שמירה
            הנדרשים על פי דין או לצורך תפעול תקין של השירות. נטפל בבקשתך בהתאם
            לדין החל.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">יצירת קשר</h2>
          <p className="mt-3">
            בכל שאלה או בקשה בנושא פרטיות ניתן לפנות אל PRO MAX GROUP בכתובת{" "}
            <a
              href="mailto:support@promaxgroup.co.il"
              className="text-[#1f7a5a] underline"
            >
              support@promaxgroup.co.il
            </a>
            .
          </p>
        </section>

        <section className="rounded-[20px] bg-white p-5 text-xs leading-6 text-gray-500 shadow-sm sm:text-sm">
          <p>
            מסמך זה הוא טיוטה מקצועית לצורכי הצגה בלבד ואינו מהווה ייעוץ משפטי.
            הנוסח כפוף לאישור משפטי לפני פרסום סופי.
          </p>
        </section>
      </div>
    </CorporateContainer>
  );
}
