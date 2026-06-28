# Canonical B-2 Runbook — Production DB Host Verification

**Status:** RATIFIED · **Version:** v1 · **Ratified:** 2026-06-28
**Classification:** Low-Risk, controlled · **Output:** Production DB host → branch identity = VERIFIED

> מסמך קנוני. **Part 0** ממקם את B-2 בארכיטקטורה; **Part A** מגדיר את התהליך הקנוני (provider-agnostic);
> **Part B** מרכז את המימוש הנוכחי (ניתן-להחלפה). אם מנגנון המימוש ישתנה — רק Part B מתעדכן; Part 0/A נשארים נכונים.
>
> **הפרדת החלטות (מחייבת):** אישור המסמך הקנוני הוא החלטה אחת. החלטה לבצע את B-2 בפועל היא החלטה נפרדת לחלוטין.

---

# PART 0 — Architectural Position

## 0.1 מהו B-2 — ומה אינו
B-2 הוא **Recovery / Bootstrap Procedure** לזהות ה-Production DB. הוא **אינו** רכיב של זרימת ה-Release השגרתית, ו**אינו** מנגנון אימות חוזר.

| B-2 **הוא** | B-2 **אינו** |
|---|---|
| הליך חריג לשחזור/אתחול זהות | שלב בכל Release |
| מופעל חד-פעמית כשהזהות אבודה/לא-ידועה | בדיקה שגרתית per-deploy |
| Low-Risk, מבוקר, מאושר נקודתית | Gate או automation במסלול הרגיל |
| יוצר **ראיה ישירה** שמְאַתחֶלת את ה-Registry | מקור-אמת מתמשך |

## 0.2 מיקום במודל השכבתי
במונחי המודל הקנוני (Intent → Control → Execution):
- **B-2 אינו Gate ואינו Controller.** הוא **פעולת Execution חד-פעמית** שמטרתה היחידה היא **לאתחל עובדה** ב-Source of Truth (ה-DB Identity Registry).
- לאחר האתחול, ה-**Control Layer** (Release Controller + DB Identity Gate) הוא שמסתמך על ה-Registry המאומת — **לא** על B-2.
- B-2 ניצב **מחוץ** ל-state machine של ה-Release; הוא לא משנה state של Release ולא נוגע ב-Promotion/Migration.

```
   ┌───────────────────────────────────────────────┐
   │  NORMAL RELEASE PATH (כל Release)              │
   │  Release Controller → DB Identity Gate         │
   │        └── מסתמך על: VERIFIED Registry         │
   └───────────────────────────────────────────────┘
                      ▲
                      │ (קורא בלבד)
              ┌───────────────┐
              │  Registry     │  ← Source of Truth לזהות
              │ (VERIFIED)    │
              └───────────────┘
                      ▲
                      │ (כותב פעם אחת, באתחול בלבד)
   ┌───────────────────────────────────────────────┐
   │  B-2  (Recovery / Bootstrap)  — OFF-PATH       │
   │  מופעל רק כש-Registry = UNKNOWN ו-Zero-Risk מוצה │
   └───────────────────────────────────────────────┘
```

## 0.3 תנאי ההפעלה (Lifecycle של B-2)
B-2 **נכנס** למסלול אך ורק כאשר **שני** התנאים מתקיימים:
1. Production DB Identity **אינו VERIFIED** (UNKNOWN או INFERRED בלבד), **וגם**
2. **כל** מקורות הראיה במסגרת Zero-Risk מוצו (ישירים + S7 + S6).

B-2 **יוצא** מהמסלול ברגע ש:
- הזהות הפכה ל-**VERIFIED** לפי A8, **וגם**
- ה-**Registry עודכן** בהתאם, **וגם**
- **הראיה ששימשה לקביעת VERIFIED נשמרה כחלק מה-Audit Trail, כך שניתן יהיה בעתיד לשחזר ולהסביר את ההכרעה.**

מאותו רגע — **B-2 אינו נדרש עוד**. הוא חוזר למסלול **רק** אם הזהות **תאבד שוב** (למשל: שינוי binding של ה-`DATABASE_URL`, rebuild/החלפת branch של Production, או אובדן/ספק לגבי ה-Registry).

