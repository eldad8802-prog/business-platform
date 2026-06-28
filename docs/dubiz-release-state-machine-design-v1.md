# Release State Machine — Canonical Architecture (Design v1)

**Status:** RATIFIED · **Version:** v1 · **Ratified:** 2026-06-28
**Classification:** Control-Layer Domain Object · **Provider:** agnostic

> מגדיר את מחזור החיים הקנוני של Release כאובייקט דומייני. ממשיך ומיישם את הקו הנעול:
> Release = Domain Object · Event-Sourced · Controller = Decision Engine · Providers = Facts ·
> Policies = חוקים · Gates = אכיפת-Policy · Audit Trail = Source of History · State = Projection ·
> Single Authority · Provenance · VERIFIED necessary-not-sufficient · Report/Warning לפני Blocking.

---

## 1. מהו Release + הפרדת Intent / Decision / Execution
**Release הוא Domain Object** — יחידת intent של אוסף Changes שעובר עד Production כיחידה אטומית; **לא** pipeline run (זה היבט Execution). אובייקט ה-Release מפורק לשלושה רבדים מפורשים:

| רובד | מה | בעלים | טבע |
|---|---|---|---|
| **Release Intent** | מה רוצים: Changes, Target, Environment, מטרה | Release Owner | הצהרה (immutable) |
| **Release Decision** | ה-state המנוקרן, ה-verdicts, ה-Decision Events, הסמכות — **כאן חיה ה-State Machine** | Release Controller | event-sourced |
| **Release Execution** | facts של ספק: Artifact, Deployment, build | Execution Layer (ports) | עובדות, referenced |

ה-State Machine מנהלת את רובד ה-Decision בלבד. היא קוראת Intent וצורכת Execution-facts כ-verdicts — אך אינה מכילה לוגיקת ביצוע, ואינה תלוית-ספק.

## 2. למה State Machine ולא רק checks
checks נקודתיים וחסרי-זיכרון; State Machine קובעת **רצף חוקי**, **מעברים מותרים/אסורים**, ו**סמכות** לכל מעבר. בלעדיה "כל ה-checks ירוקים" אינו מונע דילוג שלבים (Promotion לפני Approval — כשל SF-2). היא המאפשרת fail-closed עקבי ו-Provenance מלא.

## 2a. Policy vs Mechanism
> ה-**Mechanism** (State Machine) מנהל *רצף* ו*חוקיות* מעברים — ואינו מכיל חוקים עסקיים.
> ה-**Policy** מגדירה *האם* מעבר מותר — החוק העסקי עצמו, כ-Verdict.

```
   Transition T  ── דורש Verdicts ──►  [ Policies רלוונטיות ]
        │                                       │
        │                           Verdict { pass/fail, reason,
        │                                     evidence_refs, enforcement_level }
        ▼                                       │
   Release Controller  ◄──────────────── אוסף verdicts
        │  מכריע (כל ה-required block-level = pass) → מוסיף Decision Event
        ▼
   State = projection(events)
```
- **Gate** = נקודת-אכיפה של Policy במעבר (Policy applied at a transition).
- ה-Mechanism יודע **אילו Policies** כל מעבר דורש — לא **מה הן אומרות**.
- כל Policy מחזירה `Verdict { pass | fail, reason, evidence_refs, enforcement_level: report | warn | block }`.
- ה-`enforcement_level` הוא המנגנון שדרכו Policy עוברת report→warn→block בהדרגה, **בלי** שינוי ב-Mechanism.

