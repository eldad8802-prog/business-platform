# Dubiz — דף הבית הציבורי: Visual Design Specification v1

> **סוג המסמך:** שפה ויזואלית מלאה ומוכנה ליישום. **לא** קוד, לא components, לא מימוש. סקיצות ASCII = סכמטיות בלבד.
> **ממשיך את:** מיצוב + מסר + `docs/dubiz-homepage-structural-wireframe-v1.md` (מאושרים; Verdict A — READY FOR VISUAL DESIGN).
> **בסיס טכני (נקרא firsthand):** `lib/design/tokens.ts` · `components/corporate/marketing-tokens.ts` · `components/ui/primary-cta.tsx` · `.dz-btn-primary` + Heebo ב-`app/globals.css` · `app/(corporate)/*`.
> **תאריך:** 2026-08-16.
> **עיקרון-על:** לא לעצב "אתר SaaS יפה" — לעצב את **המזכירה של העסק**. תחושה: מסודרת · רגועה · מקצועית · אנושית · ישראלית · בשליטה. **לא:** AI-futuristic · startup-neon · enterprise-dashboard · generic-fintech · feature-marketplace.

---

## 1. Design-System Audit — REUSE / EXTEND / NEW

**מקור אמת יחיד:** `lib/design/tokens.ts` → `TOKEN`. **הזהות הרשמית = DS v1 warm** (`TOKEN.dsv1` / `TOKEN.warm`): cream/teal, Heebo, משקלים ≤600. הסט הקריר (`brand`/`action`/`secretary` navy) = **לגסי**.

| רכיב | קיים? | סיווג | הערה |
|---|---|---|---|
| **Heebo** (`--font-heebo`, inherited app-wide) | ✅ | **REUSE** | טיפוגרפיה רשמית; משקלים 300–600 בלבד (700 = synthetic-bold, אסור) |
| **DS v1 warm tokens** (canvas `#FEF8F2` · card `#FDF4EB` · line `#E9DDD0` · ink `#2D2B28` · muted `#777067` · accent teal `#246966` · gradient · `warm.status`) | ✅ | **REUSE** | כל הצבעים, הרדיוסים והצללים כבר מוגדרים — אין להמציא ערכים |
| **`.dz-btn-primary`** (teal gradient · cream text · r14 · w600 · h52 · teal-glow · crisp focus-ring) | ✅ | **REUSE** | ה-Primary CTA ("התחילו עכשיו") — כמו-שהוא |
| **`PrimaryCta`** component | ✅ | **REUSE** | הנקודה היחידה לבניית primary ציבורי |
| **CorporateContainer / Header / Footer / Nav** | ✅ | **REUSE** (בכפוף ל-re-skin חם דרך tokens) | מבנה קיים |
| **מסכי `/landing/*`** (8 מסכי מוצר אמיתיים) | ✅ | **REUSE** | לגלריית §6 — **רק תיקון קופי (N)** |
| **radius scale** (dsv1: field 12 · button 14 · card 16 · dialog 20 · sheet 24 · pill 999) | ✅ | **REUSE** | |
| **spacing 4pt** · **shadow (warm)** scales | ✅ | **REUSE** | |
| **`marketingVars` (`--mkt-*`)** — היום ממופה ל-**navy הקריר** | ✅ אבל לא-תואם | **EXTEND** | **הממצא המרכזי** — ראו למטה |
| Secondary/ghost CTA ("ראו איך זה עובד") | ⚠️ חלקי | **EXTEND** | וריאנט ghost/link חם קטן |
| **4 Visual Primitives** (Attention/Before→Organized/Owner-Decision/Business-State) | ❌ כ-primitive | **NEW (composition)** | קומפוזיציות homepage מתוך tokens קיימים — **לא** tokens חדשים |
| 2 אילוסטרציות מושגיות (§2 pain · §8 memory) | ❌ | **NEW (asset)** | להעדיף פתרון icon-based פשוט (§8 סיכון-effort) |

