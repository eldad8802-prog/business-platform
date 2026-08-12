# Dubiz — Security Master Plan v1

> **סוג מסמך:** אסטרטגי (Living Architecture / Master Roadmap).
> **גרסה:** v1 · **תאריך:** 2026-07-31 · **בסיס ראיות:** `origin/main` @ `f2c78de`.
> **תחזוקה:** מסמך זה **אינו** מתעדכן אחרי כל PR. הוא מתעדכן רק כאשר משתנה **תמונת האבטחה הכוללת** (למשל השלמת Phase גדול), ואז נוצרת גרסה חדשה (v2, v3…). מעקב הביצוע היומיומי חי במסמכי ה-Governance (ר' §1).
>
> **מעמד בהיררכיה (מעודכן לאחר Ratification):** מסמך זה **כפוף ל-`docs/security-constitution-v1.md` (Security Constitution v1)** — מקור-האמת העליון של אבטחת Dubiz — ומיושם דרך **`docs/security-engineering-program-v1.md` (Security Engineering Program v1)**, מסגרת ההנדסה והביצוע הכפופה לחוקה. Master Plan = **השכבה האסטרטגית** ("מה ומתי", P1–P8); ה-SEP קובע *כיצד* כל עבודה מתבצעת, וה-Phases מבוצעים דרכו. בהתנגשות עקרונית — **החוקה גוברת**.

---

## 1. מטרת המסמך והיקפו

**מה המסמך הזה כן:** התמונה האסטרטגית המלאה של אבטחת Dubiz — הארכיטקטורה, משטחי התקיפה, הפערים הידועים, סדרי העדיפויות, ה-Roadmap, התלויות, והיעד שאליו שואפים. זוהי **השכבה האסטרטגית** של אבטחת Dubiz — הכפופה ל-**Security Constitution v1** ומיושמת דרך ה-**Security Engineering Program v1**. *(עודכן: בעבר תואר כ"מסמך-האב שכל עבודת אבטחה נגזרת ממנו"; מאז אושררה החוקה כמקור-האמת העליון, ומסמך זה כפוף לה.)*

**מה המסמך הזה אינו:** אינו מסמך ביצוע. אין בו הוראות מימוש, קטעי קוד, file:line ברמת תיקון, או מעקב סטטוס PR. הפירוט הביצועי — Implemented / Verified / Closed / Evidence / PR / Merge SHA / Production Verification — חי אך ורק במסמכי ה-**Governance**:

- `docs/security-gap-matrix.md` — מקור אמת לפערים ולהחלטות ארכיטקטוניות (D1–D5).
- `docs/security-wave-1-execution-plan.md` — תכנון ביצוע Wave 1.
- `docs/security-w1-01-coupon-surface-implementation-plan.md` וכל מסמכי ה-Waves העתידיים.

**הפרדת אחריות:** Master Plan = אסטרטגיה. Governance = ביצוע. במקרה של אי-התאמה בין המצב בשטח לבין מסמך זה, ה-**קוד** ומסמכי ה-Governance גוברים; מסמך זה מיושר אליהם בגרסה הבאה.

---

## 2. הקשר המערכת (לקורא שאינו מכיר את הפרויקט)

Dubiz היא פלטפורמת SaaS רב-דיירת (multi-tenant) לעסקים קטנים-בינוניים בישראל. כל **עסק (Business)** הוא דייר (tenant); כל **משתמש (User)** שייך לעסק אחד בדיוק (יחס 1:1, ללא מודל חברות רב-משתמש). היכולות המרכזיות: הפקת חשבוniות ומסמכי חיוב (Billing, בכפוף לרגולציית רשות המסים/SHAAM), קליטת מסמכים פיננסיים ו-OCR, CRM ולקוחות, מלאי ורכש מספקים, תשלומים (Tranzila/CardCom), ואינטגרציות חיצוניות (Gmail, WhatsApp, רשות המסים).

**מודל האימות בקצרה:** המשתמש מתחבר ומקבל **bearer token** חתום (HMAC-SHA256, תוקף 30 יום), שנשמר בצד-לקוח ונשלח בכותרת `Authorization: Bearer`. השרת מאמת את החתימה, שולף את המשתמש, ומגזר ממנו את `businessId`. כל בידוד הדיירים מבוסס על סינון שאילתות לפי `businessId` — **אין** שכבת אכיפה מבנית (RLS/middleware) מתחת לכך.

**מונחון קצר:** *tenant/businessId* — גבול הבידוד בין עסקים · *IDOR* — גישה לאובייקט של דייר אחר דרך מזהה · *RLS* — Row-Level Security של Postgres (אכיפת בידוד בשכבת ה-DB) · *AAD* — נתון-אימות-נלווה בהצפנת GCM הקושר ciphertext להקשר (למשל businessId) · *deny-by-default* — כל route נחסם אלא אם הותר במפורש · *DSAR* — בקשת נושא-מידע (ייצוא/מחיקה) לפי רגולציית פרטיות.

---

## 3. תמצית פוסטורה (Posture)

הפוסטורה של Dubiz: **"גבול-זהות חזק, גבול-scoping שביר."** מי-אני (זהות + `businessId` הנגזר בשרת) נאכף היטב ואינו ניתן לזיוף מצד הלקוח. מה-מותר-לי-לתשאל נשען כמעט כולו על משמעת ידנית per-query, ללא שכבת אכיפה מבנית אחת.

חלקים מהמערכת מצוינים ואינם דורשים שינוי (reference-grade): בידוד אחסון (grammar של מפתחות + מדיניות נראוּת), גישה למסמכים/קבצי CRM, אי-שינוי חשבוnות שהונפקו + מספור רציף, "עקרון הסמכות" בתשלומים (webhook לעולם אינו מסדר תשלום ללא אימות), אי-שמירת נתוני כרטיס, קריפטו של OAuth מול רשות המסים, אימות webhook של WhatsApp, וגבול prompt-injection (LLM במצב draft-בלבד + guardrails דטרמיניסטיים; חילוץ מסמכים מבוסס OCR ולא LLM).

**חמישה שורשים מערכתיים** מסבירים את רוב הפערים:

1. **אין Authorization Gateway** — route חדש נולד ציבורי אם נשכח לאמת אותו.
2. **אין בידוד דיירים מבני** — אפס RLS/Prisma-extension; filter שנשכח = דליפה חוצת-דיירים ללא רשת ביטחון.
3. **Credential ב-localStorage + אפס revocation** — token בן 30 יום, ניתן-לגניבה ב-XSS, בלתי-ניתן-לביטול.
4. **אין security headers / CSP** — מגדיל את blast-radius של כל XSS.
5. **אין branch protection ו-`main`→Vercel auto-deploy** — קוד לא-נסקר עלול להגיע לפרודקשן.

---

## 4. מפת ארכיטקטורת האבטחה

```
Client (browser)
  localStorage["token"] — bearer בן 30 יום        ⚠ ניתן ל-exfiltration ב-XSS, ללא revocation
        │ Authorization: Bearer
        ▼
app/api/**/route.ts   — אין middleware.ts          ⚠ אין deny-by-default, אין headers
        │ getCurrentUser → verifyAuthToken (HMAC, timing-safe) → user{ businessId }
        ▼
Handler — סינון ידני `where:{ businessId }`         ⚠ אין RLS / אין $extends כרשת ביטחון
        ├─ Prisma (client חשוף) ───────────────► Neon Postgres (pooled + DIRECT_URL)   ✓ פיצול URL תקין
        ├─ Rate limiter (Upstash) — כיסוי צר       ⚠ מיעוט routes
        ├─ Storage (R2, biz/{businessId}/) ────────  ✓ key-validation + מדיניות נראוּת חזקות
        ├─ Crypto: WhatsApp/Authority/Payments AAD ✓ | Gmail ללא AAD ⚠ | legacy plaintext ⚠
        ├─ Audit: Billing/Payment (hashed) | Platform (ללא hash) | exports לא-מבוקרים ⚠
        └─ LLM (OpenAI, שרת-בלבד) — draft-only + guardrails, ללא tool-calling   ✓ גבול אמין
CI/CD:  main → Vercel auto-deploy | release/verify לא-חוסם | אין branch protection   ⚠
        prod-migrate: env-gated + reviewer + persist-credentials:false               ✓
```

---

## 5. משטחי התקיפה (Attack Surface)

| # | משטח | סטטוס אסטרטגי |
|---|---|---|
| S1 | Endpoints ציבוריים לא-מאומתים (auth, health, coupon-active, OAuth callbacks, webhooks) | חלקי — חלקם מוקשחים (HMAC), חלקם חשופים |
| S2 | API מאומת (\u200F182 routes) — אכיפה per-route, ללא gate מרכזי | שביר |
| S3 | Login / brute-force — הגבלה per-IP בלבד, ללא lockout | חשוף |
| S4 | Credential לקוח — bearer בן 30 יום ב-localStorage, ללא revocation | חשוף |
| S5 | נתונים חוצי-דיירים — scoping ידני; טבלה גלובלית אחת; יצירת עסק-יתום | קריטי |
| S6 | העלאות קבצים — MIME מוצהר-לקוח (ללא magic-byte); SVG→CDN ציבורי | בינוני |
| S7 | Tokens של אינטגרציות at-rest — Gmail חלש מהשאר | מעורב |
| S8 | Webhooks של תשלומים — secret אופציונלי | בינוני |
| S9 | Data egress — exports (SHAAM/accountant) לא-מבוקרים ולא-מוגבלים | גבוה |
| S10 | קלטי LLM — הודעות לקוח ל-prompt (draft-only) | תחום |
| S11 | CI/CD — auto-deploy ל-prod ללא branch protection; secret נגיש לקוד PR | גבוה |
| S12 | Platform / headers — אפס security headers/CSP | גבוה |
| S13 | Admin — role+allowlist (fail-closed) אך ללא MFA וללא revocation | גבוה |
| S14 | לוגים — שגיאת OAuth גולמית (סוד פוטנציאלי); ללא שכבת redaction | בינוני |
| S15 | Secrets — מפתחות env גולמיים, ללא rotation/KMS | בינוני |
| S16 | תלויות — ללא SCA; parsers כבדים לקבצים לא-אמינים | בינוני |

---

## 6. מרשם הפערים (Gap Register)

רמת Master Plan: מהו הפער, חומרתו, ההשפעה העסקית, ובאיזה Phase הוא מטופל. **ה-Evidence המלא והתיקון המפורט חיים במסמכי ה-Governance.** לכל פער מזהה יציב (C/H/M/L) לצורך הצלבה.

> **פערים רגולטוריים (ITA):** פערים הנגזרים מההתחייבויות החתומות מול רשות המסים — כולל מזהים חדשים (H-13, H-14, M-16) ופריטים תהליכיים/ארגוניים — מרוכזים ב-**§13 (Regulatory Commitments — ITA)**, עם מיפוי לכל דרישה, Owner, Priority ו-Phase.

### 🔴 Critical
| ID | פער | השפעה עסקית | Phase |
|---|---|---|---|
| **C-1** | אין בידוד דיירים מבני (אפס RLS/`$extends`/ALS) | filter שנשכח → דליפת נתונים פיננסיים/לקוחות בין עסקים | P3 |
| **C-2** | טבלת learning גלובלית נקראת חוצת-דיירים ע"י כל משתמש מאומת | תוכן מנצח של עסק א' נחשף למתחרים | P1 |
| **C-3** | אין deny-by-default — route חדש ציבורי-במחדל | endpoint לא-מאומת מגיע לפרודקשן משכחה בודדת | P1 |

### 🟠 High
| ID | פער | Phase |
|---|---|---|
| H-1 | Credential בן 30 יום ב-localStorage (XSS→takeover) | P2 |
| H-2 | אין revocation — logout קוסמטי; token תקף עד תפוגה | P2 |
| H-3 | אין security headers / CSP / HSTS / X-Frame | P1 |
| H-4 | Rate limiting בכיסוי צר; AI-gen/billing/coupon לא מוגבלים (cost-abuse/brute-force) | P1 |
| H-5 | אין ולידציית קלט סכמתית על גוף בקשות (mass-assignment) | P4 |
| H-6 | Brute-force: ללא lockout, IP-only, XFF-spoofable | P1 |
| H-7 | Object-level authz = מוסכמה לא-מבנית; דפוסים שבירים; לא נסרק ממצה | P1 (sweep) / P3 |
| H-8 | Exports וכשלי authz אינם מבוקרים | P5 |
| H-9 | Admin ללא MFA; token לא-ניתן-לביטול; bypass תלוי-NODE_ENV | P2 |
| H-10 | אין branch protection; `main`→Vercel auto-deploy; verify לא-חוסם | P1 |
| H-11 | אין alerting על אנומליות (login/403/export spikes) | P5 |
| H-12 | בידוד ACL של bucket פרטי אינו ניתן לאימות מקוד (אימות אופרטיבי) | P1 (verify) |

### 🟡 Medium
| ID | פער | Phase |
|---|---|---|
| M-1 | קריפטו Gmail ללא AAD=businessId (לבד מבין המודולים) | P6 |
| M-2 | נתיב Gmail legacy plaintext עדיין מכובד בקריאה | P6 |
| M-3 | Over-exposure: מפתחות אחסון/hash פנימיים בתגובת list | P1 / P4 |
| M-4 | Webhook תשלומים — secret אופציונלי + השוואה לא-קבועת-זמן | P6 |
| M-5 | אין magic-byte validation; SVG active-content → CDN ציבורי | P1 / P6 |
| M-6 | אין rotation/KMS; מפתחות env גולמיים | P6 |
| M-7 | יצירת עסק-יתום ללא authz | P1 |
| M-8 | אין הפרדת הרשאות פיננסיות (אין roles) | P7 |
| M-9 | Audit tamper: ללא hash-chaining; writes best-effort; מחיקות cascade | P5 |
| M-10 | אין dependency scanning; ספריית hashing כפולה | P1 / P6 |
| M-11 | CI: secret נגיש לקוד PR; actions לא-SHA-pinned; push-to-main אוטומטי | P6 |
| M-12 | Privacy: אין DSAR self-service; retention מעורפל; ללא breach clause/RoPA | P8 |
| M-13 | אין monitoring (APM/metrics/readiness) | P5 |
| M-14 | אין backup/restore/RPO/RTO מתועד | P8 |
| M-15 | לוג שגיאת OAuth גולמית (סוד פוטנציאלי) | P5 |

### 🟢 Low
השוואות לא-קבועות-זמן (Gmail state, WhatsApp verify-token, webhook, POS) · self-redemption של קופון לא-חסום (business-logic) · PII שיווקי (טלפון/כתובת) בפיד הציבורי · debug-stubs שרידיים · legacy local-FS read fallback · ללא lint-ban על raw-SQL לא-בטוח · לוג נתיב-קובץ ב-OCR · sslmode לא-מאומת מקוד · CSV import ללא size-cap.

---

## 7. דירוג מרוכז
- **Critical (3):** C-1 בידוד מבני · C-2 דליפת learning · C-3 deny-by-default
- **High (12):** H-1…H-12
- **Medium (15):** M-1…M-15
- **Low (~10):** ר' §6

---

## 8. Roadmap — Phases אסטרטגיים

> **הבהרת מספור:** Phases אסטרטגיים מסומנים P1–P8 כדי **לא** להתנגש במספור הביצועי של ה-Governance (Wave 1 / W1-0X). Phase אסטרטגי מקבץ פערים לפי סיכון+תלות; פירוק לביצוע (מספרי Wave, DoD מפורט, Evidence) נעשה במסמכי ה-Governance.
>
> **סטטוס קו-בסיס (מיושר ל-Governance):** ה-Wave הביצועי הראשון — **W1-01 Coupon Surface — הושלם (Verified/Closed)**. בנוסף, Distributed Rate Limiting ו-Gmail token-encryption-at-rest מומשו ב-mainline (שארית פתוחה: Gmail AAD, ר' M-1). שאר הפריטים הם התוכנית קדימה.
>
> **⚠️ התחייבות רגולטורית (ITA) — השפעה על Phases:** חלק מ-Phases אלו (במיוחד **P2, P5, P8**) נושאים כעת **חובות רגולטוריות מחייבות ("now-binding" מ-22/07/2026)** מכוח ההתחייבות מול רשות המסים — ר' **§13**. מספר חובות בעדיפות **Immediate** ממופות ל-Phases מאוחרים; **שיקול הרצף-מחדש נדחה במפורש לשלב בחירת משימת-ה-Hardening — כאן הוא מיוצג, לא בוצע.** מסמך זה אינו משנה את סדר ה-P1–P8.

לכל Phase: **מטרה** · **היקף (פערים)** · **תלות** · **תוצאת-יעד** (exit במונחי outcome; ה-DoD הביצועי המפורט חי במסמכי ה-Waves).

**P1 · Perimeter & Guardrails**
מטרה: להוריד את הסיכון הזול-והמיידי ולהניח את שער האכיפה שכל שאר ה-Phases נשענים עליו.
היקף: C-2, C-3, H-3, H-4, H-6, H-7(sweep), H-10, H-12, M-3(part), M-5(part), M-7, M-10(part).
תלות: אין (יסוד).
תוצאת-יעד: כל route מאומת-במחדל או ב-allowlist מפורש; security headers פעילים; `main` מוגן עם בדיקה חוסמת; אין endpoint רגיש ללא הגבלת-קצב; דליפת ה-learning נסגרה.

**P2 · Session & Token Revocation**
מטרה: להפוך credential גנוב לניתן-לביטול, ולהוציאו מהישג-יד של XSS.
היקף: H-1, H-2, H-9.
תלות: P1 (נקודת הזרקה ל-CSRF/headers).
תוצאת-יעד: logout/שינוי-סיסמה/אירוע-דליפה מבטלים token; credential אינו ב-localStorage; admin דורש MFA.

**P3 · Structural Tenant Isolation**
מטרה: להחליף משמעת ידנית ברשת-ביטחון מבנית fail-closed.
היקף: C-1, H-7(מבני).
תלות: P1 (sweep + סגירת C-2 כבר בוצעו).
תוצאת-יעד: RLS fail-closed על טבלאות הליבה — "ללא הקשר-דייר → אפס שורות"; אף route אינו נשען רק על filter ידני.

**P4 · Input Validation & Output Filtering**
מטרה: לחסום mass-assignment/type-confusion ולמנוע דליפת שדות פנימיים.
היקף: H-5, M-3.
תלות: P1 (דפוס השער).
תוצאת-יעד: כל route מוטב מאמת סכמה ודוחה שדות לא-מוכרים; אף מודל DB אינו מוחזר גולמי.

**P5 · Audit, Logging, Monitoring & Alerting**
מטרה: להפוך את המערכת ל-observable ואת ה-audit ל-tamper-evident, ולהאיר תקיפות בזמן-אמת.
היקף: H-8, H-11, M-9, M-13, M-15.
תלות: P1 (hook לכשלי authz); alerting אחרי קיום audit-streams.
תוצאת-יעד: כל export וכל כשל-authz מבוקרים; אין סוד בלוגים; audit-chain עמיד-לשיבוש; alert נורה על אנומליה.

**P6 · Integration/Crypto Consistency, Secrets & Supply-Chain**
מטרה: ליישר את כל מודולי הקריפטו לרמה אחת, ולהקשיח את שרשרת-האספקה וה-CI.
היקף: M-1, M-2, M-4, M-5, M-6, M-10, M-11.
תלות: עצמאי ברובו — יכול לרוץ במקביל ל-P2/P3.
תוצאת-יעד: כל מודולי הקריפטו AAD-bound + fail-closed + constant-time; אפס token plaintext בפרוד; runbook rotation; CI ללא חשיפת-secret וללא push-to-main אוטומטי.

**P7 · Authorization Model (Roles/Capabilities)**
מטרה: הפרדת הרשאות בתוך עסק (owner/staff) וגידור פעולות פיננסיות.
היקף: M-8.
תלות: P2 (זהות/סשן) + P3 (isolation).
תוצאת-יעד: פעולה פיננסית דורשת capability; הפרדת owner/staff נאכפת.

**P8 · Privacy, Regulatory & Resilience**
מטרה: מוכנות רגולטורית (פרטיות/GDPR) ויכולת התאוששות מוכחת.
היקף: M-12, M-14, ורכיבי IR/break-glass.
תלות: P2 (revocation ל-IR).
תוצאת-יעד: DSAR self-service חי; runbook תגובה-לאירוע + break-glass מתועדים; restore-drill מתועד עם RPO/RTO.

### מפת תלויות
```
P1 ─┬─► P2 ─┬─► P7
    ├─► P3 ─┘
    ├─► P4
    └─► P5
P6  (עצמאי — מקביל)
P2 ─► P8
```

---

## 9. יעד-על (Target End-State)

המערכת שאליה שואפים: **בידוד דיירים מבני fail-closed** (RLS + tenant-context) מתחת ל-**Authorization Gateway** deny-by-default; **credential קצר-מועד ב-httpOnly cookie** עם revocation מיידי ו-MFA לפעולות רגישות; **ולידציית קלט סכמתית ו-DTO פלט** בכל route; **קריפטו אחיד** (AAD + fail-closed + rotation/KMS) לכל האינטגרציות; **audit עמיד-לשיבוש** עם alerting על אנומליות; **CI/CD מוגן** (branch protection, ללא חשיפת-secret); ו-**מוכנות רגולטורית** (DSAR self-service, IR runbook, backup מוכח). בכל שכבה — הגנה-לעומק, כך שכשל בשכבה אחת אינו הופך לפריצה.

---

## 10. Quick Wins (ללא שינוי ארכיטקטוני)
פערים הניתנים לסגירה בעלות נמוכה, מרוכזים ב-P1/P6 (רמת מזהה; הפירוק לביצוע במסמכי ה-Waves): C-2 · C-3(שער בסיסי) · H-3 · H-4 · H-6 · H-10 · H-12 · M-3 · M-5(SVG) · M-7 · M-10 · M-15 · והשוואות constant-time (Low).

## 11. שינויים ארכיטקטוניים גדולים (עתיד)
1. Prisma `$extends` + ALS + Postgres RLS — בידוד דיירים מבני (C-1). *הגדול והקריטי ביותר.*
2. הגירת credential מ-localStorage ל-httpOnly cookie + refresh + CSRF (H-1).
3. תשתית revocation לסשן/token (H-2).
4. Authorization Gateway מרכזי — `middleware.ts` deny-by-default (C-3).
5. מודל הרשאות roles/capabilities — עסקים רב-משתמש (M-8).
6. Secrets KMS/envelope + rotation (M-6).
7. Structured logging + APM + alerting (M-13/H-11).
8. אכיפת audit append-only ב-DB + hash-chaining (M-9).
9. DSAR self-service — ייצוא/מחיקה (M-12).

---

## 12. מדיניות גרסאות ותחזוקה
- מסמך זה מתוקן ל-**v(n+1)** רק בשינוי מהותי בתמונה הכוללת (בדרך-כלל השלמת Phase, שינוי ארכיטקטוני מהותי, או ביקורת-אבטחה חדשה).
- תיקוני PR נקודתיים, מעברי סטטוס (Implemented/Verified/Closed) ו-Evidence **אינם** נכנסים לכאן — מקומם ב-Governance.
- כל גרסה חדשה מציינת את בסיס-הראיות (SHA) שממנו נגזרה.

---

## 13. Regulatory Commitments — ITA (מחייב)

> **הוספה 2026-08-13 — Representation-alignment בלבד.** סעיף זה **מייצג** את ההתחייבויות החתומות מול רשות המסים במסמכי ה-Governance; הוא **אינו** משנה עקרונות (Constitution), capabilities (SEP), או את סדר ה-Roadmap (§8). מקור-האמת למיפוי-הדרישות המלא (VERIFIED/PARTIAL/GAP/UNKNOWN) הוא דוח ה-Compliance-Mapping; כאן — הייצוג, ה-Owner, ה-Priority וה-Phase.

**מסמכי-המקור (חתומים):**
- נספח אבטחת מידע — הצהרה (חתום 28/07/2025).
- כתב התחייבות — חיבור בית תוכנה לשע"ם (חתום 24/06/2026).

**עובדות-רקע [VERIFIED]:**
- תעודת-רישום תוכנה **270901**, בתוקף **22/07/2026–31/07/2028** → Dubiz פועלת מול שע"ם **מ-22/07/2026**; החובות ה-threshold-independent **"now-binding"** מתאריך זה.
- **תיקון:** דדלייני ה-PT הדתומים בנספח (31/12/2025 · ספט' 2025) חלים על גופים "הפועלים כבר היום" (נכון ל-2025); Dubiz **לא** פעלה מול שע"ם באותן תאריכים → **אין הפרת-דדליין-שחלף**. מועד-PT-ראשון תלוי תחולת >10/>100 לקוחות — **UNKNOWN** (דורש ספירת-prod).

**Owner:** כל הפריטים — **@eldad8802-prog** (המתחזק היחיד, לפי `.github/CODEOWNERS`; מוכן להעברה ל-Security-Owner ייעודי).

**מזהי-פער חדשים (רגולטוריים):** `H-13` (חיוב 2FA ללקוחות) · `H-14` (הודעה-מיידית-לרשות על אירוע) · `M-16` (לוגי-אימות מוצפנים, retention 12 חודש) · פריטים תהליכיים/ארגוניים (IR annual-review · PT regulatory-cadence · סודיות-עובדים).

**מיפוי ההתחייבויות (Representation · Traceability · Priority · Phase):**

| ITA-ID | דרישה | מקור חתום | Coverage היום | Gap-ID | Priority | Phase |
|---|---|---|---|---|---|---|
| ITA-1 | סודיות + בידוד-דיירים | נספח §4–8; כתב §5(1) | PARTIAL | C-1 | High | P3 |
| ITA-2 | **חיוב 2FA ללקוחות** | נספח §17 | GAP | **H-13** (חדש) | **Immediate** | P2 |
| ITA-3 | הצפנת נתוני-אימות at-rest | נספח §17 | PARTIAL (טוקני-רשות VERIFIED; session GAP) | H-1, M-6 | High | P2/P6 |
| ITA-4 | תיעוד אירועי-אבטחה + רישום-אוטומטי | נספח §9 | GAP | H-8, M-9 | **Immediate** | P5 |
| ITA-5 | **לוגי-אימות מוצפנים 12 חודש** | נספח §18 | GAP | **M-16** (חדש) | **Immediate** | P5 |
| ITA-6 | ניטור/התרעה בזמן-אמת (attack/phishing) | נספח §19; כתב §7(5) | GAP | H-11, M-13 | **Immediate** | P5 |
| ITA-7 | נהלי-IR + דיון-שנתי (תק' 11ג) | נספח §10 | GAP | Incident-Response (+annual-review, חדש-תהליכי) | **Immediate** | P5/P8 |
| ITA-8 | **הודעה-מיידית-לרשות על אירוע/שימוש-לרעה** | נספח §11; כתב §5(8) | GAP | **H-14** (חדש) | **Immediate** | P5 (unphased→משויך) |
| ITA-9 | PT cadence + תיקון High/Critical 30 יום + דיווח | נספח §12–16 | GAP (threshold-dependent, **UNKNOWN**; לא-overdue) | PT-regulatory (SEP §5; חדש-תהליכי) | High | P4 |
| ITA-10 | בדיקות-אבטחה לפני-שחרור | כתב §7(4) | PARTIAL | API-Security | High | P1 |
| ITA-11 | backup/restore + הגנה | כתב §11(4) | UNKNOWN/GAP | M-14 | **Immediate** | P8 |
| ITA-12 | ציות חוק-פרטיות/תקנות | נספח (הדין) | PARTIAL/UNKNOWN | M-12 | High | P8 |
| ITA-13 | Need-to-Know authorization | נספח §2,6 | PARTIAL | H-7, M-8 | High | P3/P7 |
| ITA-14 | OAuth2 + ניהול-TOKENS | כתב §7(1),§6 | **VERIFIED (מקוים)** | — | Normal | מומש |
| ITA-15 | סודיות-עובדים / access-governance | נספח §1–3 | UNKNOWN (ארגוני) | org (חדש-ארגוני, non-code) | Normal | ארגוני (לא-Phase) |

**הערת-רצף:** חובות ב-Priority **Immediate** (ITA-2/4/5/6/7/8/11) ממופות כרגע ל-Phases מאוחרים (P2/P5/P8). **המשמעות מיוצגת כאן; הכרעת הרצף-מחדש שמורה לשלב בחירת משימת-ה-Hardening** (Gate B), ואינה מבוצעת במסמך זה.

---

### נספח — בסיס ראיות
נגזר מ-8 ביקורות קוד מקבילות (Identity & Access · Tenant Isolation & DB · API/Input-Output · Integrations/OAuth/Crypto · Files/Storage/Documents · Domain (Billing/CRM/Inventory/AI) · Observability/Ops · Supply-Chain/Platform/Privacy) על `origin/main` @ `f2c78de`, 2026-07-31. סתירות עם המצב בשטח מיושרות ב-Governance ובגרסה הבאה של מסמך זה.