**Policies קנוניות (מינימלי):**
| Policy | קובעת | נצרכת במעבר |
|---|---|---|
| **Identity Policy** | DB Identity מספקת (Registry=VERIFIED) | Created→Prepared |
| **Verification Policy** | קריטריון build/lint/typecheck/tests | Built→Verified |
| **Migration Policy** | no-drift, schema תואם, אין irreversible ללא אישור | Built→Verified / Promotion |
| **Config Policy** | keys נדרשים per scope | Built→Verified |
| **Approval Policy** | מי רשאי לאשר ומה אישור תקף | Verified→Approved |
| **Promotion Policy** | Single-Target, Rollback Point נדרש, preconditions | Approved→Promoted |
| **Health Policy** | מהו "Live בריא" | Promoted→Released |
| **Rollback Policy** | מתי Rollback (auto/human), תוקף Rollback Point | Released→Rolled-Back |
| **Stability Policy** | מהי יציבות לסגירה | Released→Closed |

## 3. Event-Sourced Model
```
(facts/verdicts מ-Gates/Providers)  +  (current state = projection)
            │
            ▼
   Release Controller  ── מכריע ──►  Decision Event (immutable, appended)
            │
            ▼
   Current State = projection( event log )      ← נגזר, לעולם לא נכתב ישירות
```
- **ה-Event Log הוא ה-Source of Truth ו-ה-Source of History.** **ה-Current State הוא Projection** (fold) שלו.
- **ה-Controller מוסיף Decision Events בלבד** — אינו "כותב state". לפני append, ה-Controller מאמת שה-Event **חוקי** מ-ה-state המנוקרן (פונקציית חוקיות = ה-State Machine). Event לא-חוקי נדחה.
- **Provenance מובנה:** ה-State מוגדר כ-projection של ראיות → תמיד ניתן לשחזור והסבר; "אין state יתום" הופך לאמת מבנית.
- **Current State vs History:** "מה עכשיו" = ה-projection; "איך הגענו" = ה-Event Log. אותו לוג, שתי קריאות.
- **מימוש:** snapshot של ה-state מותר כ-cache בלבד (לא source).

## 4. Release Identity (אובייקט יציב)
```
ReleaseIdentity {
  // immutable-from-birth (ידוע ביצירה, לא משתנה):
  release_id        : opaque-id            // יציב לכל החיים
  target            : production-target
  environment       : enum
  intent_ref        : ChangeSet / Commit(s)
  created_by        : actor
  created_at        : timestamp
  // write-once bindings (נכתבים פעם אחת, monotonic, לעולם לא מתוקנים):
  artifact_ref      : set-at(Built)        | null
  schema_version    : set-at(Built)        | null
  rollback_point_ref: set-at(Promoted)     | null   // ראה §11
}
```
- הזהות יציבה; רק ה-Decision-state "נע". ה-bindings מתמלאים מונוטונית ולעולם אינם נכתבים-מחדש.
- **תיקון = Release חדש** עם `release_id` חדש (תואם "no backward edit").

## 5. הסטטוסים (רובד ה-Decision)
| State | משמעות מדויקת | טיפוס |
|---|---|---|
| **Created** | Release נפתח; Intent + Changes משויכים | פעיל |
| **Prepared** | Changes=Merged; **DB Identity=VERIFIED** ליעד (necessary-not-sufficient); Config/Schema מיושרים | פעיל |
| **Built** | Artifact immutable נוצר; `artifact_ref`+`schema_version` נכתבים (write-once) | פעיל |
| **Verified** | כל ה-Policies האוטומטיות מסרו verdict חיובי (Verification/Migration/Config/Identity) | פעיל |
| **Approved** | Release Owner נתן Approval מפורש (Approval Policy) | פעיל |
| **Promoted** | Rollback Point=Captured; Single-Target אומת; ה-Artifact מופץ ל-Production (בתהליך) | פעיל |
| **Released** | ה-Deployment בריא ותקף (Health Policy); ה-Release **כשיר לשרת** | פעיל-יציב |
| **Closed** | Release יציב נסגר; משאבים eligible ל-cleanup | טרמינל (הצלחה) |
| **Superseded** | היה Released; ה-Role של Live עבר ל-Release חדש | טרמינל |
| **Rolled-Back** | בעקבות כשל/החלטה, ה-Live הוקצה-מחדש מאיתו ל-Rollback Point | טרמינל |
| **Failed / Aborted** | נעצר לפני שירות (Policy שלילי / Abort / Approval נדחה) | טרמינל (כשל) |