### הממצא המרכזי (חובה להכרעה)
**המימוש הציבורי הקיים מפוצל-מותג:** `.dz-btn-primary` = **DS v1 warm teal**, אבל `marketingVars` (גוף כל האתר הציבורי — כותרות, pills, links, canvas) עדיין ממופה ל-**navy הקריר הלגסי** (`--mkt-cta`=navy gradient · `--mkt-link`=navy `#2E527F` · `--mkt-soft`=`#EEF3F9` · `--mkt-page`=`#F5F6F8`). כלומר הדף היום = **גוף קריר + כפתור חם**. התזה החמה ("מזכירה רגועה") דורשת **דף חם-עקבי**. **EXTEND:** למפות מחדש את `--mkt-*` ל-DS v1 warm (canvas cream · link teal-mid · soft warm · ink `#2D2B28` · border `#E9DDD0`) — קובץ אחד, מצביע ל-tokens קיימים, **לא** DS שני. ⚠️ משפיע על **כל** דפי ה-corporate (about/contact/privacy/terms) — ראו **Owner Decisions**.

**ברירת מחדל: REUSE. אין DS שני לדף הבית.**

---

## 2. Visual Thesis

> **"מישהו כבר סידר לך את השולחן לפני שנכנסת."**

הדף מתרגם: *בעל העסק היה המזכירה של עצמו → Dubiz מרכזת את העבודה → הוא נשאר עם ההחלטות.*

| ממד | הכרעה | בכוונה **לא** |
|---|---|---|
| **Visual personality** | שולחן-עבודה של מזכירה מסודרת: cream חמים, teal רגוע, סדר | command-center · dashboard · neon |
| **Geometry** | פינות רכות (r12–16), קלף-על-cream, קווים דקים חמים | חדות טכנית · hex/grid futuristic |
| **Whitespace** | נדיב — נשימה = "רגוע ובשליטה" | צפוף · feature-dense |
| **Information density** | נמוכה בקצוות, בינונית-גבוהה רק ב-Breadth | אחיד וצפוף |
| **Surface treatment** | cream canvas + קלף לבנבן-חם מרומם מעט; עומק מקווים+צל רך (לא כבד) | glassmorphism · gradients דקורטיביים |
| **Depth** | שכבה אחת עדינה (card מעל canvas); צל חום-רך | דרמטי · floating · parallax כבד |
| **Iconography** | קווי, עדין, אחיד; אייקון מוביל מימין (RTL) | 3D · glossy · emoji-salad |
| **Imagery** | מסכי-מוצר אמיתיים (מובייל) + 2 אילוסטרציות מושגיות מינימליות | stock "בעל עסק מחייך" · robot avatar |
| **Product representation** | Business-State surfaces סטטיות ומייצגות | live dashboard · personalized |
| **Motion** | reveal עדין, optional, reduced-motion-safe | "AI thinking" · auto-moving · notification-pop |

**מבחן הכשל:** מוחקים לוגו → עדיין מרגיש כמו "מישהו סידר לי את העסק", לא "עוד SaaS עם AI".

---

## 3. Desktop Visual Direction

- **Canvas:** dsv1 cream `#FEF8F2` לכל הדף (רצף חם אחד; לא לסירוגין לבן/אפור קריר).
- **Rhythm של רקע:** רוב הסקשנים על ה-canvas; **קלף** (`#FDF4EB` + line + shadowCard) עוטף רק את ה-**product-surfaces** ואת כרטיסי-ה-Attention — כך ה"מסודר" בולט מול הרקע הרגוע.
- **Split convention (RTL):** טקסט ימין / ויזואל שמאל, קבוע.
- **מדדי רוחב:** container קיים (CorporateContainer); Hero רחב, שאר הסקשנים max-width קריא (~65–72ch לטקסט).
- **הפרדת סקשנים:** מרווח אנכי נדיב (space 4xl בין סקשנים) + לעיתים קו חם דק; **לא** רקעים מתחלפים צועקים.

## 4. Mobile Visual Direction (RTL-first)

- אותו canvas חם; קלפים מלא-רוחב עם gutter קטן.
- Primary CTA **מלא-רוחב** (`dz-btn-primary--block`), thumb-reach תחתון.
- Breadth = **סקרול אופקי** (scroll-snap), קלף-מסך ~78vw, מתחיל מימין.
- Trust ארוך → אקורדיון חם.
- טיפוגרפיה יורדת מדרגה (ראו §6); H1 ≤ 3 שורות.
- אין horizontal-overflow לא-מכוון בשום מקום אחר.

