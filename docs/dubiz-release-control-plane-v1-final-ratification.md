# Release Control Plane v1 — Final Ratification

**Status:** RATIFIED · **Version:** v1 · **Ratified:** 2026-06-29
**Classification:** Control-Layer Domain Object — Decision Layer · **Provider:** agnostic
**Type:** מסמך סיום רשמי (Project Closure & Ratification) — לא דוח Incident.

> מסמך זה סוגר רשמית את פרויקט **Release Control Plane v1** ומגדיר את גבולותיו.
> הוא קובע מה הושלם, אילו החלטות קנוניות ננעלו, מה בתוך ה-Scope של v1 ומה מחוצה לו,
> ומסמן את נקודת היציאה הרשמית לחזרה לפיתוח Dubiz מתוך נקודת-ייחוס אחת וברורה.

---

## 1. המטרה המקורית

הרכיבים (Event Log, Registry, Policy Engine, Controller, Gates) מעולם לא היו יעדים בפני עצמם — הם **אמצעים**. המטרה האמיתית הייתה לבנות **Release Control Plane** ש:

- מחזיר שליטה על תהליך ה-Release.
- הופך **Release ל-Domain Object מבוסס-ראיות** (Event-Sourced), ולא pipeline run חסר-זיכרון.
- מספק **Source of Truth יחיד** למצב ולהיסטוריה של Release.
- מאפשר לחזור לפתח את Dubiz **בביטחון**, מתוך מודל החלטה אחד וברור.

---

## 2. הבעיות שנפתרו

| הבעיה | מה היה | הפתרון ב-v1 |
|---|---|---|
| **checks חסרי-זיכרון** | "כל ה-checks ירוקים" לא מנע דילוג שלבים (SF-2: Promotion לפני Approval) | State Machine שקובעת רצף חוקי, מעברים מותרים/אסורים, וסמכות לכל מעבר |
| **היעדר סמכות יחידה** | לא היה ברור מי מוסמך לשנות state / להזיז Live | **Single Authority**: רק ה-Controller משנה state ומזיז Live Role |
| **זהות-DB עמומה** | לא היה Source of Truth לזהות ה-DB הנוכחית | **DB Identity Registry** (UNKNOWN/INFERRED/VERIFIED/SUSPECT; VERIFIED = Necessary-but-not-Sufficient) + B-2 Recovery Runbook |
| **CI שמסתיר אמת / קורס** | ה-workflow קרס על SyntaxError, ובהמשך ערבב blockers עם report-only | **release/verify** כ-Evidence Producer: Two-Tier (Blockers={validate,build} מול Report-only={lint}), מקור-אמת `.outcome`, non-blocking |
| **Release לא-מנוהל** | Release לא היה אובייקט עם מחזור-חיים, provenance, או rollback מוגדר | Release = Domain Object: Event-Sourced, Release Identity יציבה, Projection, Rollback Point Lifecycle, Provenance לכל מעבר |

---

## 3. השכבות שנבנו (רובד ה-Decision)

כל הקוד תחת `ops/release/`, dependency-free, עם `node:test`:

| שכבה | נתיב | תפקיד |
|---|---|---|
| **Event Log** | `ops/release/event-log/` (`event-log`, `event-schema`, `sanitize`) | Append-only, tamper-evident — **Source of Truth & History** |
| **State Projection** | `ops/release/event-log/state-projection.mjs` | Current State = fold של ה-Event Log (Projection בלבד) |
| **Release Identity** | `ops/release/event-log/release-identity.mjs` | אובייקט יציב (immutable-from-birth + write-once bindings) |
| **DB Identity Registry** | `ops/release/db-identity/` (`db-identity-registry`, `db-identity-status`) | Source of Truth לזהות ה-DB; Current State ≠ History |
| **Policy Engine** | `ops/release/policy/` (`policy-engine`, `verdict`, `evaluation-result`, `policy-registry`, `policies/identity-policy`) | Policies → `Verdict { pass\|fail, reason, evidence_refs, enforcement_level }`; `EvaluationResult` (evaluated/not-implemented/unknown) |
| **Release Controller** | `ops/release/controller/` (`release-controller`, `decision`, `transition-policies`) | **Decision Authority** — Single Authority; מנפיק Decision Events בלבד |
| **Gates** | `ops/release/gates/` (`migration-gate`, `gate-result`) | Enforcement Boundary טהור; `allowed`/`blocked` לפי ה-Decision בלבד |
| **B-2 Recovery** | `ops/release/scripts/` (`host-probe`, `fetch-neon-branches`, `fetch-neon-endpoints`, `detect-targets`, `append-event`, `build-config-registry`) | Host-correlation לאימות זהות-DB, מחוץ למסלול ה-Release הרגיל |
| **Config / Infra Registry** | `ops/release/config-registry.json`/`.md`, `infra-registry.json`, `single-target-report.md` | רישום קונפיג/תשתית כעובדות |
| **Evidence-Producer CI** | `.github/workflows/release-ci-verify.yml` | בדיקות read-only (validate/lint/build) + commit-status + Job Summary; non-blocking |

