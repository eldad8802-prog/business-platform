# DB Identity Registry — Canonical Architecture (Design v1)

**Status:** RATIFIED · **Version:** v1 · **Ratified:** 2026-06-28
**Classification:** Control-Layer Domain Object · **Provider:** agnostic

> ה-DB Identity Registry הוא ה-Source of Truth הרשמי לזהות ה-Database של כל סביבה.
> מסמך זה ממשיך את הקו הארכיטקטוני שננעל: **Evidence First · Read-Only/Additive לפני Blocking ·
> Provenance · Audit Trail · Single Authority Principle · Release Controller = Decision Engine ·
> VERIFIED = Necessary but not Sufficient · Registry = זהות בלבד · Current State ≠ History.**

---

## 1. מטרת ה-DB Identity Registry
ה-Registry הוא **ה-Source of Truth הרשמי והיחיד לזהות ה-Database** של כל סביבה (Production/Preview/Development) — קרי, איזה Database Instance/branch הוא ה-binding האמיתי של כל Environment. כל מערכת ה-Release **קוראת את האמת ממנו** ולא מ-secret, לא מהנחה, ולא מ-B-2.

## 2. אחריותו בארכיטקטורה
- מחזיק, לכל Environment, את **מצב הזהות** (status), ה-**binding** (branch/host מנורמל), ו-**Provenance** מלא.
- מספק תשובה חד-משמעית לשאלה: *"האם זהות ה-DB של סביבה X מאומתת, ואם כן — מהי?"*
- ה-Registry עונה על *"מהי זהות ה-DB וכמה היא מהימנה"* — **ולא** על *"האם פעולה מותרת"*. השאלה השנייה שייכת ל-Release Controller ולשאר ה-Gates.
- **אינו** אוסף ראיות בעצמו, **אינו** מריץ probes, **אינו** מחזיק secrets. הוא **רשומת-אמת** שמתעדכנת ע"י הסמכות בלבד (סעיף 11), על בסיס ראיות קבילות (סעיף 9).

## 2a. עיקרון-על — VERIFIED is Necessary but Not Sufficient
> **`VERIFIED` הוא תנאי הכרחי, לא מספיק.**
> זהות DB = VERIFIED היא **תנאי קדם הכרחי** ל-Migration/Promotion — אך **אינה מאשרת** אותם בפני עצמה.
> ה-Registry קובע **רק** *מהי הזהות ועד כמה היא מהימנה*. הוא **אינו** מחליט אם פעולה מותרת.
> ההחלטה לבצע Migration/Promotion שייכת ל-**Release Controller** ותלויה ב**כל** התנאים: שאר ה-Gates
> (Verification/Config/Single-Target/...), Approvals, Release State, Rollback Point, ו-Controller Decision.

מתורגם ל-state:
- `UNKNOWN / INFERRED / SUSPECT` → **fail-closed** (חוסם את התנאי הזהותי).
- `VERIFIED` → **מסיר את החסם הזהותי בלבד**, ומאפשר ל-Gates **להמשיך להעריך** את שאר התנאים.
- `VERIFIED` ≠ אישור Migration · ≠ אישור Promotion · ≠ "open gate" מלא.

## 3. הקשר ל-Release Controller
- ה-Registry שייך ל-**Control Layer**; ה-**Release Controller (Decision Engine)** הוא הסמכות היחידה שכותבת אליו מעברי-מצב.
- ה-Controller **קורא** מה-Registry כדי להכריע אם Release רשאי להתקדם בכל שלב התלוי ב-DB.
- עיקרון: **Providers/probes מייצרים ראיות; ה-Controller פוסק ומעדכן את ה-Registry.** (Single Authority Principle — סעיף 11.)

## 4. הקשר ל-B-2
- **B-2 אינו חלק מה-Registry.** הוא **מקור ראיה אפשרי אחד** (Recovery/Bootstrap) שתוצרתו (ראיית-host ישירה) עשויה לשמש לעדכון ה-Registry.
- ה-Registry קיים, נקרא, ונסמך עליו **ללא תלות** ב-B-2. כש-B-2 רץ, הוא מספק evidence; ה-Controller הוא שמחליט אם ה-evidence מצדיק מעבר ל-VERIFIED.
- לאחר שה-Registry = VERIFIED, **B-2 יוצא מהמסלול** (כמתואר ב-B-2 Runbook §0.3).