---

## 5. Hero Specification

```
DESKTOP (RTL):  [טקסט ימין]                    [ויזואל שמאל]
┌────────────────────────────────┬───────────────────────────────┐
│ ● 270901 · מוכר ברשות המסים    │  "מה דורש אותך היום"          │
│                                │  ┌─ card (cream #FDF4EB) ─────┐│
│ H1 (Heebo 600, ~40–48px):      │  │ ◔ לקוח ממתין · 3 ימים      ││
│ Dubiz מנהלת לך את היום־יום     │  │   [ טיוטה מוכנה ]  (teal)   ││
│ של העסק — ואתה נשאר עם         │  ├────────────────────────────┤│
│ ההחלטות                        │  │ ₪ חשבונית #1042 · פתוחה    ││
│                                │  │   ₪3,200 · [שליחת קישור]   ││
│ support (400, 16–18px, muted): │  ├────────────────────────────┤│
│ עובדת על מה שכבר יש לך…        │  │ ▢ מסמך נקלט · ספק+סכום זוהו││
│                                │  │   [ אישור ]                ││
│ [ התחילו עכשיו ] ראו איך זה   │  └────────────────────────────┘│
└────────────────────────────────┴───────────────────────────────┘
```

- **Proportions:** desktop ~55/45 (טקסט/ויזואל). כרטיס ~ 380–440px רוחב, 3 items. Mobile: טקסט מלא → כרטיס מתחת, 2 items גלויים.
- **Anatomy של Attention Item:** `[icon/status · מצב] → [שורת-משנה: למה חשוב, ₪/זמן] → [action chip]`. גובה item ~64–76px, מופרד בקו חם דק.
- **Typography:** H1 Heebo **600** (semibold, **לא** 700); support 400; item-title 500; sub 400 muted; action-chip 500.
- **Icon/status treatment:** אייקון קווי עדין + נקודת-סטטוס **warm** (teal=מוכן/סגור · brown/clay=דורש-טיפול · neutral=ממתין) — **לא** אדום, **לא** notification-dot.
- **Action treatment:** chip משני חם (teal-outline/soft), לא כפתור primary מלא (אחד primary בלבד ב-Hero = "התחילו עכשיו").
- **Whitespace:** נדיב סביב הכרטיס — "שולחן מסודר", לא dashboard.
- **Static/representative:** אין live/personalized. **אין clock/countdown/push-badge** — שום ויזואל שיוצר scheduler claim. הפרימיטיב נשמר: **מצב → למה חשוב → החלטה שלך**.

---

## 6. Typography System (Heebo, תקרת משקל 600)

| תפקיד | גודל (desktop→mobile) | משקל | line-height | הערות |
|---|---|---|---|---|
| Hero H1 | ~44→30px | **600** | 1.15 | ≤2 שורות desktop / ≤3 mobile; לא 700 |
| H2 (סקשן) | ~28→22px | 600 | 1.2 | אחד לכל סקשן |
| H3 (פריט) | ~18→16px | 500 | 1.3 | כותרות item/state |
| Support/lead | ~18→16px | 400 | 1.6 | muted; ≤65ch |
| Body | 15–16→14px | 400 | 1.6 | |
| Labels/status | 12px | 500 | 1.2 | tabular-nums לכסף |
| CTA | 14px | 600 | 1.15 | תואם `.dz-btn-primary` |
| Trust/legal micro | 11–12px | 400 | 1.4 | tertiary muted |

**כללים:** תקרת משקל **600** — הדגשה ע"י גודל/צבע/רווח, לא 700 (Heebo synthetic-bold = התנגשות, memory). **tabular-nums** לכל ₪/מספר. **לא** לבחור font חדש. line-length טקסט ≤65–72ch.

---

## 7. Color-Role System (DS v1 warm — תפקידים, לא palette)