## 6. Live כ-Role / Assignment
- **`Released` הוא State** של ה-Release (עבר Promotion והיה בריא) — נשאר נכון לתמיד.
- **`Live` הוא Role / Pointer יחיד לכל Production target** — "איזה artifact משרת כעת":
```
ProductionLiveAssignment (per target) {     // singleton per target
  target            : production-target
  live_artifact_ref : artifact | rollback_point   // מי משרת כעת
  assigned_from     : release_id
  assigned_at       : timestamp
}
```
- **רק Release/Artifact אחד מחזיק Live per target** בכל רגע.
- ה-Role מוקצה/מוקצה-מחדש **רק ע"י ה-Controller**, כל הקצאה = Decision Event עם Provenance.
- **Rollback מזיז את ה-Live Assignment** ל-Rollback Point — **אינו** מחזיר State טרמינלי אחורה. כך נפתרת הסתירה Rollback↔Terminal.

## 7. מעברים מותרים
```
Created ─► Prepared ─► Built ─► Verified ─► Approved ─► Promoted ─► Released ─► Closed
   │          │         │          │           │           │           │
   └──────────┴─────────┴──────────┴───────────┴───────────┴───────────┴─► Failed/Aborted
                                                            │
                            Released ─► Superseded   (ה-Live Role עבר ל-Release חדש)
                            Released ─► Rolled-Back  (ה-Live Role הוקצה-מחדש ל-Rollback Point)
```
- קדימה ברצף בלבד; מכל state פעיל לפני-שירות → `Failed/Aborted`.
- `Released → Superseded` / `Released → Rolled-Back` — מעברי-state שמלווים הקצאת-Role (לא resurrection).
- מ-טרמינל → פותחים **Release חדש** (לא חזרה לאחור).

## 8. מעברים אסורים
- דילוג שלב · חזרה לאחור של אותו Release · `*→Promoted` ללא Approved+Rollback Point+Single-Target · הקצאת Live לפני `Released` · שני Live לאותו target · מעבר ללא Decision Event (verdict+Controller+Provenance) · יציאה מ-state טרמינל.

## 9. סמכות לכל מעבר (Single Authority)
| מעבר | סמכות מכריעה | סוג |
|---|---|---|
| כל מעבר state / הקצאת Live | **Release Controller** (מוסיף Decision Event) | אוטומטי (Decision Engine) |
| `Verified → Approved` | **Release Owner** (Approval Policy) | **אנושי** |
| Abort / שלילת-אמון | Owner (טריגר) → Controller | אנושי/אוטומטי |
| `Released → Rolled-Back` | Controller (Health-fail) או Owner (דו-משמעי) | אוטומטי/אנושי |

Gates/Providers אינם משנים state — verdicts/facts בלבד. אדם מאשר intent, לא הופך state ישירות.

## 10. אילו Policy-Verdicts נדרשים לכל מעבר
ה-Mechanism דורש verdicts; ה-Policies מחזיקות את הכללים.
| מעבר | Policies נדרשות |
|---|---|
| Created→Prepared | Changes=Merged (fact); **Identity Policy** (Registry=VERIFIED) |
| Prepared→Built | Build verdict (fact: Artifact + Schema Version) |
| Built→Verified | **Verification + Migration + Config + Identity** Policies |
| Verified→Approved | **Approval Policy** (אישור אנושי תקף) |
| Approved→Promoted | **Promotion Policy** (Rollback Point=Captured + Single-Target) |
| Promoted→Released | **Health Policy** (+ commit/artifact/DB תואמים ל-ReleaseIdentity) |
| Released→Closed | **Stability Policy** |
| *→Failed/Aborted | Policy שלילי / Abort / Approval נדחה |
| Released→Rolled-Back | **Rollback Policy** (טריגר + Rollback Point תקף) |
| Released→Superseded | Release אחר קיבל את ה-Live Role |

