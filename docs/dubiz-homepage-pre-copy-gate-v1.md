# Dubiz — Homepage v1 · Pre-Copy Gate v1

> **מטרה:** לסגור את ההחלטות היחידות שעדיין משפיעות על נוסח-ההמרה ועל גבולות-הטענות — **לפני** כתיבת קופי סופי. **לא** קופי, **לא** CTA microcopy סופי, **לא** קוד.
> **בסיס קנוני:** Reconciliation v1 + Wireframe v2 (מנצחים בכל סתירה) · Visual Spec v1 · **Product Truth מהקוד (firsthand)**.
> **תאריך:** 2026-08-16 · **main:** `bd65eeb` (ללא שינוי מאז Warm Alignment).

---

## 1. Current Product Truth Changes
`origin/main` = `bd65eeb`, **ללא שינוי** מאז ה-Reconciliation. אין שינוי ב-onboarding/signup/pricing/scheduler/notifications/Gmail/billing/WhatsApp/customer-card/allocation/multi-user. **הבסיס יציב.** (עדכון יחיד שכבר תועד: כרטיס-לקוח B→**A**.)

## 2. Signup / Onboarding / First-Action Audit (firsthand)
| שאלה | ממצא (firsthand) |
|---|---|
| signup עצמי? | **כן** — `/register` (766 שו') → POST `/api/auth/register` → `/api/auth/login` |
| שדות הרשמה | שם-עסק · שם · אימייל · סיסמה (+חוזק) — **בלי invite/code** |
| הזמנה/human-gate נדרשים? | **לא** — פתוח לאנונימי |
| onboarding? | **כן** — `/onboarding` (פרופיל: קטגוריה/תת/מודל-עסקי) → `/api/business/profile` |
| business creation? | כן — נוצר בהרשמה/onboarding |
| plan/tier/subscription/payment/checkout בהרשמה? | **אין** (grep NONE ב-register+onboarding) |
| payment-wall לפני שימוש? | **לא נמצא** |
| CTA יכול להוביל לפעולה אמיתית? | **כן** — `/register` = self-serve אמיתי |
| נתיב בפועל | קיפול `[PRIMARY]` → `/register` → `/onboarding` → מוצר |
| visitor אנונימי מתחיל בלי לדבר עם אף אחד? | **כן** |
> **הערת first-run (לא-חוסמת):** ערך-מיידי-בדקות (דרישת שלב 8) מגיע דרך קליטה (צילום-מסמך/וואטסאפ) לאחר onboarding; חיבור-וואטסאפ הוא צעד. הקופי בשלב 8 יכייל "ערך גלוי" למה ש-first-run מספק בפועל — אינו חוסם CTA.

## 3. Pricing Audit (firsthand)
- **`/pricing` (1924 שו') = פיצ'ר-מוצר** (מחשבון-תמחור למוצרי/שירותי הבעלים: overhead%, min/recommended/premium, profit) — **לא** דף-מנוי של Dubiz.
- **אין** מחיר-מנוי קנוני · אין plan · אין free · אין trial · אין pricing-route ציבורי · אין החלטה-עסקית כתובה.
> **מסקנה:** **Homepage v1 copy = price-neutral.** אסור: "בחינם" · "ללא התחייבות" · "רק X ₪" · "נסו חינם" · כל claim מסחרי לא-מאומת.

## 4. OD2 Decision — Price + First Action
**Self-serve start קיים ואמיתי (מאומת §2).** שלושת המודלים:
| מודל | wording family | route/action | חיכוך | אמת? | conversion | סיכון |
|---|---|---|---|---|---|---|
| **A · Self-serve start** ⭐ | "התחילו…" / "פתחו חשבון" (price-neutral) | `/register` (self-serve אמיתי) | נמוך-בינוני (טופס קצר) | **A** | הכי-ישיר | **אין** — הפעולה אמיתית |
| B · See how it works | "ראו איך זה עובד" | גלילה/הדגמה | הנמוך ביותר | A | חלש יותר לבד | ממתין להמרה |
| C · Contact/request access | "דברו איתנו" | טופס-קשר | גבוה | לא-נדרש | מתאים ל-enterprise, לא לפרסונה | **סתירה לפרסונה** |

> **המלצה: OD2 = A (Self-serve start).** ה-**Primary CTA action נעול** = self-serve → `/register` (price-neutral). **B** נשאר כ-**Secondary** ("ראו איך זה עובד", חיכוך-נמוך). **C נדחה** (לא מתאים לפרסונה/מחיר, story §8). **הניסוח הסופי של ה-microcopy נדחה** (יותר מאופציה תקינה אחת) — אך **הפעולה אחת וברורה.**

## 5. OD3 — R37
- **השאלה:** האם הבעלים בעצם רוצה ש-Dubiz **תחליט במקומו** (ולא רק תסדר ותציע)?
- **למה נדחתה:** שאלת-יסוד על מודל-המוצר; אינה ניתנת-להכרעה בקופי (story §4.3, §8-dep6) → 8–12 שיחות-לקוחות.
- **האם חוסמת copy?** **לא.** הדף אינו טוען אף כיוון; הוא מציג את **מודל-השליטה** (Dubiz מסדרת/מציעה → אתה מחליט), שהוא Product-Truth-true ללא תלות ב-R37.
- **באיזה stage:** נוגע ל-4/7 — אך מודל-השליטה מכסה אותם בבטחה.
> **תוצאה: DEFER WITHOUT BLOCKING COPY.** לא להמציא claim/section.

## 6. CTA Architecture Lock
| | הכרעה |
|---|---|
| **Primary CTA — job** | להתחיל self-serve |
| **Primary — destination** | `/register` (**נעול**; מחליף את `/login` הנוכחי השגוי) |
| **Primary — wording** | price-neutral, action-start (microcopy סופי DEFER) |
| **Secondary CTA** | "ראו איך זה עובד" (חיכוך-נמוך; גלילה/הדגמה) |
| **Existing-user login** | "כניסה למערכת" → `/login`, **header בלבד**, משני |
| **Recurrence** | Fold · אחרי Proof (5) · Ask (8). פעולה-אחת (חוק 5) |
| **NOT** | דחיפות · pricing · demo/שיחת-מכירה כ-primary · פעולה-שנייה-מתחרה |

## 7. Existing-Copy Removal Matrix (`app/(corporate)/home/page.tsx` — NOT now)
| Existing copy (שורה) | Truth | Action |
|---|---|---|
| "...ומזכירה לך לשלם **בדיוק בזמן**" (76) | C | **REMOVE** |
| "עם **התראות חכמות** לפני שנגמר" (58) | C | **REMOVE** |
| "מכין טיוטות — **מסביב לשעון**" (82) | C | **REMOVE** |
| "שהכסף **יגיע אליך בזמן**" (63, כותרת גבייה) | B | **QUALIFY** (מסגור-תוצאה; לא scheduler — "לראות מה פתוח/לשלוח קישור") |
| כל אזכור **"מזכירה"** כדמות/כותרת | — | **REMOVE** (מבנה חדש, דה-האנשה) |
| eyebrow/H1 "מערכת ההפעלה לעסק" | — | **REMOVE** (פסול מיצוב §8) |
| 4 capability-cards כקטגוריות | — | **REPLACE** (מבנה 9-שלבים) |
> אין תיקון-קוד עכשיו; זו רשימת-נעילה ל-Homepage v1.

## 8. Claim Vocabulary Lock (מבוסס Product Truth)
- **SAFE (נתמך):** מרכזת · מסדרת · מציגה · מכינה (טיוטות) · קולטת · מזהה (OCR) · מסכמת · מציפה · מראה · שולחת קישור-תשלום (יזום ע"י הבעלים).
- **QUALIFIED (דורש הקשר):** זוכרת (=מרכזת, לא scheduler) · יודעת (=מזהה מהקליטה) · עוקבת (=מציגה סטטוס, לא aging) · מחברת (=מרכזת סביב עסק, לא sync) · לומדת/מכירה-לאורך-זמן (רך, לא engine).
- **FORBIDDEN v1 (לא נתמך):** מזכירה-בזמן · מתריעה · שולחת-לבד · רודפת (אחרי חייבים) · מסנכרנת-הכול · מנהלת-צוות · 24/7/מסביב-לשעון · "בדיוק בזמן" · "לפני שנגמר" (כהתראה) · מחליף-רו"ח · מבטיח-תקינות-גורפת.

## 9. Mechanism / Channel Claim Boundaries (שלב 3)
| ערוץ | exact capability | qualifier | forbidden implication |
|---|---|---|---|
| **וואטסאפ** | קליטת הודעות/מסמכים מהשיחות; ריכוז; בוט מכין טיוטות (אישור לפני שליחה) | **A** | outbound-אוטומטי · "עונה לבד" · מענה-24/7 |
| **Gmail** | קליטת מיילים/מסמכים | **B — gated אימות Google** | להבטיח לכולם; להוביל בו |
| **צילום/מסמכים** | צילום→OCR מזהה ספק/סכום/תאריך | **A** | "מבין הכול" · דיוק-מובטח-100% |
| **קלט ידני** | קיים | A | — |
> מסגור: **"בלי הקמה, בלי הזנה"** — הבידול. **אין** sync-arrows/logos-רחבים/"אינטגרציות"/realtime.

## 10. Privacy / Control Facts (שלב 4 — 4 עובדות ל-confidence copy)
1. **קריאה ממוקדת** — נקלט מה שרלוונטי לעסק; לא "הכול".
2. **המידע שלך שלך** — נשמר עבורך; אתה מנתק/מבטל גישה (קיים: gmail-token-revoke).
3. **אישור לפני יציאה** — שום דבר לא נשלח ללקוח/ספק/רשות בלי אישורך (בוט=טיוטה→אישור).
4. **בשליטתך** — חיבור/ניתוק בכל רגע.
> לא legal-copy מלא; לא "אנחנו לא עושים X"; ניסוח = *מה לא יקרה בלעדיך*.

## 11. Proof Inventory (שלב 5)
| proof | claim נתמך | evidence (firsthand) | שימוש |
|---|---|---|---|
| כרטיס-לקוח מרוכז | פרטים+מסמכים+תשלומים+שיחות במקום אחד | `app/(shell)/customers/[id]/page.tsx`→`CustomerCard` | **A** — screenshot/surface |
| גבייה פתוח/שולם + קישור | סטטוס-תשלום ברמת-חשבונית; קישור בלחיצה | collection + payment-links | **A** (בלי aging) |
| OCR/קליטת-מסמך | זיהוי ספק/סכום/תאריך | documents/OCR | **A** |
| בוט-טיוטות | מכין טיוטה, בעלים מאשר | bot | **A** (scope: draft+approve) |
| 270901 | תוכנה **רשומה** | תעודת-רישום | **A** (רישום בלבד; **לא** תקינות-גורפת R44) |
| Gmail | קליטה | gated | **B** |
| מספרי-הקצאה | — | transport לא-מאומת | **C — לא להשתמש** |
| הוכחה-חברתית | — | **אין** | **C — לא להמציא** |

## 12. Persona Copy Rules (OD1 סגור)
- **פונים אל:** בעל-עסק שמחזיק את היום־יום · בעל-מקצוע שגם מנהל תפעול · עסק עם פעילות (גם אם יש עובדים/ספקים/לקוחות).
- **אסור לרמוז:** multi-user · team-assignments · role-based-workflow · employee-collaboration · manager-dashboard-לצוות.
- **אסור לצמצם ל:** "פרילנסר" · "עסק של אדם אחד".

## 13. Pricing / Free — Forbidden Claims
"בחינם" · "נסו חינם" · "ללא התחייבות" · "רק X ₪" · plan/tier · trial · כל claim מסחרי. **Homepage v1 = price-neutral** עד הכרעת-מחיר עתידית (שער נפרד).

## 14. Final Copy Guardrails (סיכום מחייב)
1. Product Truth עוקף כל נוסח (§8 vocabulary).
2. price-neutral (§13).
3. דה-האנשה — trait לא דמות; אין "מזכירה" בקופי-פונה.
4. Adjacent-Objection — פרטיות(4) צמוד למנגנון(3).
5. חוק-בקשה-יחידה — `/register` self-serve, אחד.
6. אין דחיפות/פחד/אשמה/הבטחת-מה-שאין (חוק-החוקה).
7. פרסונה = בעל-מפעיל (§12).
8. 3 הפרות-הקופי — REMOVE ב-v1 (§7).

## 15. Remaining Owner Decisions
- **אין החלטה שחוסמת copy.** OD1 סגור · OD2 הוכרע (A, self-serve, price-neutral) · OD3 DEFER-non-blocking.
- **עתידי לא-חוסם:** (א) הכרעת-מחיר (אם/כאשר — יאפשר price-signal); (ב) R37 (שיחות-לקוחות); (ג) כיול "ערך-בדקות" ב-first-run (מוצר/onboarding, לא הומפייג').

## 16. Readiness Verdict
> **A — READY FOR COPYWRITING.**

הפעולה (self-serve `/register`), ה-CTA-architecture, הפרסונה, ה-price-neutrality, ה-claim-vocabulary, ה-channel/privacy/proof boundaries, ורשימת-ההסרה — **סגורים ומעוגנים firsthand ב-Product Truth**. R37 נדחה בלי-לחסום. אין Product-Truth שחוסם copy (לא C), ואין owner-decision יחיד תלוי (לא B) — כולן הוכרעו/נדחו-במפורש.

## 17. Exact Next Recommended Stage
**Homepage v1 Copywriting** — כתיבת קופי סופי לפי מבנה-9-השלבים (Wireframe v2), כפוף ל-Final Copy Guardrails (§14), ל-claim-vocabulary (§8) ולמטריצת-ההסרה (§7). *(Visual = REUSE DS v1 warm; אין שלב-עיצוב נוסף לפני קופי.)*

---

*Pre-Copy Gate. אינו קופי/קוד/עיצוב. כפוף ל-Reconciliation v1 + Wireframe v2 + Product Truth. 3 הפרות-הקופי הקיימות — לא תוקנו בקוד (רשימת-נעילה ל-v1).*