| תפקיד | Token | ערך | שימוש |
|---|---|---|---|
| **Calm background** | `dsv1.canvas` | `#FEF8F2` | canvas כל הדף |
| **Product surface / card** | `dsv1.card` / `line` | `#FDF4EB` / `#E9DDD0` | קלפים, Attention, product-surfaces |
| **Primary action** | `dsv1.gradient` | teal `#246966→#3D9C9A` | `.dz-btn-primary` בלבד |
| **Ink / text** | `dsv1.ink` / `muted` / `tertiary` | `#2D2B28` / `#777067` / `#A79C8D` | כותרות/גוף/מטא |
| **Attention · "דורש טיפול"** | `warm.status.late/partial` | clay `#B85C3F` / brown `#B88755` (bg-soft) | **חום/קליי — לא אדום** |
| **Positive · סגור/שולם** | `warm.status.verified` | teal `#246966` (bg-soft) | שולם, אומת, סגור |
| **Open · ממתין** | `warm.status.waiting` | neutral `#777067` / `#F6ECDD` | פתוח, ממתין |
| **Trust** | teal accent + ink | `#246966` | 270901 cue, אמון |
| **Muted info** | `tertiary` | `#A79C8D` | legal/מטא |

> **כלל §7 מהבעלים — קריטי:** "דורש טיפול" **אינו אדום אוטומטית**. ה-DS כבר פותר זאת: `warm.status.late` = clay חם `#B85C3F`, לא `#DC2626`. המזכירה **מפחיתה חרדה** — teal ל"בסדר/סגור", brown/clay ל"דורש תשומת-לב", neutral ל"ממתין". **אין** אדום-אזעקה, **אין** command-center של התראות. אדום-חריף שמור למצב הרסני אמיתי בלבד (לא קיים בדף הבית).

---

## 8. Product Surfaces vs Illustrations

| סקשן | בחירה | נימוק |
|---|---|---|
| Hero | **product-surface מיוצג** (Attention card, סטטי) | הפרימיטיב החתום; "מזכירה סידרה" |
| §2 Pain | **אילוסטרציה מושגית מינימלית** (icon-based) | אין product-state לכאב; לא screenshot |
| §3 Secretary | **simplified representation** (Before→Organized) | reframe, לא מסך גולמי |
| §4 Money | **real product-surface** (Business-State) | הוכחת "כסף" חייבת מצב אמיתי |
| §5 Nothing-falls | **product-surface** (Attention-list) | Pull states אמיתיים |
| §6 Breadth | **real screenshots** (`/landing/*`) | נכס קיים; רוחב אמין |
| §7 Add-replace | **typography + 270901 cue** | רגוע; בלי logos |
| §8 Memory | **אילוסטרציה מושגית מינימלית** (icon-based) | ערך-לאורך-זמן מופשט |
| §9 Control | **simplified representation** (Owner-Decision) | human-approval |
| §10 Trust | **typography + מעט iconography** | factual, לא badge-wall |
| §12 Final CTA | **typography בלבד** | סגירה נקייה |

**§2/§8 (סיכון-effort):** הפתרון הפשוט ביותר = **iconography מושגי מ-DS** (אייקונים קוויים קיימים + פריסה), לא אילוסטרציה מותאמת יקרה. אם נדרשת אילוסטרציה — מינימלית, שטוחה, בפלטת DS v1 warm. **אל תשתמש screenshot רק כי קיים; אל תייצר illustration אם product-evidence עדיף.**

---

## 9. Motion Policy

- **Optional enhancement בלבד.** הדף מובן במלואו **סטטי**.
- מותר: reveal-on-scroll עדין (fade/rise קצר), hover על card/CTA (המוגדר כבר ב-`.dz-btn-primary`).
- **אסור:** motion שמרמז על פעולה אוטונומית — "AI thinking" pulse · items שזזים לבד · notification-pop · countdown · auto-advancing gallery.
- **reduced-motion:** `prefers-reduced-motion` → מכבה כל reveal/transition לא-חיוני.
- **מבחן:** אם ה-motion לא מוסיף הבנה — לא משתמשים בו.

---

## 10. Mobile Visual System (לא גרסה מוקטנת)