> **עקרון Provenance:** VERIFIED אינו רק מצב נוכחי של ה-Registry, אלא מצב שניתן תמיד **להסביר ולשחזר** על בסיס הראיות שהובילו אליו. זהו אותו עקרון Provenance שעליו מבוססת כל ארכיטקטורת ה-Release.

## 0.4 על מה מסתמכת הזרימה הרגילה (ולא על B-2)
- זרימת ה-Release השגרתית מסתמכת על **Registry מאומת** + **DB Identity Gate** + שאר ה-Gates.
- ה-Gate בודק את ה-Registry (VERIFIED) — **לא** מריץ B-2.
- כל עוד ה-Registry VERIFIED ותקף, **שום Release אינו מפעיל B-2**.

## 0.5 Anti-Pattern מפורש (מה למנוע)
> ❌ **אסור** ש-B-2 ייתפס או ייושם כחלק מתהליך Release שגרתי, כ-Gate, או כבדיקה אוטומטית חוזרת.
> ❌ **אסור** להריץ B-2 "ליתר ביטחון" בכל deploy — זו חציית-גבול Low-Risk מיותרת.
> ✅ B-2 הוא **הליך חריג לשחזור זהות**, מאושר נקודתית, ויוצא מהמסלול ברגע שהזהות מאומתת.

## 0.6 קשר ל-Re-verification עתידי
אם בעתיד יידרש אימות-מחדש (drift/binding change), הסדר הקנוני נשמר:
**S7 (Zero-Risk) → S6 (INFERRED) → ורק אם נדרש VERIFIED בוודאות → B-2.**
B-2 לעולם אינו הצעד הראשון, ולעולם אינו חלק קבוע במסלול.

---

# PART A — Canonical Process (provider-agnostic)

## A1. מטרה והבעיה שנפתרת
זהות ה-Production DB היא UNKNOWN — לא ידוע לאיזה branch מצביע סוד ה-`DATABASE_URL` של ה-Production. B-2 מפיק **ראיה ישירה** ל-**hostname** שה-Production מתחבר אליו בפועל, **מתוך הסביבה שכבר מחזיקה את הסוד**, בלי לחשוף את הסוד — ומתאים אותו למרשם ה-endpoints כדי להגיע ל-VERIFIED.

## A2. מדוע B-2 רק לאחר מיצוי Zero-Risk
B-2 חוצה גבול (Low-Risk) ולכן **מוצא אחרון** — מותר רק כאשר **כל** מקורות הראיה הישירים והעקיפים ב-Zero-Risk מוצו ותועדו, ו-S7 (ראיית-לוג) לא הניב ראיה, ו-S6 (פעילות) נתן לכל היותר INFERRED.

## A3. Preconditions (עקרוניים)
- **P1.** מוצו ותועדו כל מקורות הראיה ב-Zero-Risk (ישירים + S7 + S6).
- **P2.** קיים מרשם `host ↔ branch` עדכני ואמין, עם **עוגן מאומת** (host של סביבה ידועה, למשל dev).
- **P3.** קיים **probe מאומת** שמפיק **hostname בלבד**, מאחורי guard, ללא גישת DB.
- **P4.** התקבל **אישור מפורש** של בעל-החלטה להפעלת B-2.
- **P5.** קיימת גישת-קריאה/בנייה לגיטימית לסביבת ה-Production (היכן שהסוד מוזרק).
- **P6.** הוסכם ש-B-2 **לא יקדם** שום deployment חי (אי-קידום מכוון).
- **P7.** אין במקביל deploy/Promotion אחר ל-Production.

## A4. Invariants (אסור להפר לאורך כל התהליך)
1. **אין חשיפת סוד:** ערך ה-`DATABASE_URL`/`DIRECT_URL` המלא לעולם לא מודפס, נכתב, או יוצא מסביבת ה-Production.
2. **פלט = hostname בלבד.** שום רכיב URL אחר (user/password/db/port/query).
3. **אי-קידום מכוון:** התהליך **חייב** להבטיח שלא נוצר deployment חי חדש; ה-Production הקיים אינו משתנה.
4. **אין משטח חשיפה חדש** (אין endpoint/route ציבורי שנוצר לצורך הבדיקה).
5. **אין גישת DB:** אין חיבור, אין SQL — רק פרסור של ערך ה-env לצורך חילוץ ה-host.
6. **אין migration / Promotion / Gate** במהלך B-2.
7. **בידוד מלא:** אין שינוי לענף הראשי, להגדרות ה-project, ל-env, או לסודות.
8. **ניקוי מלא חובה** בסיום.
9. **Guard פעיל:** ה-probe מסרב לפעול ללא אישור-הרצה מפורש.

