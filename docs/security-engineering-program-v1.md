# Dubiz Security Engineering Program (SEP) v1

> **סוג מסמך:** מסגרת-הנדסה (Execution / Operating Framework) לאבטחה.
> **גרסה:** v1 · **תאריך:** 2026-08-11 · **בסיס ראיות:** `origin/main` @ `92e0dae` (7 ביקורות קוד + Master Plan / Gap Matrix / Architecture As-Is).
> **אופי:** הגדרת **יכולות ותהליכים** — לא Design, לא Controls, לא Implementation, לא רשימת-משימות.

## מעמד וכפיפות (Self-Placement)
מסמך זה **כפוף ל-`docs/security-constitution-v1.md` (Security Constitution v1)** ונגזר ממנו. ה-SEP הוא **מנגנון-יישום (execution/operating framework)** — הוא מתרגם את עקרונות החוקה לתהליך-הנדסי חוזר; **אינו מקור-אמת מתחרה** ואינו יוצר governance חדש.

מיקומו בהיררכיית `Constitution §II.11`:
```
Security Constitution  (עליון — עקרונות: "כיצד מחליטים")
   ├── Master Plan            (אסטרטגיה: "מה ומתי" — P1–P8)
   ├── Architecture As-Is / Gap / Audit  (עדות)
   └── Execution layer:
         • SEP  (מנגנון-הנדסה: "כיצד עובדים" — מסמך זה)
         • Wave Plans / Governance  (ביצוע ומעקב פרטני)
```
ה-Master Plan קובע *אילו Phases ומתי*; ה-SEP קובע *כיצד כל עבודת-אבטחה מתבצעת ונבחנת*. Phases של ה-Master Plan **מבוצעים דרך** ה-SEP. בהתנגשות — **החוקה גוברת**, ואחריה ה-Master Plan (אסטרטגיה); ה-SEP מיושר אליהם.

## הערת Technology-Agnosticism
ה-SEP מוגדר **ברמת-היכולת** ולכן דורּ לשנים גם אם הטכנולוגיה/הארכיטקטורה/הספקים יוחלפו. כל אזכור של כלי/מנגנון קונקרטי (למשל שמות בדיקות-CI, מנהלי-חבילות, KMS, worktrees) מסומן **[current example]** ומהווה **דוגמה-ליישום-הנוכחי בלבד** — לא חוק-SEP קבוע. אם הכלי יוחלף, היכולת נשארת; הדוגמה מתעדכנת.

## עוגן-חוקה (Anchoring Rule)
**אין ב-SEP יכולת ללא עיגון חוקתי.** כל יכולת מציינת את סעיף/סעיפי החוקה שממנה היא נגזרת. אף יכולת אינה סותרת עיקרון, מחלישה invariant (§II.4), או מפרה את Decision Hierarchy (§I.5).

---

## מסגרת-על: מ"משימות" ל"יכולת"
ה-SEP הופך אבטחה ליכולת-קבע דרך **לולאה אחת** שכל פעילות בה מייצרת **ראיה** (Proof Model §I.4) ונבחנת מול החוקה:
```
Constitution (§ עליון)
   │  כל פעילות נמדדת מולו + מייצרת ראיה
   ▼
Build-time ─► Run-time ─► Assurance ─► (Learning §0.9 → Evolution §II.10) ─► חזרה
```
**עמוד-השדרה:** ה-**Constitutional Compliance Review (CCR)** — שער חוקתי שכל Design ו-PR עוברים לפני *"האם זה פותר?"*. עקרון-הבקרה בכל תחום: **להעלות כל בקרה בסולם-ההוכחה** (Asserted→Tested→Verified→Structural).

---

# Part A — Core Capabilities (§1–§12)