- **First screen:** eyebrow(270901) · H1(≤3) · support(משפט) · `[התחילו עכשיו]` מלא-רוחב · "כניסה" קישור-header. הכרטיס מתחיל מתחת לקיפול.
- **Spacing rhythm:** מרווחי-סקשן גדולים (space 3xl–4xl); בתוך card הדוק יותר.
- **Attention Card:** מלא-רוחב, 2 items גלויים, item בגובה נוח לאצבע.
- **Breadth אופקי:** scroll-snap, card ~78vw, מתחיל מימין, אינדיקטור-נקודות עדין (לא auto-advance).
- **Trust:** אקורדיון חם.
- **Repeated CTA:** מלא-רוחב אחרי §4 ובסוף; thumb-reach.
- **Sticky:** header לא-sticky (או sticky-רזה); **אין** sticky-CTA צף (מרגיש aggressive-SaaS). ה-CTA חוזר בזרימה במקום.
- **Tap targets:** ≥44px; card-width אחיד; פישוט ויזואלי (פחות טקסט-משנה).

---

## 11. Trust Without Badge Soup

**היררכיה (לא שורת 12 badges):**
1. **Product proof** (מסכים אמיתיים לאורך §4/§6) — החזק ביותר.
2. **Control proof** (§9 human-approval).
3. **Compliance proof** (§10: 270901 — cue שקט; מספור/מבנה-אחיד).
4. **Security/Privacy proof** (§10: "הנתונים שלך שלך · אתה מאשר").

- **270901 = trust cue, לא Hero promise.** ניסוח **רק** כפי שמגובה עובדתית ("מוכר/רשום ברשות המסים · 270901"); **אין הרחבת משמעות** הרישום.
- **מספרי הקצאה:** `[CLAIM REQUIRES VERIFICATION]` — לא לשלוח עד אימות transport.
- **אין claim חדש ללא evidence. אין social-proof מומצא** (§11 = closing proof-strip רזה).

---

## 12. Accessibility (רמת spec)

- **WCAG contrast intent:** ink `#2D2B28` על cream `#FEF8F2` ≈ 12:1 (AAA). teal `#246966` על cream ל-CTA/accent — לוודא ≥4.5:1 בשלב visual. status-ink חייב ≥4.5:1 על ה-bg-soft שלו. **cream-text על teal-CTA** — כבר בשימוש ב-`.dz-btn-primary` (לוודא ≥4.5:1; להעדיף ink כהה אם גבולי).
- **Focus visibility:** ה-crisp ring של `.dz-btn-primary` (cream gap + teal) = תקן; להחיל דומה על כל interactive.
- **Keyboard order = reading order = DOM;** גם כשויזואל בשמאל, DOM הגיוני.
- **Semantic:** H1 יחיד · H2/סקשן · `<section>`/landmarks.
- **Icon independence:** כל status עם **טקסט**, לא צבע/אייקון בלבד.
- **Text equivalents:** alt/caption לכל product-surface.
- **Touch ≥44px; RTL** נשמר ב-focus/scroll.
- **Reduced-motion** מכובד.

---

## 13. Visual Anti-Patterns (אסור)

neon/AI-gradient לראווה · glowing orb · robot/assistant avatar · floating feature-cards · fake notification badges/dots · fake charts · fake customer metrics · stock "בעל עסק מחייך" · glassmorphism מוגזם · dashboard-screenshot dump · logo wall ללא evidence · badge soup · feature-icon grid (4/7 cards) · **ויזואלי sync/push/automation שאינם קיימים** (חצי-sync · clock · countdown · "בזמן" badge · אוטומציה) · אדום-אזעקה ל"דורש טיפול" · sticky-CTA צף אגרסיבי.

---

## 14. Product Truth Visual Guardrails (ויזואל יכול לשקר בלי מילים)