## A5. Go / No-Go Checklist (לסימון לפני התחלה)
**GO רק אם כל הסעיפים מסומנים:**
- [ ] G1. Preconditions P1–P7 מתקיימים ומתועדים.
- [ ] G2. כל ה-Zero-Risk מוצה; S7 ריק; S6 ≤ INFERRED.
- [ ] G3. נדרש VERIFIED **בוודאות ובזמן נתון** (תנאי-חוסם לפעולה מאושרת אחרת).
- [ ] G4. אישור מפורש (P4) מתועד עם timestamp ומבצע.
- [ ] G5. מנגנון **אי-הקידום המכוון** מאומת מראש (Invariant #3).
- [ ] G6. מרשם ה-endpoints (P2) עדכני, עם עוגן מאומת.
- [ ] G7. הוגדרה תוכנית **Cleanup** ו-**Abort** לפני ההתחלה.
- [ ] G8. אין Promotion/deploy מתחרה ל-Production (P7).

**NO-GO** אם ולו סעיף אחד אינו מסומן → אין להתחיל; חזור ל-Decision Boundary (A14).

## A6. Canonical Flow
```
[Go/No-Go ✓]
   │
   ▼
(1) צור הקשר ביצוע מבודד (לא נוגע בענף הראשי / בהגדרות)
   │
   ▼
(2) בתוך הקשר זה, הרץ probe שמפיק hostname בלבד —
    בסביבה שבה סוד ה-Production כבר מוזרק
   │
   ▼
(3) אכוף אי-קידום מכוון (הבנייה לא מסתיימת ב-deployment חי)
   │
   ▼
(4) אסוף את ה-hostname מתוך פלט-הביצוע (host-only)
   │
   ▼
(5) Independent Verification: התאם דטרמיניסטית ל-host↔branch registry
   │
   ▼
(6) הכרע VERIFIED לפי A8 → עדכן Registry → רשום Audit Trail
   │
   ▼
(7) Cleanup מלא של ההקשר המבודד וכל משאב זמני
```
(בכל נקודה — אם מתקיים תנאי Abort, ראה A10.)

## A7. שלבים קנוניים (מופשט)
| # | שלב קנוני | עיקרון |
|---|---|---|
| 7.1 | **הקשר ביצוע מבודד** | סביבה זמנית שאינה משנה את הענף הראשי, ההגדרות, או ה-Production. |
| 7.2 | **Host-only probe** | רכיב שקורא את סוד ה-DB מה-env ומפיק **רק** את ה-hostname, מאחורי guard. |
| 7.3 | **הזרקת סוד הסביבה** | ה-probe רץ היכן שסוד ה-Production כבר קיים — **לא** נשלף החוצה. |
| 7.4 | **אי-קידום מכוון** | מובטח שהביצוע **לא** יוצר deployment חי (כשל מכוון / מנגנון שווה-ערך). |
| 7.5 | **איסוף ראיה** | חילוץ ה-hostname **בלבד** מפלט הביצוע. |
| 7.6 | **התאמה דטרמיניסטית** | נרמול ה-host והשוואה למרשם → branch יחיד. |

## A8. הגדרת VERIFIED (מחודדת)
> **VERIFIED אינו "נמצא host".** הזהות נחשבת VERIFIED **אך ורק** כשמתקיימים **כל ארבעת** התנאים:
> 1. **ראיה ישירה נאספה** — hostname יחיד שמקורו בסביבת ה-Production עצמה (לא הסקה).
> 2. **התאמה חד-משמעית בוצעה** — ה-host תואם ל-**branch יחיד** במרשם (Independent Verification, A9).
> 3. **Audit Trail נשמר** — ההכרעה, הראיה (host+branch), והאישור מתועדים (A12).
> 4. **ה-Registry עודכן** — מצב הזהות שונה רשמית ל-`VERIFIED (<branch>)` עם מקור הראיה.
>
> חסר ולו תנאי אחד → הזהות נשארת **UNKNOWN / INFERRED**, לא VERIFIED.

## A9. Independent Verification
מטרה: לוודא שההתאמה אינה תלויה בשיקול-דעת המבצע, וניתנת לשחזור ע"י גורם שלישי.
- **IV1. נרמול קנוני:** הסר וריאנט-pooler וסיומת דומיין → token יציב `endpoint-id`. הנרמול מתועד ככלל, לא כפעולה ידנית.
- **IV2. התאמה דטרמיניסטית:** חפש את ה-token במרשם; דרוש **בדיוק התאמה אחת**. 0 או >1 → לא VERIFIED.
- **IV3. עוגן שלילי:** ודא שה-host **אינו** של סביבה לא-production ידועה (dev/preview) — אחרת זהו ממצא תצורה, לא production.
- **IV4. שחזוריות:** גורם שני, בהינתן אותו hostname ואותו מרשם, חייב להגיע **לאותה** הכרעה. ההכרעה (host → branch_id) נרשמת כך שניתן לשחזרה.
- **IV5. תיעוד ההכרעה:** נשמרים ה-hostname, ה-token המנורמל, ה-branch_id/name, וגרסת המרשם ששימשה.

## A10. Abort Criteria (עצירה מיידית גם לאחר התחלה)
עצור **מיד** והפעל Cleanup (A11) אם מתקיים אחד מאלה:
- **AB1.** חשד/ראיה שערך סוד כלשהו עומד להיחשף או הודפס (הפרת Invariant #1/#2).
- **AB2.** מנגנון אי-הקידום נכשל / קיים סיכון שייווצר deployment חי (הפרת #3).
- **AB3.** הופק יותר מ-hostname אחד, או פלט בלתי-צפוי.
- **AB4.** ה-token תואם ל->1 branch, או ל-0 (אי-חד-משמעות).
- **AB5.** ה-host מצביע על סביבת dev/preview (ממצא תצורה — דווח, אל תכריז production).
- **AB6.** ההקשר המבודד החל לגעת בענף הראשי/בהגדרות/ב-Production בפועל.
- **AB7.** מתחיל במקביל Promotion/deploy ל-Production.
- **AB8.** האישור (P4) נשלל באמצע.

לאחר Abort: הזהות נשארת **UNKNOWN**; אין תוצאה חלקית "כמעט-VERIFIED".

## A11. Recovery / Cleanup (ניקוי מלא חובה)
- **C1.** השמד את הקשר-הביצוע המבודד לחלוטין.
- **C2.** ודא שלא נוצר deployment חי; אם נוצר בטעות — rollback מיידי לקודם.
- **C3.** ודא שהענף הראשי, ההגדרות, ה-env והסודות **לא השתנו**.
- **C4.** מחק כל משאב/לוג זמני שנוצר לצורך הבדיקה.
- **C5.** הצהר: **אפס שארית**.

## A12. Audit Trail
ללא סודות, מינימלי-מספיק:
- **A12.1** timestamp · מבצע · רפרנס אישור (P4).
- **A12.2** ה-hostname (host-only) + ה-branch שהותאם + גרסת המרשם.
- **A12.3** ראיה לאי-קידום (שהביצוע לא יצר deployment חי).
- **A12.4** הצהרת Cleanup (C1–C5 בוצעו).
- **A12.5** מעבר מצב: `Production DB Identity: UNKNOWN → VERIFIED (<branch>)`.
- **A12.6** הראיה נשמרת באופן שניתן **לשחזר ולהסביר** את ההכרעה בעתיד (עקרון Provenance, 0.3).

## A13. Risk Assessment — Low-Risk ולא Zero-Risk
B-2 נוגע בסביבת ה-Production (הקשר-ביצוע), גם אם ללא קידום — ולכן אינו Zero-Risk.
- **R1 (מנוטרל):** כשל במנגנון אי-הקידום → מיטיגציה: אכיפת אי-קידום + אימות + AB2.
- **R2 (נמוך):** ה-hostname מופיע בפלט-ביצוע פנימי — host אינו סוד.
- **R3 (זניח):** צריכת משאב-בנייה בודד.
לעומת Zero-Risk (S7) שאינו נוגע כלל ב-Production.

## A14. Decision Boundary
- **הפעל B-2** רק כאשר: נדרש VERIFIED בוודאות ובזמן נתון (תנאי-חוסם), **וגם** S7 ריק, **וגם** התקבל אישור (P4).
- **המתן ל-S7 (Zero-Risk)** כאשר: אין לחץ זמן, או סביר שתיווצר ראיית-לוג ישירה.
- **ברירת מחדל:** המתן ל-S7 עד שהזהות הופכת לתנאי-חוסם בפועל.

---

# PART B — Reference Implementation (Current Implementation)

> מימוש קונקרטי **נוכחי** מעל GitHub + Vercel + Neon + `host-probe.mjs`. **אינו** חלק מהתהליך הקנוני;
> אם הספקים ישתנו — רק חלק זה מתעדכן.

| עיקרון קנוני (Part A) | מימוש נוכחי |
|---|---|
| 7.1 הקשר ביצוע מבודד | **throwaway git branch** מ-`main` (לא ממוזג, לא נדחף ל-main). |
| 7.2 Host-only probe | `ops/release/scripts/host-probe.mjs` — `console.log(new URL(process.env.DATABASE_URL).hostname)` יחיד, guard `HOST_PROBE_CONFIRM=yes`. |
| 7.3 הזרקת סוד | build של **Vercel Production** מזריק את `DATABASE_URL` בscope Production ל-build env. |
| 7.4 אי-קידום מכוון | build-command (ב-`vercel.json` של ה-throwaway):<br>`HOST_PROBE_CONFIRM=yes node ops/release/scripts/host-probe.mjs && exit 1` — ה-`exit 1` מכשיל את ה-build ⟹ אין promotion. |
| הרצה | `vercel deploy --prod` מתוך ה-throwaway (ללא push ל-main). |
| 7.5 איסוף ראיה | `vercel inspect <failed-deployment-url> --logs` ‖ `grep -oE 'ep-[a-z0-9-]+\.[a-z0-9-]+\.aws\.neon\.tech'`. |
| 7.6 / A9 התאמה | נרמול: הסר `-pooler` → token `ep-<id>`; חפש ב-`ops/release/infra-endpoints.json` → `host_to_branch[].host` → `branch_name`+`branch_id`. |
| עוגן (P2/IV3) | `ep-square-grass-…` = `dev` (מאומת מול `.env` המקומי). |
| A11 Cleanup | `git branch -D tmp/b2-host-verify` (+ remote delete אם נדחף); `vercel remove <throwaway-url>`; ודא `origin/main` ללא commit חדש ו-production alias ללא שינוי. |
| A12 Audit | אופציונלי דרך `ops/release/scripts/append-event.mjs` (`type: ProductionDbVerified`, payload = host+branch בלבד, sanitized). |
| A4/A8 Registry update | עדכון `ops/release/infra-registry.json.env_to_branch_identity.production` מ-`UNKNOWN` ל-`<branch_name>` עם מקור הראיה (PR additive read-only נפרד). |

**Reference Failure-Mode mapping (מימוש):** ה-probe `exit 2` (F1), build לא נכשל (F2/AB2), אין host בלוג (F3/AB3), token לא נמצא/כפול (F4–F5/AB4), host=dev (F6/AB5), פלט חורג (F7/AB1).

---

## Document Status
- **RATIFIED 2026-06-28.** עקרונות Zero-Risk / Low-Risk לא שונו.
- **אישור המסמך הקנוני** ≠ **החלטה לבצע את B-2**. הביצוע יידון בהחלטה נפרדת לחלוטין, אם וכאשר יהיה צורך.
- מצב נוכחי בעת האישור: Production DB Identity = **UNKNOWN**; מועמד מוביל `production-NEW` / `br-soft-sky-amhzr0wo` / `ep-frosty-pine-amwwgl46` = **INFERRED, MEDIUM, NOT VERIFIED**.
