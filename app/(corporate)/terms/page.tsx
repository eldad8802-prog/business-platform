import type { Metadata } from "next";
import { CorporateContainer } from "@/components/corporate/CorporateContainer";

export const metadata: Metadata = {
  title: "תנאי שימוש",
  description:
    "תנאי השימוש בשירות Dubiz, המופעל על ידי PRO MAX GROUP — קבלת התנאים, אחריות המשתמש, קניין רוחני והגבלת אחריות.",
};

export default function CorporateTermsPage() {
  return (
    <CorporateContainer className="py-12 sm:py-16">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-extrabold leading-tight text-gray-900 sm:text-4xl">
          תנאי שימוש
        </h1>
        <p className="mt-3 text-sm text-gray-500">עודכן לאחרונה: 4 ביוני 2026</p>
      </header>

      <div className="mt-10 max-w-3xl space-y-9 text-sm leading-7 text-gray-600 sm:text-base">
        <section>
          <h2 className="text-lg font-bold text-gray-900">קבלת תנאים</h2>
          <p className="mt-3">
            השימוש בשירות Dubiz, המופעל על ידי PRO MAX GROUP, כפוף לתנאים אלה.
            עצם השימוש בשירות מהווה הסכמה לתנאים. אם אינך מסכים לתנאים, אין לעשות
            שימוש בשירות.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">תיאור השירות</h2>
          <p className="mt-3">
            Dubiz הוא כלי לניהול עסקי המאפשר ריכוז וניהול של שיחות ולקוחות,
            מסמכים וחשבוניות, מלאי ורכש, וכן הצגת תובנות והמלצות פעולה. היקף
            היכולות עשוי להשתנות ולהתעדכן מעת לעת.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">אחריות המשתמש</h2>
          <p className="mt-3">
            אתה אחראי לפרטי החשבון שלך ולשמירה על סודיות פרטי ההתחברות, וכן לכל
            פעילות המתבצעת בחשבונך. עליך לוודא כי המידע שאתה מזין נכון ומעודכן,
            וכי השימוש שלך בשירות תואם את הדין החל.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">שימוש מותר ואסור</h2>
          <p className="mt-3">
            מותר להשתמש בשירות למטרות עסקיות לגיטימיות בלבד. אסור לעשות בשירות
            שימוש בלתי חוקי, לפגוע באבטחתו או בתקינותו, לנסות לקבל גישה בלתי
            מורשית, להעלות תוכן מזיק, או להשתמש בשירות באופן הפוגע בזכויות צד
            שלישי.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">אינטגרציות צד ג&apos;</h2>
          <p className="mt-3">
            השירות עשוי להציע חיבור לשירותים חיצוניים לפי בחירתך. השימוש בשירותים
            אלה כפוף לתנאים ולמדיניות של אותם ספקים, ואיננו אחראים לזמינותם,
            לתפקודם או למדיניותם של שירותי צד שלישי.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">זמינות השירות</h2>
          <p className="mt-3">
            אנו שואפים לספק שירות זמין ויציב, אך איננו מתחייבים לזמינות רציפה
            וללא הפרעות. ייתכנו פעולות תחזוקה, עדכונים או הפסקות שירות זמניות.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">קניין רוחני</h2>
          <p className="mt-3">
            כל הזכויות בשירות Dubiz, לרבות התוכנה, העיצוב, הסימנים והתכנים שמקורם
            בנו, שייכות ל-PRO MAX GROUP או לבעלי הזכויות מטעמה. אין להעתיק, לשכפל
            או לעשות שימוש בהם ללא הרשאה. המידע והתוכן העסקי שאתה מזין למערכת
            נותרים בבעלותך.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">הגבלת אחריות</h2>
          <p className="mt-3">
            השירות מסופק כפי שהוא (&quot;as is&quot;). במידה המרבית המותרת על פי
            דין, PRO MAX GROUP לא תישא באחריות לנזקים עקיפים או תוצאתיים הנובעים
            מהשימוש בשירות, ואינה מתחייבת כי השירות יתאים לכל צורך ספציפי.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">שינויים בתנאים</h2>
          <p className="mt-3">
            אנו רשאים לעדכן תנאים אלה מעת לעת. המשך השימוש בשירות לאחר עדכון מהווה
            הסכמה לתנאים המעודכנים. מומלץ לעיין בתנאים מעת לעת.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">דין חל</h2>
          <p className="mt-3">
            על תנאים אלה יחולו דיני מדינת ישראל, וסמכות השיפוט הבלעדית תהא נתונה
            לבתי המשפט המוסמכים בישראל.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900">יצירת קשר</h2>
          <p className="mt-3">
            לשאלות בנוגע לתנאים אלה ניתן לפנות אל PRO MAX GROUP בכתובת{" "}
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