---

## 4. ההחלטות הקנוניות שננעלו

שלושה מסמכים **RATIFIED**:
- `docs/dubiz-release-state-machine-design-v1.md`
- `docs/dubiz-db-identity-registry-design-v1.md`
- `docs/dubiz-b2-production-db-host-verification-runbook-v1.md`

ה-Invariants הנעולים:
1. **Decision ≠ Execution ≠ Intent** — שלושה רבדים מופרדים; ה-State Machine מנהלת את רובד ה-Decision בלבד.
2. **Single Authority** — רק ה-Controller משנה state ומזיז Live Role.
3. **Event Log = Source of Truth & History; State = Projection** (fold).
4. **Report → Warning → Blocking** — אכיפת Policies הדרגתית דרך `enforcement_level`, **בלי** שינוי ב-Mechanism.
5. **Provider-agnostic** — States/transitions/policies/events במונחי Domain בלבד; Providers = facts דרך ports.
6. **VERIFIED = Necessary-but-not-Sufficient** — אימות חיובי אינו ערובה מספקת.
7. **Provenance לכל מעבר** — כל Decision חתום על evidence_refs.
8. **Rollback Point Lifecycle** כ-Domain Object.
9. **Policy vs Mechanism** — Mechanism מנהל רצף/חוקיות; Policy מגדירה האם מעבר מותר (כ-Verdict); Gate אוכף.

---

## 5. מה נמצא בתוך Scope של v1

**רובד ה-Decision המלא**, כפי שהוגדר במסמך הקנוני (Release State Machine §1):

- מודל ה-Release כ-Domain Object: Intent / Decision / Execution מופרדים.
- Event Log כ-Source of Truth, ו-State כ-Projection.
- Release Identity, Policy Engine (Verdict + EvaluationResult), Controller (Single Authority), Gates (Migration Gate).
- DB Identity Registry + B-2 Recovery Runbook.
- Invariants, Provenance, Rollback Point Lifecycle, Provider-agnosticism.
- Evidence-Producer CI (`release/verify`) — Two-Tier, non-blocking.

**כל יכולות רובד ה-Decision שתוכננו — מומשו, נבדקו, ואושררו.** אין חוסר ארכיטקטוני מהותי במודל זה.

---

## 6. מה נשאר מחוץ ל-Scope של v1

הפריטים הבאים **אינם** חלק מ-Release Control Plane v1, ואינם חוסמים את השלמתו. הם מתועדים כאן כגבול, **לא כ-Roadmap** ו**ללא מספר-גרסה**.

### 6a. Out of Scope for Release Control Plane v1 — Future Execution Integration
חיבור חי של המודל לרובד ה-Execution (Ports/Adapters), שכבה נפרדת מפורשות במסמך הקנוני (§1, §18):
- הזרמה אוטומטית של עובדות Execution (deployment/build/Neon) **אל** ה-Event Log.
- אכיפה פעילה (warn/block) של Gates על deployments אמיתיים.
- הפיכת ה-Event Log ל-Source of Truth **התפעולי** של releases חיים.

> **ראיה שמגדירה את הגבול:** אירוע ה-Production deploy החסר של `f90162a` (PR #39) הדגים ש-deployment אמיתי — וגם deployment שהוחמץ — מתרחשים כיום **מחוץ** ל-Control Plane (לא נרשמו ב-Event Log, לא עברו Gate). זה מאשש שרובד ה-Execution הוא העבודה הבאה כשתאושר, **לא** חוסר ב-מודל v1.

### 6b. Execution Layer Backlog (תפעול / תחזוקה / QA)
- RCA של ה-trigger שהוחמץ (לוגי GitHub-App / Vercel).
- `business-platform-btrl` — parity ל-Production deploy של `f90162a`.
- אימות UX מלא של C1 ב-Production (auth-gated).
- Cleanup: stashes, branches שמוזגו-ב-squash, `eval/`, `prod_delta.sql`, `tmp_qa/`, שינוי `.gitignore` הלא-מחויב.
- נתוני בדיקה ב-DEV DB (`c1-smoke-*@qa.local` + פריטים) וסקריפטים זמניים.

---

## 7. נקודת היציאה הרשמית

**Release Control Plane v1 (רובד ה-Decision) — Completed & Ratified.**

המודל הארכיטקטוני הושלם, אושרר, ומספק נקודת-ייחוס אחת וברורה: Release הוא Domain Object מבוסס-ראיות, עם Source of Truth יחיד (Event Log), Single Authority, ואכיפה הדרגתית מוגדרת. **זוהי נקודת היציאה הרשמית לחזרה לפיתוח Dubiz.**

אימוץ רובד ה-Execution (§6a) ופריטי ה-Backlog (§6b) ייעשו כעבודה נפרדת ומאושרת בפני עצמה, בהתאם לעקרון Report→Warning→Blocking — אך אינם תנאי להשלמת v1 או לחזרה לפיתוח.

---

**Document Status:** RATIFIED · 2026-06-29 · סוגר רשמית את פרויקט Release Control Plane v1.