## 11. Rollback Point Lifecycle (Domain Object)
```
RollbackPoint {
  id, target, release_id_protected
  captured_artifact_ref          // immutable snapshot
  captured_schema_version
  captured_config_snapshot_ref
  restorability {
     code_dimension   : always-restorable
     schema_dimension : { reversible | irreversible }   // קריטי
  }
  status : enum { Captured, Active, Consumed, Invalidated, Retired }
  provenance { captured_at, captured_by(Controller), ... }
}
```
| מצב | מתי | מה |
|---|---|---|
| **Captured** | ב-`Approved→Promoted`, **לפני** הפצה | snapshot של ה-Live הנוכחי (מה לחזור אליו) |
| **Active** | בעוד ה-Release החדש Promoted/Released ובכהונת ה-Live + חלון יציבות | יעד-שחזור תקף |
| **Consumed** | אם Rollback נורה → ה-Point משוחזר (artifact-ו מקבל את Live Role) | — |
| **Invalidated** | אם היעד אינו ניתן-לשחזור (migration בלתי-הפיך / branch נמחק) | Rollback אליו אסור → recovery חלופי |
| **Retired** | לאחר שה-Release החדש `Closed` ויש Rollback Point חדש | היסטוריה / eligible ל-Cleanup |

**Coupling ל-State Machine:**
- **Capture = precondition** ל-`Approved→Promoted` (Invariant).
- **restorability חוסם** את `Released→Rolled-Back`: אי-אפשר rollback ל-`Invalidated`.
- **דגל קריטי — migration בלתי-הפיך:** `schema_dimension` מתעד אם השחזור המלא אפשרי. עיצוב forward-safe (expand→contract) שומר reversibility; אחרת השחזור חלקי/חסום.
- **Cleanup eligibility:** רק `Retired` **וגם** אינו Active-restore-target של ה-Live הנוכחי **וגם** ה-Release טרמינלי. (לעולם לא למחוק Rollback Point של Release פתוח/Live-רלוונטי.)

## 12. ייצוג Rollback
Rollback אינו Release חדש. הוא שילוב בהכרעת Controller:
1. **State transition** על ה-Release הכושל: `Released → Rolled-Back` (טרמינל) + Provenance.
2. **הקצאת Live מחדש** ל-`RollbackPoint` תקף (status→Consumed) → ה-artifact הקודם משרת שוב, **בלי** להחיות state טרמינלי.
*(re-deploy מתוקן אחרי Rollback = Release חדש.)*

## 13. הקשר לרכיבים
- **Release Controller:** מוסיף Decision Events, אוכף invariants, מזיז Live Role. ה-state הוא projection שהוא מנהל.
- **Policies:** מקור החוקים העסקיים; ה-Mechanism צורך מהן Verdicts ואינו מכיל את החוקים. **Gates** = נקודות-אכיפת-Policy.
- **DB Identity Registry:** נקרא ע"י Identity Policy ב-`Created→Prepared`; VERIFIED = תנאי הכרחי לא מספיק.
- **Migration Gate / Verification Gate:** אכיפת Migration/Verification Policies → verdicts ל-`Built→Verified` (קוראים, לא משנים state).
- **Promotion Boundary:** = מעבר `Approved→Promoted` המאושר (Promotion ≠ Merge).
- **Rollback:** §12 — state transition + הקצאת Live + Rollback Point.
- **Audit Trail:** = ה-Event Log; Source of History. ה-state machine = current projection.

## 14. Provenance לכל מעבר
כל מעבר = **Decision Event immutable**: `{event_id, release_id, type, timestamp, from_state, to_state, deciding_authority, policy_verdicts/evidence_refs, approval_ref?, live_assignment_change?, preceding_event_id}`. ה-current state ניתן לשחזור מלא מהשרשרת.