| ויזואל | claim מרומז | סטטוס | בטוח? | פעולה |
|---|---|---|---|---|
| **clock / countdown** | scheduler/בזמן | C | ❌ | **אסור** בכל הדף |
| **notification dot/badge** | push | C | ❌ | **אסור** — status-dot חם במקום (מצב, לא התראה) |
| **sync arrows / logos** | integration | C | ❌ | **אסור** — coexist בטקסט בלבד |
| **progression arrows** (Before→Organized) | סדר/reframe | — | ✅ | מותר (מצביע שמאלה, RTL) — לא sync |
| **progress bar** | תהליך | תלוי | ⚠️ | רק אם המצב אמיתי |
| **"AI thinking" pulse/orb** | agent אוטונומי | — | ❌ | **אסור** |
| **money state** (פתוח/שולם) | סטטוס תשלום | A | ✅ | teal/brown/neutral — לא "מאחר X ימים" |
| **customer state** (כרטיס) | דף-לקוח בפרודקשן | B | ⚠️ | placeholder מבני עד אימות |
| **inventory "alert"** | התראה חכמה | C | ❌ | "רואים במבט אחד" (Pull), בלי alert-badge |
| **compliance badge 270901** | רשום/מוכר | A | ✅ | ניסוח מגובה בלבד |
| **allocation-number badge** | transport חי | B | ⚠️ | `[REQUIRES VERIFICATION]` |
| **status color = red** | אזעקה | — | ❌ | clay/brown חם, לא אדום |

---

## 15. RTL Rules

טקסט-ימין/ויזואל-שמאל קבוע · חצי-התקדמות שמאלה · timelines/state-lists מימין · אייקון מוביל מימין · סקרול-אופקי מתחיל מימין · ₪/מספרים bidi-safe (tabular-nums) · focus/keyboard RTL. **RTL-first מההתחלה — לא היפוך LTR.**

---

## 16. Spacing / Rhythm

- **4pt scale** (`TOKEN.space`). מרווחי-סקשן: 4xl (desktop) / 3xl (mobile). בתוך card: md–lg.
- **Rhythm** (מ-wireframe §11): Hero נמוך → עלייה ל-Money → **שיא Breadth** → ירידה מכוונת (Add/Memory) → עומק (Control/Trust) → סגירה. הצפיפות מיושמת ע"י whitespace, לא גדלים.

## 17. Surface / Depth

שכבה אחת עדינה: **cream canvas → קלף `#FDF4EB` + line `#E9DDD0` + `shadowCard`** (חום-רך). Hover: `shadowCardHover`. Accent-glow (`shadowGlow` teal) רק ל-CTA. **אין** צל דרמטי, אין parallax, אין glass.

## 18. Iconography / Imagery

קווי · עדין · אחיד · מוביל-מימין. status-dots warm. imagery = מסכי-מוצר אמיתיים + ≤2 אילוסטרציות שטוחות מינימליות (§8). **אין** 3D/glossy/emoji-salad/stock-people/robot.

---

## 19. Implementation Mapping (מיפוי לפריטיבים — בלי קוד)

| רכיב עיצוב | תרגום implementation |
|---|---|
| Primary CTA "התחילו עכשיו" | **REUSE** `PrimaryCta` + `.dz-btn-primary` (קיים) |
| Secondary "ראו איך זה עובד" | **EXTEND** — וריאנט ghost/link חם קטן (token-driven) |
| צבעי גוף/canvas/link/soft | **EXTEND** — remap `marketingVars` ל-DS v1 warm (קובץ אחד → tokens קיימים) |
| Attention Item | **NEW composition** (homepage) — card(dsv1) + status-dot(warm) + action-chip; tokens קיימים |
| Before→Organized | **NEW composition** — split/flow + progression-arrow |
| Owner-Decision | **NEW composition** — prepared-item + approve-control |
| Business-State | **NEW composition** — state-row + warm.status chip |
| Breadth gallery | **REUSE** screenshots `/landing/*` (קופי מתוקן) + scroll-snap אופקי (mobile) |
| §2/§8 אילוסטרציות | **NEW asset** — icon-based מינימלי (DS palette) |
| Typography/spacing/radius/shadow | **REUSE** tokens + Heebo |

**מטרה:** המפתח מרכיב מ-primitives; אינו ממציא עיצוב תוך קידוד.

## 20. Required Assets / Fixtures

1. **Hero Attention-card** — 3 items מייצגים סטטיים (תוכן curated, לא live). **Product-Truth-safe.**
2. **מסכי `/landing/*`** — קיימים; **דורשים תיקון קופי (N)** לפני שימוש.
3. **§2/§8 אילוסטרציות** — 2 מושגיות מינימליות (מומלץ icon-based).
4. **270901 trust cue** — טקסט/אות עדין; ניסוח מגובה בלבד.
5. **כרטיס-לקוח (§6)** — screenshot רק אם מאומת בפרודקשן; אחרת placeholder מבני.
> אין fixtures שיוצרים מצב שקרי; אין live-embeds.