## §1 Secure SDLC
**יכולת:** שילוב שער-אבטחה בכל צומת במחזור-החיים. **עיגון:** §0.2 Culture · §II.10 · §II.7 #6.
- שלבים: Intake (סיווג-סיכון) → Design (Threat-Model §2 + Design-CCR §3 לפי risk-tier) → Build (PR קטן/הפיך, §0.2) → Review (PR-CCR §3 + tests §4) → Merge (שער-CI חוסם + branch protection §II.7 #6) → Post-Merge Verification → תיעוד ב-Governance.
- **[current example]** worktree isolation, בדיקת-CI חוסמת בשם `release/verify`, branch protection — הם היישום הנוכחי; היכולת = "SDLC מגודר-אבטחה", ללא תלות בכלי מסוים.

## §2 Threat Modeling Framework
**יכולת:** ניתוח כל פיצ'ר לפני פיתוח. **עיגון:** §I.3 Threat Philosophy · §II.8 Boundaries.
- **טריגר:** נדרש רק אם הפיצ'ר חוצה גבול §II.8 (נתוני-דייר / secret / כסף / upload / auth / קלט-חיצוני); אחרת — פטור מתועד.
- **שיטה:** ניתוח לכל גבול §II.8 שנחצה, מול פרסונות T1–T10 (Posture Audit).
- **פלט מובנה:** אילו invariants §II.4 חלים · אילו בקרות נדרשות · **באיזו רמת-הוכחה** (§I.4) · abuse-cases ל-§4.

## §3 Security Review Process — Constitutional Compliance Review (CCR)
**יכולת:** בדיקת כל Design ו-PR מול החוקה. **עיגון:** §I.6 · §II.4 · §II.7 · §II.11.
- שני שערים: Design-CCR (לפני build) ו-PR-CCR (לפני merge).
- Checklist נגזר-חוקה: כל פריט §II.4 (Invariants) + §II.7 (Laws) + §II.8 (Boundaries) → שאלת-בדיקה.
- הכרעת-חומרה לפי Proof Model: בקרה שנטענת אך רק Asserted (§I.4) = **חוסמת** עד הוכחה (In-doubt-deny §II.6 #7).
- ניתוב: **[current example]** CODEOWNERS ממפה משטחים רגישים → CCR מוגבר.
- **סדר-שאלות:** קודם "עומד בחוקה?", ואז "פותר?".

## §4 Security Testing Strategy
**יכולת:** אימות בקרות בבדיקות, וקיבוע כל פער-שנסגר. **עיגון:** §I.4 (Tested) · §0.9 Learning.
- Unit Security (invariant נקודתי) · Integration (tenant-isolation, authz 401/403, fail-closed) · Abuse-Cases (IDOR/enumeration/rate/spoof/active-content, נגזר מ-§2) · **Regression (חובה):** כל פער שנסגר הופך לטסט-קבע (מימוש §0.9).
- מיפוי לסולם: טסט = רמת "Tested"; היעד הוא להחליף Tested ב-Structural (G1) היכן שאפשר.
- **[current example]** קונבנציית `verify:*` — יישום נוכחי; היכולת = "בדיקות-אבטחה שיטתיות + regression-suite".

## §5 Penetration Testing Strategy
**יכולת:** בחינה יריבה פנימית וחיצונית. **עיגון:** §I.5 (סדר-היקף) · §0.6 Humility.
- פנימי (רציף): self-adversarial reviews, IDOR/isolation probing — לפני release רגיש.
- חיצוני (מחזורי): צד-ג' — **שנתי + טריגר-אירוע** (לפני בידוד-מבני, לפני scale של סליקה).
- היקף לפי §I.5: Tenant-Isolation ו-Financial-Integrity תחילה. bug-bounty = עתידי.

## §6 Secrets & Key Management
**יכולת:** מחזור-חיים מלא של סודות. **עיגון:** §II.4 #3/#10 · §II.7 #2/#5 · §II.3 #13.
- יצירה (תקן) · אחסון · Rotation (קצב + re-encryption) · Revocation (בפשרה) · Audit (רישום-גישה). כל בקרת-סוד עם proof-level.
- **[current example]** מפתחות מ-env, נתיב עתידי ל-managed-KMS/envelope — יישום; היכולת = "ניהול-סוד מלא ומאומת".

## §7 Infrastructure Security Program
**יכולת:** baseline מאומת לכל שכבת-תשתית. **עיגון:** §II.5 Trust Model · §II.8.
- Hosting/Compute · Database (הפרדת runtime/DDL; היעד המבני = tenant-context) · Storage (אימות ACL פרטי — H-12/OP1) · CDN (בקרת content-type) · DNS/Domain · Backups (+restore-drill מתועד, RPO/RTO) · Monitoring (בסיס ל-§8).
- כל שכבה **מאומתת, לא מונחת** (§II.5). **[current example]** ספקי-ענן נוכחיים — היכולת ניטרלית להם.

## §8 Operational Security
**יכולת:** הפעלה מאובטחת ותגובה. **עיגון:** §0.9 Learning · §0.8 Fallibility · §II.9.
- Security Logging (append-only, tamper-evident) · Alerting (אנומליות) · Incident Response (runbooks לפי T3/T10/H-9; break-glass מגודר §II.9 #4) · Disaster Recovery (backup/restore, RPO/RTO) · Post-Incident Review → §0.9 → §0.8 → אולי §II.10.

## §9 Supply Chain Security
**יכולת:** אמון-מאומת בשרשרת-האספקה. **עיגון:** §II.3 #7 No-Implicit-Trust · §II.7 #6.
- Dependencies (מדיניות pinning + סקירת-הוספה + SCA; המשך Detection-Only + Manual-Remediation) · Third Parties (הערכה מול §II.5) · Build Integrity (lockfile-enforced, בנייה רפרודוקטיבית, pinning ל-actions) · Verification לפני production.
- **[current example]** Dependabot (Detection-Only), `npm ci`, SHA-pinning — יישום; היכולת = "שרשרת-אספקה מאומתת".

## §10 Continuous Security Assurance
**יכולת:** שמירה על טריוּת-הראיה ואי-שחיקת-הפוסטורה. **עיגון:** §0.7 Continuous-Commitment · §0.8 · §I.4.
- Periodic Re-Audit (ביקורת 7-ממדים מול SHA עדכני) · CCR per-PR (§3) · Periodic Constitution Review (§0.8) · Drift Detection (ירידה בסולם / exception שפג §II.9) · Compliance Reviews (רגולציה — כתוצר-לוואי).
- **Ownership cadence (רמת-תהליך):** ה-cadence המחזורי (Re-Audit / Constitution-Review) מופעל ב**שני טריגרים**: (א) **event-driven** — כל שינוי-מהותי בארכיטקטורה/threat-model/dependency מפעיל בחינה מכוונת; (ב) **staleness-driven** — מדד Freshness (§11) חושף פער בין הביקורת-האחרונה ל-SHA-הנוכחי ומחייב Re-Audit. הבעלות התהליכית היא של **מפעיל ה-SEP** (owner/steward) דרך שער-ה-CCR ומדדי §11 — **זהו תהליך-הפעלה, לא יכולת-Continuity/Succession** (המשכיות-התוכנית שייכת ל-Governance/Evolution §II.10, לא ל-SEP).

## §11 Security Metrics
**יכולת:** מדידה אם הפוסטורה עולה או נשחקת. **עיגון:** §I.4 Proof Model · §II.12.
- **⭐ Proof-Level Distribution (מדד-על):** התפלגות הבקרות על Structural/Verified/Tested/Asserted. שיפור = הסטה-שמאלה; שחיקה = צמיחת Asserted.
- Coverage (% routes tenant-scoped-מבנית · deny-by-default · rate-limited · secrets-rotated) · Gap Burn-down + **Regressions=0** · Freshness (גיל-ביקורת מול SHA) · Flow (MTTD/MTTR) · Constitutional Health (% PRs שעוברים CCR בסבב-ראשון · גיל exceptions §II.9).
- **Aspirational Tracking (ללa governance חדש):** פריטי החוקה המסומנים **⚠️ Aspirational** ו-tags **[E]/[A]/[N]** (§II.12) הם **תת-מבט (view) של Proof-Level Distribution** — כל ⚠️Aspirational הוא בקרה שטרם Structural, ולכן מנוטר כ**burn-down** במסגרת מדד-העל. אין זה מקור-מדידה חדש ואינו משנה את החוקה — הוא **קורא** את סימוני-החוקה ומודד את התקדמותם. הבעלות על **סימון/הסרת** ⚠️Aspirational נשארת של החוקה (§II.10), לא של ה-SEP.

## §12 Long-Term Security Roadmap (קשת-בשלוּת, לא משימות)
**יכולת:** תכנון רב-שנתי של בשלוּת-היכולת. **עיגון:** §II.11.

| אופק | תמה | מעבר-בשלוּת (proof-level) | Phases |
|---|---|---|---|
| שנה 1 — יסוד ופרימטר | השלמת P1 + הקמת תהליכי-SEP | manual→verified | P1 |
| שנה 1–2 — בידוד-מבני וזהות | בידוד-דיירים מבני (C-1) + session/revocation/MFA | ⭐ manual→**structural** בליבה | P3, P2 |
| שנה 2 — Assurance ו-Ops | audit/monitoring/alerting + pen-test חיצוני + IR/DR | verified→continuously-assured | P5 |
| שנה 2–3 — Crypto/Supply/Secrets | KMS/rotation + הקשחת-שרשרת | secrets: env→managed | P6 |
| שנה 3+ — בשלוּת ארגונית | roles (P7) + privacy/DSAR/resilience (P8) + assurance חיצוני מתמשך | continuous external assurance | P7, P8 |

**הקשת:** מ-*manual-enforced + periodically-audited* → *structurally-enforced + continuously-assured*. ההתקדמות נמדדת ב-§11, לא ב"כמה משימות נסגרו".

---

# Part B — Extended Capabilities (G1–G3)

## G1 — Secure-by-Default / Paved-Road Engineering
**יכולת:** בניית רכיבים/מסלולים ש**המצב-הבטוח הוא ברירת-המחדל שלהם**, כך שעקרונות החוקה מתקיימים מעצם-הבנייה ולא מכוח משמעת. **עיגון:** §II.6 #1 (Structural over Manual) · §II.3 #8 (Secure Defaults) · §0.4 #4 · §I.3 #4–#6.
- **Why:** ממיר משמעת-אנושית ("filter שנשכח") ברשת-ביטחון-מבנית; מעלים **מחלקות-פגיעות שלמות** (cross-tenant, secret-to-client) מרחב-האפשרויות.
- **Proof Model:** המנוע שמזיז בקרות ל-**Structural**; כל paved-road = קפיצת proof-level לכל צרכניו.
- **CCR:** מעדיף/דורש paved-road קיים; מימוש-ידני כשקיים מסלול-בטוח נכשל (§II.6 #1).
- **Metrics:** מזין את Proof-Level Distribution (§11) — % צרכנים-דרך-paved-road, % בקרות-Structural.
- **Roadmap:** היכולת המרכזית של שנה 1–2 (P3) — ה*כיצד* של manual→structural.
- **Interfaces:** SDLC §1 (זמין ב-Build) · TM §2 (מחלקת-איום מבוטלת יורדת מהמודל) · Testing §4 (structural מחליף regression) · Infra §7.

## G2 — Privacy & Data Governance Engineering
**יכולת:** התייחסות ל**מידע עצמו** כאובייקט-משמורת בעל מחזור-חיים מנוהל (סיווג, minimization, retention, זכויות-נושא, data-flow-mapping) — כתכונת-קבע, לא כפרויקט-ציות. **עיגון:** §0.1 Custodian · §0.3 Ethics #2/#4 · §II.2 #3 · §I.2 #6.
- **Why:** משמורת כוללת **מה בכלל להחזיק, כמה זמן, לאיזו מטרה** — לא רק "לא-לדלוף". **נגזרת של החוקה, לא של רגולציה** (הרגולציה = תוצר-לוואי).
- **Proof Model:** ממירה טענות-פרטיות מ-Asserted ל-Verified/Structural (data-flow מאומת, retention נאכף, minimization מבנית).
- **CCR:** מוסיף שאלות-משמורת-נתונים ("מינימום? retention? נתיב-מידע חדש ללא בעלות?"); איסוף-יתר נכשל גם אם מאובטח-טכנית.
- **Metrics:** minimization ratio · כיסוי-classification · עמידה-ב-retention · זמן-מענה-לזכויות.
- **Roadmap:** יכולת מ-v1 (סיווג + data-flow), מבשילה ב-P8.
- **Interfaces:** TM §2 (data-flow=קלט) · Infra §7 (retention/storage) · Ops §8 (DSAR/breach-scope) · Metrics §11.

## G3 — Vulnerability Disclosure Capability
**יכולת:** קליטת חולשה חיצונית, סיווגה, והזנתה ללולאת Evidence→Review→Governance→Learning→Evolution. **עיגון:** §0.6 Humility · §0.8 Fallibility · §0.9 Learning · §0.10 Promise.
- **Why:** §0.10 מבטיחה ש"כל חולשה תטופל ביושר" — הבטחה זו מחייבת **נתיב-כניסה**; אחרת דיווח-חיצוני נופל בין הכיסאות.
- **Proof Model:** דיווח מתחיל Asserted → **reproduce** → Verified/Proven לפני טיפול (§I.4). לא מטופל כעובדה עד הוכחה, לא נדחה עד הפרכה.
- **CCR:** תיקון-הנובע-מדיווח עובר CCR ככל שינוי; תיקון-דחוף דרך §II.9 (מתועד).
- **Metrics:** MTTD/MTTR לדיווחים · % שהובילו לשיפור-מבני · דיווחים חוזרים מאותו-שורש = כשל-Learning.
- **Roadmap:** יכולת-קליטה מ-v1; מבשילה לעבר assurance חיצוני / bug-bounty (Wave 4).
- **Interfaces:** Assurance §10 (מקור-ראיה נוסף) · Ops/IR §8 (דיווח-חמור→incident) · Learning §0.9 → Evolution §II.10. מקביל ל-Pentest §5.

---

# כיצד זה הופך ל-DNA
1. **כל שינוי עובר שערי-SEP (§1)** — אבטחה = תנאי-מעבר קבוע, לא פרויקט.
2. **החוקה + Metrics = לולאה מתקנת-עצמה** — CCR חוסם ירידה, §11 חושף שחיקה, Learning→Evolution משפרות.
3. **כל בקרה מוצדקת, הכרחית, מוכחת, בת-תחזוקה** — "וי לסימון" נכשל ב-CCR (Asserted=חסום).
4. **הסיכון יורד שיטתית** — G1 מסיט בקרות-ליבה ל-Structural; Regressions=0 מבטיח אי-נסיגה.

---

# Verified / Unknown / Assumptions
- **✅ Verified:** עיגוני המצב-הקיים (manual isolation, no gateway/headers, rate 10/180, secrets env, Detection-Only supply-chain) — מ-7 ביקורות `92e0dae`.
- **❓ Unknown:** משאבי-פרויקט לתדירות pentest/KMS · דרישות-רגולציה עתידיות · ACL bucket (H-12).
- **⚠️ Assumptions:** מבנה-צוות נוכחי · אין אילוץ-זמן שכופה עיגול-פינות (מנוגד §0.2).

---

*Program Continuity & Succession — סווג כ-Governance/Organizational capability (Constitution §II.10 + פן ארגוני), **לא** כיכולת Security-Engineering של ה-SEP.*

*סוף המסמך — Dubiz Security Engineering Program v1. כפוף ל-Security Constitution v1.*