## 15. כשל באמצע Release
- **לפני שירות (Created..Promoted):** verdict שלילי/Abort → `Failed/Aborted`; fail-closed; Production לא נגע; תיקון = Release חדש.
- **אחרי Promote (Released):** Health-fail/drift → `Released→Rolled-Back` + הקצאת Live ל-Rollback Point תקף.
- אין תוצאה חלקית; כל כשל מגיע ל-state טרמינלי עם Provenance מלא.

## 16. Live / Superseded
- **Live:** ברגע `Released` + Health, ה-Controller מקצה את ה-**Live Role** ל-artifact של ה-Release (singleton per target).
- **Superseded:** כש-Release חדש מקבל את ה-Live Role, ה-Release הקודם עובר `Released→Superseded` (state) — רק הסרת Role, לא resurrection. ה-Superseded שומר artifact/Rollback Point (עד Cleanup) ויכול לשמש Rollback Point.

## 17. Invariants
1. **Single Live:** Live Role יחיד לכל Production target.
2. **No skip / no backward edit:** אין דילוג, אין חזרה לאחור; תיקון = Release חדש.
3. **Promotion ≠ Merge:** Production רק דרך `Approved→Promoted` מאושר.
4. **No Production change ללא:** Controller Decision **+** Approval **+** Provenance.
5. **Rollback Point לפני Promote** (Captured), **ותקף** בעת Rollback.
6. **Fail-closed:** verdict שלילי/חוסר → עצירה בטוחה; לעולם לא pass-on-doubt.
7. **Terminal is terminal:** אין יציאה מ-Closed/Superseded/Rolled-Back/Failed. (Live כ-Role מאפשר זאת.)
8. **Single Authority:** רק ה-Controller משנה state ומזיז Live Role.
9. **Identity stable:** ReleaseIdentity לא משתנה; bindings write-once; רק ה-Decision-state נע.
10. **Events authoritative:** State = projection; אין state שאינו נגזר מ-Event Log.
11. **Identity precondition:** אין `Created→Prepared` ללא DB Identity=VERIFIED (necessary, not sufficient).
12. **Provenance חובה:** כל current state ניתן לשחזור מ-Audit Trail.
13. **Report/Warning לפני Blocking:** אכיפת Policies מאומצת בהדרגה דרך `enforcement_level`; ה-Mechanism אינו משתנה.
14. **Mechanism ללא חוקים עסקיים:** ה-State Machine לא מכילה Approval/Health/Rollback/Promotion logic — רק דורשת verdict מה-Policy המתאימה.
15. **Policies בעלות Provenance ובעלים:** כל Policy ניתנת-לגרסה, מתועדת, ובעלת סמכות-שינוי מוגדרת; שינוי Policy אינו נוגע ב-Mechanism.

## 18. Provider-agnostic
States/transitions/authorities/policies/events מנוסחים במונחי Domain בלבד — אין GitHub/Vercel/Neon. Policies מחזירות verdicts מופשטים; Providers=facts דרך ports. החלפת ספק **לא משנה** אף state/מעבר/invariant/policy/event — רק מימוש ה-ports (Execution). (תואם אי-התלות שאומת ב-Canonical Release Model v2 §4.)

---

## Document Status
- **RATIFIED 2026-06-28.** סוגר את שלב הארכיטקטורה של Release State Machine.
- כולל: Event-Sourced (R1) · Intent/Decision/Execution (R2) · Release Identity (R3) · Live-as-Role (R4) · Rollback Point Lifecycle (R5) · Policy vs Mechanism.
- **אישור המסמך הקנוני** ≠ **מימוש**. מעכשיו ברירת המחדל היא **Implementation First**: בנייה שכבה-אחר-שכבה לפי הארכיטקטורה הנעולה; לא ייפתחו מחדש החלטות מאושרות אלא אם יתגלה במהלך המימוש חוסר/סתירה מהותית שלא ניתן היה לראות מראש.
- מצב בעת האישור: Production DB Identity = **UNKNOWN**; `production-NEW` = INFERRED (MEDIUM); B-2 = Ratified/Ready/Not Executed; DB Identity Registry + Migration Gate = מתועדים/טרם-ממומשים.