## 21. Remaining Owner Decisions

1. **⚠️ Warm remap של `marketingVars` (מהותי).** למפות `--mkt-*` מ-navy קריר → DS v1 warm כדי לתת דף חם-עקבי. **משפיע על כל דפי ה-corporate** (about/contact/privacy/terms), לא רק דף הבית. *המלצה: לאשר — משלים את מיגרציית DS v1 שכבר החלה ב-CTA; מאחד את המותג הציבורי.* חלופה: warm scoped לדף-הבית בלבד (יוצר פיצול home-warm/rest-cool — פחות מומלץ).
2. **אילוסטרציות §2/§8:** icon-based מינימלי (מומלץ, זול) מול אילוסטרציה מותאמת (יקר).
3. **Hero eyebrow:** 270901 (מומלץ) — בניסוח המגובה בלבד.
4. **כרטיס-לקוח §6:** להציג רק אם Product-Truth מאומת; אחרת placeholder.
5. **מספרי הקצאה §10:** unverified — do-not-ship עד אימות transport.

## 22. Risk Register

| סיכון | חומרה | מענה |
|---|---|---|
| Warm remap שובר קונטרסט/עקביות בדפי-corporate אחרים | בינוני | remap דרך tokens קיימים (נבדקו); בדיקת קונטרסט ב-visual; פריסה מבוקרת |
| cream-text על teal-CTA גבולי ל-AA | נמוך-בינוני | לאמת ≥4.5:1; ink כהה אם גבולי (כבר בשימוש חי) |
| Heebo 700 בטעות | נמוך | תקרת-משקל 600 מוגדרת; אין 700 בדף |
| אילוסטרציות → effort/עלות | בינוני | icon-based מינימלי; לא custom |
| screenshots דורשים fixtures מטעים | בינוני | לתקן קופי; placeholder לכרטיס-לקוח לא-מאומת |
| ויזואל יוצר scheduler/sync claim | **גבוה** | §14 guardrails מחייבים; audit ויזואלי לפני shipping |

---

## 23. Final Readiness Verdict

> **B — READY WITH OWNER DECISIONS.**

**נימוק:** התזה, הטיפוגרפיה, תפקידי-הצבע, ה-surface/depth, המובייל, ה-RTL, הנגישות, ה-motion, ה-anti-patterns, ה-Product-Truth guardrails, וה-implementation-mapping — **סגורים ומעוגנים ב-DS v1 הקיים** (REUSE ברובם). אך קיימת **הכרעה עיצובית מהותית אחת שאינה code-time-trivia**: ה-**warm remap** של שכבת ה-marketing-tokens המשותפת — הוא קובע אם הדף (וכל האתר הציבורי) חם-עקבי או נשאר גוף-קריר/כפתור-חם, ומשפיע על דפי-corporate נוספים. לפי מבחן-הבעלים ("האם מפתח יכול לבנות בלי הכרעות עיצוב מהותיות?") — כל עוד ה-remap פתוח, התשובה שלילית → לכן **B**, לא A. שאר ההכרעות (§21.2–5) קטנות ונלוות.

**מה מונע C:** אין בעיית DS/Product-Truth/architecture — ה-DS בוגר ומתאים; התזה ממופה נקי ל-DS v1 warm; כל primitive הוא קומפוזיציה של tokens קיימים.

**מבחן הכשל:** עם DS v1 warm (cream/teal/Heebo, status חם לא-אדום, Attention-card "מה דורש אותך היום") — מחיקת הלוגו משאירה תחושת "מישהו סידר לי את העסק לפני שנכנסתי", לא "עוד SaaS עם AI". ✅ עובר — **בכפוף לאישור ה-warm remap.**

---

*Visual Design Spec. אינו משנה קוד/DS/אתר ציבורי. מבוסס firsthand על `lib/design/tokens.ts` (DS v1 warm כזהות רשמית) וכפוף למיצוב/מסר/wireframe ולחוזה ההתנהגות. כל רכיב כפוף ל-Product Truth (§14) ול-Hard Launch Gate (scheduler/push).*