## 5. הקשר ל-Migration Gate
- ה-Migration Gate **קורא** מה-Registry. זהות DB = **VERIFIED** היא **תנאי הכרחי** לכך שה-Gate ימשיך להעריך migration — **לא** אישור לבצעה.
- כל מצב אחר (UNKNOWN/INFERRED/SUSPECT) → ה-Gate **fail-closed** וחוסם מיד.
- בזהות VERIFIED, ה-Gate ממשיך לבדוק את שאר התנאים שלו (no-drift, schema תואם, וכו'); רק אם **כולם** מתקיימים, ובכפוף להכרעת ה-Controller ולשאר ה-Gates/Approvals — migration רשאית לרוץ. ה-Gate **לעולם אינו כותב** ל-Registry.

## 6. הקשר ל-Verification Gate
- ה-Verification Gate צורך את ה-Registry: זהות VERIFIED היא **תנאי הכרחי** לכך שהשוואת schema (no-drift) תהיה בעלת בסיס אמין.
- אם הזהות אינה VERIFIED — אין בסיס אמין → ה-Gate חוסם. בזהות VERIFIED, ה-Gate **ממשיך** להעריך את שאר תנאיו; אישור סופי תלוי ב-Controller ובשאר ה-Gates. גם הוא **קורא בלבד**.

---

## 7. מודל הנתונים של ה-Registry
רשומה לכל Environment (provider-agnostic; שמות שדה לוגיים):

```
DbIdentityRecord {
  environment            : enum { production, preview, development, staging? }   // המפתח
  status                 : enum { UNKNOWN, INFERRED, VERIFIED, SUSPECT }          // סעיף 8
  binding {
     branch_ref          : opaque-id | null      // מזהה ה-branch הלוגי (לא secret)
     branch_label        : string   | null       // שם קריא
     endpoint_token      : string   | null       // host מנורמל (ep-<id>), לא connection string
  }
  confidence             : enum { none, low, medium, high }   // משמעותי ל-INFERRED
  evidence_refs          : [ EvidenceRef ]        // הצבעות לראיות ששימשו (סעיף 12)
  provenance {
     source              : enum { direct-log(S7), build-host-probe(B-2),
                                  activity-metrics(S6), external-attestation, ... }
     method              : string                 // כיצד נאספה הראיה
     actor               : string                 // מי הכריע / מי אישר
     decided_at          : timestamp
     prior_status        : enum                   // מאיזה מצב עברנו
     registry_version    : monotonic-int          // גרסת רשומה
  }
  last_verified_at       : timestamp | null
  drift {
     last_checked_at     : timestamp | null
     drift_signal        : enum { none, suspected, confirmed }
     drift_reason        : string | null
  }
}
```
**אסור** שהרשומה תכיל: connection string, username, password, db-name, או כל ערך secret. רק מזהים/labels/tokens לא-רגישים.

## 8. כל הסטטוסים האפשריים
| Status | משמעות | השפעה על blocking |
|---|---|---|
| **UNKNOWN** | אין binding אמין | fail-closed (חוסם את התנאי הזהותי) |
| **INFERRED** | ראיה עקיפה (S6/מטריקות); מועמד + confidence | fail-closed — אינו מסיר את החסם הזהותי |
| **VERIFIED** | ראיה ישירה + 4 התנאים (B-2 Runbook A8) | **מסיר את החסם הזהותי בלבד**; ה-Gates ממשיכים להעריך את שאר התנאים. **אינו** אישור לפעולה |
| **SUSPECT** | היה VERIFIED, התגלה drift; אמון נשלל זמנית | fail-closed כמו UNKNOWN |

**נימוק ל-SUSPECT (סטטוס נוסף):** המעבר `VERIFIED → UNKNOWN` מאבד מידע. **SUSPECT** הוא מצב-ביניים שמשמר את ה-Provenance של ה-VERIFIED הקודם **יחד עם** אות ה-drift — כך שהמערכת fail-closed (לא בוטחת בו), אך מסוגלת **להסביר** מדוע האמון נשלל ולכוון re-verification ממוקד. הוא נבדל מ-UNKNOWN ב-provenance העשיר ובכך שהוא **מצב מודע** (נשלל אמון) ולא **היעדר ידע**. אם נדרשת פשטות — SUSPECT יכול להתמוטט ישירות ל-UNKNOWN, אך מומלץ לשמרו.

## 9. ראיות מותרות לעדכון
| מעבר יעד | ראיה קבילה |
|---|---|
| → **INFERRED** | ראיה **עקיפה** מבוססת: S6 (activity/metrics), Neon-default flag, timeline — עם confidence מתועד. |
| → **VERIFIED** | ראיה **ישירה** + **כל 4 התנאים** (B-2 Runbook A8): (1) ראיית-host ישירה ממקור הסביבה (S7 log או B-2 build-probe), (2) התאמה חד-משמעית במרשם ה-endpoints (Independent Verification), (3) Audit Trail נשמר, (4) Registry עודכן. |
| → **SUSPECT/UNKNOWN** | אות drift מאומת (סעיף 14), או החלטת בעל-סמכות לשלול אמון. |

## 10. ראיות שאינן מספיקות
- **מטריקות פעילות בלבד (S6)** → **INFERRED בלבד, לעולם לא VERIFIED**.
- **Neon-default flag / שם branch ("production-NEW")** → INFERRED בלבד.
- **`.env` מקומי / dump ישן** → לא קביל (עלול להיות stale; מכיל secret).
- **הנחה / היסק עקיף / "כנראה"** → לא ראיה.
- **קריאת ערך ה-secret עצמו** → **אסור** (מפר Invariant; אינו ערוץ ראיה לגיטימי).
- ראיה ישירה ללא **Independent Verification חד-משמעית** (0 או >1 התאמות) → לא מספיק ל-VERIFIED.

## 11. מי רשאי לעדכן (Single Authority Principle)
- **סמכות הכתיבה היחידה ל-state של ה-Registry היא ה-Release Controller.** אף Provider, Gate, probe, או B-2 אינו כותב ישירות.
- **Evidence sources** (S6/S7/B-2) מייצרים **ראיות**; ה-Controller **פוסק** ומעדכן.
- **Release Owner (אנושי)** מאשר חציית-גבול לאיסוף ראיה (למשל הרצת B-2) ושלילת-אמון, אך אינו "הופך" state מחוץ להכרעת ה-Controller.
- אין שתי סמכויות לאותה החלטה; אין מצב ללא סמכות מגדירה.

## 12. Provenance מלא לכל שינוי
- כל מעבר מייצר רשומת Provenance **immutable** (כמו Release Event): `{source, method, actor, decided_at, prior_status, evidence_refs, registry_version}`.
- ה-`evidence_refs` מצביעים לראיה ה-sanitized (host+branch, ללא secret) — כך שכל VERIFIED **ניתן לשחזר ולהסביר** (עקרון Provenance מ-B-2 Runbook §0.3).
- שרשרת ה-Provenance היא **append-only** ו**מקושרת** (audit chain): מצב ה-Registry הנוכחי + ההיסטוריה המלאה.

## 13. Invariants (אסור להפר)
1. **No VERIFIED ללא ראיה ישירה + 4 התנאים** (A8).
2. **Gates קוראים, לא כותבים.** רק ה-Controller כותב state.
3. **Fail-closed:** כל סטטוס ≠ VERIFIED חוסם migration/promotion **על בסיס הזהות**.
4. **אין secret ב-Registry.** הזהות נשמרת כ-token/label לא-רגיש בלבד.
5. **Provenance חובה לכל מעבר** — אין state "יתום".
6. **Single Authority** — סמכות כתיבה יחידה (Controller).
7. **Preview לעולם לא נקשר לזהות Production.**
8. **INFERRED אינו פותח blocking** — לעולם אינו מתפקד כ-VERIFIED.
9. **Read-Only/Additive לפני Blocking** — ה-Registry מאוכלס בערוצי-קריאה; חסימה רק על VERIFIED.
10. **VERIFIED לעולם אינו מאשר פעולה בפני עצמו.** הוא מסיר חסם זהותי אחד בלבד; כל פעולה שמשנה Production דורשת בנוסף את שאר ה-Gates, Approvals, Release State, Rollback Point, והכרעת ה-Controller. (Necessary, not sufficient.)
11. **ה-Registry הוא Source of Truth לזהות בלבד** — אינו מנגנון אישור, אינו Gate, ואינו מקבל החלטות על פעולות.

## 14. כיצד מזהים Registry Drift
בדיקת drift **read-only, תקופתית/מאירוע**, ללא חציית-גבול:
- **D1.** ה-secret של ה-binding **עודכן** לאחר `last_verified_at` (signal: binding שונה אולי).
- **D2.** מרשם ה-endpoints השתנה — ה-`endpoint_token` הרשום **כבר אינו** ממופה ל-`branch_ref` הרשום.
- **D3.** אנומליית schema/חיבור שמרמזת על DB שונה מהמצופה.
- **D4.** rebuild/החלפת branch של Production (כמו ה-rebuild המתועד בהיסטוריה).
כל אות → `drift_signal = suspected/confirmed` עם `drift_reason`.

## 15. מה קורה כאשר Drift מתגלה
- מעבר מיידי **VERIFIED → SUSPECT** (או → UNKNOWN), עם Provenance של השלילה.
- **Fail-closed מיד:** Migration/Verification/Promotion Gates חוסמים.
- **Trigger ל-re-verification** בסדר הקנוני: **S7 → S6 → (אם נדרש) B-2**.
- שום פעולה שמשנה Production לא מתבצעת עד חזרה ל-VERIFIED.

## 16. התנהגות כאשר ה-Registry אינו VERIFIED
- **Fail-closed גלוי:** פעולות DB-תלויות (migration, promotion ל-Production) **חסומות בשל התנאי הזהותי**. (גם בזהות VERIFIED הן עדיין כפופות לשאר התנאים.)
- **Read-Only/Observability ממשיכים** — ניתן להמשיך לאסוף ראיות, להריץ previews שאינם נוגעים ב-Production DB, ולתעד.
- **שקיפות:** המערכת חושפת את הסטטוס המדויק (UNKNOWN/INFERRED/SUSPECT) + confidence + provenance — **לעולם לא** מניחה זהות בשתיקה.

## 17. מעברי מצב
**UNKNOWN → INFERRED**
- טריגר: ראיה עקיפה (S6) מייצרת מועמד.
- פעולה: ה-Controller רושם INFERRED + confidence + provenance. **לא** מסיר חסם זהותי; **לא** מאשר migration.

**INFERRED → VERIFIED**
- טריגר: ראיה ישירה (S7/B-2) **+ כל 4 התנאים (A8) + Independent Verification חד-משמעית**.
- פעולה: ה-Controller פוסק, מעדכן ל-VERIFIED, שומר `last_verified_at` + evidence_refs.
- **מסיר את החסם הזהותי בלבד**; ה-Gates התלויים **ממשיכים להעריך את שאר תנאיהם**. VERIFIED אינו פותח gate ואינו מאשר פעולה.

**VERIFIED → UNKNOWN** (אובדן אמון)
- טריגר: drift מאומת (סעיף 14) או שלילת-אמון מפורשת.
- פעולה: מומלץ דרך **VERIFIED → SUSPECT → UNKNOWN** — SUSPECT שומר provenance + drift_reason ומפעיל re-verification; אם לא ניתן לשחזר אמון, התמוטטות ל-UNKNOWN. בכל שלב — **fail-closed**, Provenance מלא של השלילה נרשם.

```
        ┌─────────── drift / loss of trust ───────────┐
        ▼                                              │
   [UNKNOWN] ──S6 indirect──► [INFERRED] ──S7/B-2 direct+A8──► [VERIFIED]
        ▲                                                          │
        └──────────────── [SUSPECT] ◄──── drift confirmed ─────────┘
              (fail-closed; provenance retained; re-verify S7→S6→B-2)
```

## 18. Current State vs History
> **עיקרון-על:** ה-Registry וה-Audit Trail הם **שני אובייקטים נפרדים עם תפקידים נפרדים**. אסור שאחד ישמש כתחליף לשני.

- **ה-DB Identity Registry הוא Source of Truth ל-Current State בלבד** — עונה על *"מה נכון עכשיו"*: זהות ה-DB של כל סביבה וסטטוס המהימנות (UNKNOWN/INFERRED/VERIFIED/SUSPECT).
- **ה-Registry אינו Source of History.** הוא אינו מחזיק את רצף המעברים — רק את המצב התקף הנוכחי (+ רפרנס ל-provenance האחרון).
- **ההיסטוריה המלאה של מעברי המצב נשמרת ב-Audit Trail / Provenance בלבד** — append-only, immutable, מקושר.
- **שינוי ב-Registry לעולם אינו מוחק היסטוריה.** עדכון מצב = רשומת Provenance **חדשה** שמתווספת; המצבים הקודמים נשמרים בשרשרת. ה-Registry "נע קדימה", ה-History "צובר".
- **כל מצב נוכחי ב-Registry חייב להיות ניתן להסבר באמצעות שרשרת ה-Provenance** — אין מצב "יתום" שאי-אפשר לשחזר את הראיות שהובילו אליו.
- **כדי להבין "איך הגענו לכאן" → Audit Trail.** **כדי לדעת "מה נכון עכשיו" → Registry.**

**שני Anti-Patterns שיש למנוע:**
- ❌ שימוש ב-**Registry כתחליף להיסטוריה** (שחזור מעברים קודמים מתוך הרשומה הנוכחית).
- ❌ שימוש ב-**Audit Trail כתחליף למצב הנוכחי** (הסקת "מה תקף עכשיו" מסריקת אירועים).

---

## Document Status
- **RATIFIED 2026-06-28.** עקרונות הקו הנעול לא שונו, אלא יושמו לאובייקט ה-Registry.
- **אישור המסמך הקנוני** ≠ **מימוש ה-Registry**. המימוש (additive, read-only לפני blocking) יידון ויאושר בנפרד.
- מצב נוכחי בעת האישור: Production DB Identity = **UNKNOWN**; מועמד `production-NEW` / `br-soft-sky-amhzr0wo` / `ep-frosty-pine-amwwgl46` = **INFERRED (MEDIUM)** — תואם בדיוק למודל זה (INFERRED, אינו מסיר חסם זהותי).
- השלב הבא המתוכנן: תכנון **Migration Gate** (מסמך), ורק לאחר אישורו — מימוש השכבה הראשונה.
