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
        <h1 className="text-3xl font-extrabold leading-tight text-[var(--mkt-ink)] sm:text-4xl">
          מדיניות פרטיות
        </h1>
        <p className="mt-3 text-sm text-gray-500">עודכן לאחרונה: 10 ביולי 2026</p>
      </header>

      <div className="mt-10 max-w-3xl space-y-9 text-sm leading-7 text-gray-600 sm:text-base">
        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">מי מפעיל את השירות</h2>
          <p className="mt-3">
            שירות Dubiz מופעל על ידי PRO MAX GROUP (&quot;אנחנו&quot;,
            &quot;החברה&quot;). מדיניות זו מסבירה כיצד אנו אוספים, משתמשים
            ושומרים מידע במסגרת השימוש בשירות.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
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
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">מטרות השימוש</h2>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>אספקת השירות והפעלת יכולותיו עבורך.</li>
            <li>שמירה, ארגון והצגה של המידע העסקי שלך בתוך המערכת.</li>
            <li>מתן תמיכה ומענה לפניות.</li>
            <li>שמירה על אבטחת המערכת, תקינותה ומניעת שימוש לרעה.</li>
            <li>שיפור ותחזוקה של השירות.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
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
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">
            חיבור חשבון Gmail ושימוש בשירותי Google
          </h2>
          <p className="mt-3">
            סעיף זה חל אך ורק על המידע שאנו מקבלים מחשבון ה-Gmail שלך כאשר אתה
            בוחר לחבר אותו לשירות. בכל הנוגע למידע המתקבל מממשקי Google, יגברו
            הוראות סעיף זה.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            איזה מידע מ-Gmail אנו ניגשים אליו
          </h3>
          <p className="mt-3">
            חיבור חשבון ה-Gmail הוא וולונטרי ומופעל אך ורק ביוזמתך, ונועד למטרה
            אחת: לאפשר לך לייבא למערכת מסמכים פיננסיים (כגון חשבוניות וקבלות)
            שהגיעו לתיבתך כקבצים מצורפים.
          </p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>
              בשלב האיתור, המערכת מאחזרת מ-Google את תוכן ההודעות התואמות
              לקריטריון איתור מצומצם — הודעות הכוללות קבצים מצורפים מתקופה אחרונה
              (למשל, מהחודש האחרון) — לצורך אחד בלבד: לאתר בתוכן את הקבצים
              המצורפים.
            </li>
            <li>
              מתוך הודעות אלו מוצגים לך ונשמרים אצלנו אך ורק נתוני-העל של הקבצים
              המצורפים (שם הקובץ, סוגו, גודלו ומזהים פנימיים). גוף ההודעה אינו
              נשמר, אינו מוצג לך כחלק מהשירות, ואינו משמש לניתוח כללי של תיבת
              הדואר שלך.
            </li>
            <li>
              רק לאחר שתבחר קובץ מסוים לייבוא, המערכת מורידה את אותו קובץ בלבד
              ומעבדת אותו.
            </li>
          </ul>
          <p className="mt-3">
            הגישה שלנו לחשבונך היא גישת קריאה בלבד. איננו שולחים, עורכים, מוחקים,
            מתייגים או משנים בכל דרך אחרת הודעות, תוויות או הגדרות בתיבת הדואר
            שלך.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            היקף ההרשאה ומטרתה
          </h3>
          <p className="mt-3">
            לצורך התכונה הזו אנו מבקשים את הרשאת Google המצומצמת ביותר המאפשרת
            קריאת תוכן קבצים מצורפים: gmail.readonly (בנוסף להרשאות הזיהוי
            הבסיסיות openid, email, profile לצורך זיהוי החשבון המחובר בלבד).
          </p>
          <p className="mt-3">
            הרשאת gmail.readonly נדרשת משום שהורדת קובץ מצורף ואיתור מבנה ההודעה
            שמכיל אותו אפשריים רק דרך הרשאת קריאת תוכן. איננו מבקשים ואיננו
            משתמשים בהרשאות שליחה, עריכה, מחיקה או ניהול תוויות.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            עיבוד OCR באמצעות Google Cloud Vision
          </h3>
          <p className="mt-3">
            לצורך חילוץ טקסט מהמסמך שבחרת לייבא, הקובץ נשלח לשירות Google Cloud
            Vision של Google — אך ורק לצורך עיבוד OCR (המרת תמונה/מסמך לטקסט) ולא
            לכל מטרה אחרת. זהו הצד השלישי היחיד שמקבל את תוכן המסמך שלך.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            חילוץ נתונים פיננסיים — עיבוד מקומי
          </h3>
          <p className="mt-3">
            לאחר שלב ה-OCR, חילוץ שדות המידע הפיננסי (כגון סכום, שם ספק, תאריך
            וקטגוריה) מתבצע באופן מקומי, על גבי התשתית שלנו, באמצעות מנגנון עיבוד
            קבוע. שלב זה אינו כרוך בהעברת המידע לשירות בינה מלאכותית, למודל שפה או
            לצד שלישי כלשהו.
          </p>
          <p className="mt-3">
            כעניין של מדיניות, איננו משתמשים במידע המתקבל מחשבון ה-Gmail שלך כדי
            לאמן, לכוונן (fine-tuning) או לפתח מודלים כלליים או מערכות בינה
            מלאכותית / למידת מכונה.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            אחסון והצפנת אסימוני OAuth
          </h3>
          <p className="mt-3">
            כאשר אתה מחבר את חשבונך, Google מנפיקה לנו אסימוני הרשאה (Access
            ו-Refresh) המאפשרים לשירות לגשת בקריאה בלבד. אסימונים אלה נשמרים אצלנו
            מוצפנים במנוחה, בתקן הצפנה מקובל (AES-256-GCM). איננו שומרים את סיסמת
            חשבון Google שלך; ההתחברות מתבצעת כולה מול Google.
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            ניתוק וביטול ההרשאה
          </h3>
          <p className="mt-3">
            תוכל לנתק את חשבון ה-Gmail מהשירות בכל עת. בעת ניתוק, המערכת:
          </p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>
              מוחקת אצלנו את האסימונים המאוחסנים, כך שלא ניתן עוד לעשות בהם שימוש;
              וכן
            </li>
            <li>
              מנסה לבטל את ההרשאה מול Google באמצעות מנגנון הביטול הרשמי של Google,
              על בסיס מאמץ סביר.
            </li>
          </ul>
          <p className="mt-3">
            ניסיון הביטול מול Google נעשה כמיטב היכולת ואינו מובטח; אולם מחיקת
            האסימונים המקומית מתבצעת בכל מקרה, כך שהגישה שלנו לחשבונך נפסקת אצלנו
            ללא תלות בהצלחת הביטול מול Google. בנוסף, באפשרותך לבטל את ההרשאה בכל
            עת גם ישירות מהגדרות חשבון Google שלך (myaccount.google.com/permissions).
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            עמידה במדיניות Google API Services User Data ו-Limited Use
          </h3>
          <p className="mt-3">
            השימוש שלנו במידע המתקבל מממשקי Google, וכל העברה שלו, כפופים ל-Google
            API Services User Data Policy, לרבות דרישות ה-Limited Use. בהתאם לכך:
          </p>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>
              המידע משמש אך ורק למתן התכונה הפונקציונלית שביקשת (ייבוא ועיבוד
              המסמכים שלך);
            </li>
            <li>המידע אינו משמש לפרסום או לפרסום ממוקד;</li>
            <li>איננו מוכרים את המידע;</li>
            <li>
              איננו מעבירים את המידע לצדדים שלישיים, למעט לספקי שירות הדרושים למתן
              התכונה (Google Cloud Vision לצורך OCR, כאמור לעיל);
            </li>
            <li>
              גישה אנושית מוגבלת: עיבוד המידע הוא אוטומטי, ועובדי Dubiz אינם ניגשים
              לתוכן המסמכים שלך במהלך הרגיל של מתן השירות. גישה כזו עשויה להתרחש רק
              במקרים מוגדרים ומצומצמים: כאשר הדבר נדרש כדי לקיים חובה שבדין; לצורך
              אבטחת מידע ומניעת הונאה או שימוש לרעה; או במסגרת תמיכה טכנית שביקשת,
              ובהסכמתך.
            </li>
          </ul>
          <p className="mt-3 italic text-gray-500">
            {"Dubiz's use and transfer to any other app of information received from Google APIs will adhere to the "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="text-[var(--mkt-link)] underline"
            >
              Google API Services User Data Policy
            </a>
            {", including the Limited Use requirements."}
          </p>

          <h3 className="mt-6 text-base font-semibold text-[var(--mkt-ink)]">
            שמירת מידע וזכויות המשתמש
          </h3>
          <ul className="mt-3 list-disc space-y-2 pe-5">
            <li>
              קבצים זמניים: הקובץ הזמני הנוצר לצורך עיבוד ה-OCR נמחק בתום עיבוד
              הבקשה (בין אם הצליחה ובין אם נכשלה) ואינו נשמר מעבר לכך.
            </li>
            <li>
              אסימונים: אסימוני ההרשאה נמחקים בעת ניתוק החשבון, כמפורט לעיל.
            </li>
            <li>
              מסמכים שיובאו: מסמך שבחרת לייבא והשדות שחולצו ממנו נשמרים כרשומות
              שלך במערכת, כל עוד נדרש לצורך מתן השירות או בהתאם לחובות שמירה שבדין.
            </li>
            <li>
              זכויותיך: באפשרותך לבקש גישה, תיקון או מחיקה של המידע האישי שלך,
              בכפוף לחובות שמירה חוקיות. ניתוק חשבון ה-Gmail אינו מוחק אוטומטית
              מסמכים שכבר ייבאת; לבקשת מחיקה של רשומות אלו, פנה אלינו.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">שמירת מידע ואבטחה</h2>
          <p className="mt-3">
            אנו שומרים את המידע למשך הזמן הדרוש לאספקת השירות ולעמידה בדרישות
            חוקיות, ונוקטים אמצעים סבירים לשמירה על אבטחת המידע מפני גישה, שימוש
            או חשיפה בלתי מורשים. יובהר כי אף שיטת אחסון או העברה אינה מאובטחת
            לחלוטין.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">זכויות משתמש</h2>
          <p className="mt-3">
            בכפוף לדין החל, באפשרותך לבקש לעיין במידע שלך, לתקנו או לעדכנו, וכן
            לבקש מידע על אופן השימוש בו. לפניות בנושא זה ניתן לפנות אלינו בפרטים
            שבהמשך.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">מחיקת מידע</h2>
          <p className="mt-3">
            באפשרותך לבקש את מחיקת המידע האישי שלך, בכפוף למגבלות ולחובות שמירה
            הנדרשים על פי דין או לצורך תפעול תקין של השירות. נטפל בבקשתך בהתאם
            לדין החל.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-[var(--mkt-ink)]">יצירת קשר</h2>
          <p className="mt-3">
            בכל שאלה או בקשה בנושא פרטיות ניתן לפנות אל PRO MAX GROUP בכתובת{" "}
            <a
              href="mailto:support@promaxgroup.co.il"
              className="text-[var(--mkt-link)] underline"
            >
              support@promaxgroup.co.il
            </a>
            .
          </p>
        </section>
      </div>
    </CorporateContainer>
  );
}
