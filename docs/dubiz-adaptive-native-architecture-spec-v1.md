# Dubiz Adaptive + Native Architecture Specification v1

**Status: DESIGN ONLY — אושר לתכנון, לא ליישום. אפס שינויי קוד/CSS/native בוצעו.**
**Date: 2026-08-27 · Source of truth למצב הקיים: `docs/dubiz-responsive-native-ui-audit-v1.md` ‏(base `70036c2`).**

---

## 1. Executive Decision

Dubiz עוברת מ"כל feature ממציא רוחב" ל-**חוזה layout אחד בן שלושה חלקים**:

1. **סקאלה קנונית אחת** — ‏3 ‏breakpoints ‏(768/1024/1280) ו-5 ‏intents של רוחב (focused/standard/data/workspace/full) שחיים כ-tokens ב-DS. אף מסך לא בוחר מספר; מסך בוחר **intent**.
2. **‏primitive עמוד אחד** — ‏`PageContainer` (מוחיה, ‏API מבוסס-intent) הוא הדרך היחידה לקבל רוחב עמוד; ‏`WorkspaceLayout` הוא הדרך היחידה לקבל split; ‏`AdaptiveOverlay` הוא הדרך היחידה לקבל modal/sheet.
3. **חוזה native אחד** — ‏safe-areas כ-CSS vars בבעלות ה-shell, ‏edge-to-edge, ‏OAuth בדפדפן מערכת, ‏targetSdk/SDK עדכניים — לפני כל הגשה לחנויות.

העיקרון המנחה: **‏composition לפי intent, לא stretching**. ‏Desktop של טבלה ≠ ‏Desktop של טופס. ‏Mobile הקיים (אפס overflow) הוא נכס — מגינים עליו ב-CI.

## 2. Current Root Causes (מהאודיט — התמצית המחייבת)

‏RC-1 סמכות רוחב מתה (‏PageContainer/useBreakpoint ‏0 צרכנים; ‏160 literals; ‏9 משפחות BP; אין tokens) · ‏RC-2 תוכן-טלפון ב-shell-desktop (‏520/600/720/760/480…) · ‏RC-3 מוצרי phone-frame ‏(revenue/pricing) · ‏RC-4 פרגמנטציית קבוצות-routes · ‏RC-5 ‏overlays בלי primitive + מלחמת z-index · ‏RC-6 חוזה native לא מטופל · ‏RC-7 ‏dark-mode שבור-חצי + זום ששובר ספים.

## 3. Canonical Form-Factor Scale

| Tier | טווח | ‏nav (קיים) | רציונל |
|---|---|---|---|
| **compact** | ‏< 768 | ‏BottomBar | טלפון; קו קיים של ShellChrome ושל Tailwind ‏`md` |
| **medium** | ‏768–1023 | ‏rail ‏76px | טאבלט-portrait; קיים |
| **expanded** | ‏1024–1279 | ‏sidebar ‏248px | ‏laptop/טאבלט-landscape; קיים, וגם Tailwind ‏`lg` |
| **wide** | ‏≥ 1280 | ‏sidebar | ‏workspace מלא; ‏Tailwind ‏`xl`, וכבר בשימוש ב-review-adaptive |

- **החלטות איחוד**: ‏769 של Inbox → ‏768; ‏1200 של Customers → ‏1280; ‏900/960/980/1100 הפנימיים נעלמים (הרכיבים עוברים ל-tiers). ‏640 נשאר רק כ-sub-token של overlays (sheet→dialog) בתוך ה-primitive — לא זמין למסכים.
- **שילוב ShellChrome**: אפס שינוי — ‏768/1024 הם בדיוק ספי ה-shell; ‏1280 מתווסף כ-tier תוכן בלבד.
- **שילוב Tailwind**: ‏v4 ללא config → ‏md/lg/xl ‏(768/1024/1280) מהקופסה תואמים 1:1. אזורי ה-Tailwind (settings/tools/corporate) כבר על הסקאלה.
- **‏a11y/scaling**: ‏breakpoints נשארים ב-px. שינוי גודל טקסט יעבור ל-rem ‏(§17,§22) ולכן לא יזיז ספים; ‏browser-zoom 200% שמפיל tier הוא reflow תקין (‏WCAG) — לא באג.

## 4. Layout Tokens (תוספת ל-`lib/design/tokens.ts` — המקור היחיד)

```ts
layout: {
  bp: { medium: 768, expanded: 1024, wide: 1280 },          // media queries נגזרות רק מכאן
  width: { focused: 560, standard: 760, content: 960, data: 1280 }, // full = ללא cap
  gutter: { compact: 16, medium: 24, expanded: 32 },        // padding-inline דרך clamp
  shell: { rail: 76, sidebar: 248, bottomClearance: 100 },  // משקף את ShellChrome
  z: { nav: 100, fab: 110, overlay: 1300, toast: 1400 },    // סוף מלחמת ה-2147483000
}
```
+ ‏CSS vars שה-shell מזריק: ‏`--dz-safe-top/bottom/start/end` ‏(§12), ‏`--dz-content-gutter`. **כלל: אף קובץ מוצר לא כותב px של רוחב-עמוד/breakpoint/z — רק tokens.**

## 5. Canonical Page/Layout Primitives

- **‏`PageContainer` — מוחיה, הופך לחובה.** הקיים טוב כבסיס (יש לו כבר 480/760/1200/clamp), אבל ה-API משתדרג מ-size ל-intent, והוא לוקח אחריות על `<main>`, ‏gutters, ‏safe-inline ו-attr לאכיפה:
```tsx
<PageContainer intent="data" as="main">   // intent: focused|standard|content|data|full
```
מפרט: ‏max-width מ-`layout.width`; ‏`padding-inline: clamp(gutter.compact, 3vw, gutter.expanded)`; ‏`margin-inline: auto`; ‏`data-page-intent="data"` ‏(hook ל-CI ולבדיקות); ‏`full` מוותר על cap אך שומר gutters (אלא אם `bleed`). ‏migration alias זמני: ‏`size="wide"` ממופה ל-intent עם אזהרת deprecation.
- **‏`WorkspaceLayout`** — ה-primitive היחיד ל-split ‏(§10). מפסיק "לסרב להחזיק breakpoint": ברירת מחדל `bp="wide"` מהסקאלה; override מותר רק לערך סקאלה.
- **‏`AdaptiveOverlay`** — חדש ‏(§11).
- **‏`DataTable`** — נשאר כפי שהוא (container-driven, נכון) ופשוט מקבל סוף-סוף container רחב.

## 6. Layout Intent System

| Intent | רוחב | מתי | דוגמאות |
|---|---|---|---|
| **focused** | ‏560 | ‏login, טפסים קצרים, הגדרות ממוקדות, שלבי wizard | ‏settings/whatsapp, ‏bot-settings, ‏upload |
| **standard** | ‏760 | קריאה, ‏CRUD בסיסי, ‏wizard עשיר, ‏export | ‏secretary, ‏accountant-pack, ‏content steps |
| **content** | ‏960 | ‏hubs מורכבים, מסכי-בית של מודול | ‏documents hub, ‏home ‏/app |
| **data** | ‏1280 | רשימות/טבלאות/דשבורדים | ‏documents inbox/search/dashboard, ‏inventory lists, ‏opportunities, ‏billing hub |
| **workspace** | מלא, מנוהל-panes | ‏master-detail, ‏editor+preview, צ'אט | ‏review, ‏inbox, ‏customers, ‏payments, ‏billing/[id] |
| **full** | ללא cap | משטחים ויזואליים מיוחדים | ‏coupon-design (dev) |

**המיפוי הזה הוא חוזה**: מפתח בוחר intent מהטבלה; רוחב מספרי לעולם לא מופיע בקוד מסך. שינוי intent = ‏code-review decision, לא ערך שרירותי.

## 7. Desktop Contract (expanded/wide)

- ‏**data**: טבלה במקום cards מ-expanded (הדפוס הקיים ב-DocumentsInboxTable — עכשיו עם רוחב); שורת פילטרים אופקית; צפיפות עולה (‏row height, עמודות משנה); ‏side-panel/preview נפתח ב-wide כשקיים detail טבעי.
- ‏**workspace**: שני panes מ-wide ‏(1280); ‏pane משני sticky; ‏chrome של כרטיס-מובייל מוסר (כמו review-adaptive היום).
- ‏**content/hub**: קומפוזיציה דו-טורית ב-expanded (סיכומים ימין, פעולות/פידים שמאל) — אותם רכיבים, ‏grid אחר.
- ‏**focused/standard**: נשארים צרים וממורכזים — ‏constrained הוא UX נכון לטפסים. **אין "יישור ל-1200 לכולם".**
- ‏multi-column מותר רק דרך grid-tokens (‏auto-fit עם minmax מתועד) בתוך container בעל intent מתאים.

## 8. Tablet Contract (medium)

- ‏medium אינו טלפון מוגדל: ‏hubs עוברים ל-2 עמודות סיכום; רשימות מקבלות מצב "compact table" (או cards בשתי עמודות) — לפי הרכיב; ‏workspace נשאר עמודה אחת עם ניווט חזרה (split נדחה ל-wide, למעט Inbox-צ'אט שכבר מוכיח 768).
- ‏portrait ‏(768–834): עמודה + הרחבות נקודתיות; ‏landscape ‏(1024+): מקבל את חוזה expanded המלא — טאבלט רוחבי = ‏laptop קטן, בכוונה (וגם בגלל G6: ‏Android מתעלם מנעילת orientation ב-≥600dp).
- ‏sheets נשארים sheets עד 640; מ-640 דיאלוג ‏(§11).

## 9. Mobile Contract (compact) — ‏invariants מוגנים

1. אפס horizontal overflow (נאכף ב-CI על כל route). ‏2. ‏touch targets ≥44pt/48dp ברכיבי ליבה. ‏3. טיפוגרפיה ≥14px לגוף. ‏4. ‏clearance ל-BottomBar דרך ‏`shell.bottomClearance`+safe-bottom בלבד. ‏5. טפסים keyboard-safe (אין clear-focus על resize — אזהרת G4). ‏6. ‏sheets בתוך dvh עם safe-bottom. ‏7. ‏RTL שלם. ‏8. אין דליפת צפיפות-desktop (מצבי table לא מתחת ל-expanded). ‏9. אף תיקון desktop לא נוגע בערכי compact — ‏additive media queries בלבד.

## 10. Workspace Contract — הכרעה

**המלצה: ‏A — איחוד על בסיס `WorkspaceLayout`; ‏`MasterDetailLayout` מוצא משימוש.**
- נימוק: ‏WorkspaceLayout עשיר יותר (‏switch/split, ‏shared list, ‏resize) עם 2 צרכנים מוכחים; ‏MasterDetail ‏(צרכן 1 — ‏Payments) חופף ~90%. איחוד = חוזה אחד ל-5 המשפחות.
- ‏Migration: ‏Payments עובר ל-WorkspaceLayout באותו wave שבו מתוקן ה-detail-leaf שלו ‏(§23) — שינוי אחד ולא שניים. ‏MasterDetailLayout מקבל deprecation ונמחק אחרי.
- סיכון: מסמך ה-DIS-closure הכריז על האיחוד non-requirement ואסר reopening — **סעיף זה דורש אישור בעלים מפורש שה-spec הזה גובר** ‏(§34.5).
- יישום למשפחות: ‏Customers=reference (רק ‏1200→1280); ‏Inbox נשאר ‏(768 מוכר כחריג מתועד לצ'אט); ‏Payments=מאוחד+leaf; ‏Suppliers=שכפול חוזה Customers; ‏Documents-review נשאר על ה-module הקיים (הוא כבר החוזה) ומיושר ל-tokens בלבד.

## 11. Overlay Contract — ‏`AdaptiveOverlay`

- ‏API: ‏`variant="confirm"|"form"|"wide"|"fullscreen"`, ‏`sheetOn="compact"` (ברירת מחדל).
- התנהגות: ‏<640 — ‏bottom-sheet ‏(radius עליון, ‏max-height ‏86dvh, ‏padding-bottom safe); ‏≥640 — דיאלוג ממורכז; רוחב: ‏confirm 400 / ‏form 560 / ‏wide `min(900px, 92vw)`; ‏fullscreen = ‏inset 0.
- מכניקה: ‏portal ל-node ייעודי **מחוץ ל-`.shell-content`** (מחסל את בעיית stacking-context z-1 ואת "שריון ה-160px"); ‏z מ-`layout.z.overlay`; גלילה פנימית ‏overscroll-contain; ‏focus-trap מהמימוש הקיים אחרי איחוד שני העותקים; מיקום/כיווניות ב-logical properties.
- מיגרציה: ‏action-sheet, ‏collection-sheet, ‏.crm-modal, ‏ReviewOverlayShell, ‏DocumentFilePreviewOverlay ‏(fullscreen), ‏movement-sheet — כולם צרכנים; ‏.crm-modal הוא אב-הטיפוס ההתנהגותי.

## 12. Safe-Area Contract

- **בעלות: ‏ShellChrome.** הוא לבדו קורא `env()` ומפרסם: ‏`--dz-safe-top/bottom/start/end` ‏(fallback ‏0px), וכן ‏`--dz-header-offset` ‏(safe-top + גובה header כשקיים).
- צרכנים: שכבת ה-header של כל מסך מרפדת ב-`--dz-safe-top` (דרך PageContainer/הShell — לא פר-מסך); ‏BottomBar כבר נכון; ‏overlays/toasts/FAB צורכים vars בלבד. **אסור `env(` מחוץ ל-shell+primitives** (‏CI-greppable).
- ‏native: ב-iOS ‏WKWebView + ‏viewport-fit=cover מספקים env אמינים; ב-Android ה-CSS אמין רק מ-WebView M136/M144 → תוכנית כפולה: ‏plugin ‏(@capacitor-community/safe-area או insets-native-zeroing לפי POC) מזין את אותם vars כשה-env ריק. ה-contract לצרכנים זהה בשני המסלולים.
- מקלדת: ‏var עתידי ‏`--dz-keyboard` מה-Keyboard plugin; טפסים לא מאזינים ל-resize לניקוי פוקוס.

## 13. Android Native Contract

**‏Store blockers (לפני הגשה)**: ‏targetSdk 36 ‏(מדיניות Play, 31.08.26 לעדכונים) · ‏edge-to-edge insets מטופלים ‏(§12) — אחרת תוכן תחת status-bar/gesture-pill · ‏predictive-back (לוודא Capacitor עדכני עם OnBackInvokedCallback; אימות back-flows) · ‏OAuth מחוץ ל-WebView ‏(§16) · ‏splash+icon ממותגים (היום stock) · חשבון בדיקה ל-review.
**‏Platform requirements (נכפים בכל מקרה)**: ‏cutout=always · ‏`setStatusBarColor` ‏no-op → צביעה דרך web מאחורי bar שקוף · ‏IME resize חדש (M139) · ‏`android:supportsRtl="true"` (ברירת מחדל false!) · ביטול נעילת orientation ב-≥600dp → ‏medium/expanded tiers חייבים לעבוד.
**‏Quality recommendations**: ‏48dp targets · ‏T-Theme_Support (ר' §19 — פער מודע) · ‏Large-screen Tier-3 (מכוסה ע"י הסקאלה) · ניטור vitals ‏(crash 1.09%/ANR 0.47%) · הוכחת בעלות דומיין למדיניות Webviews.
נוסף: ‏file upload (camera intent), ‏download של ZIP רו"ח — ‏WebView לא מוריד קבצים לבד → ‏Browser/Filesystem+Share plugin (חוצה-פלטפורמה, ר' §14).

## 14. iOS Native Contract

**‏Mandatory**: בנייה עם Xcode 26/iOS 26 SDK (בתוקף מ-28.04.26) · אין עוד letterboxing — ‏layout חייב fluid · ‏UIScene lifecycle (לאמץ עכשיו — שבר מתוזמן) · ‏WebKit בלבד (מתקיים) · ‏4.2 Minimum-Functionality — חובת יכולות native מורגשות ‏(§15) · ‏2.1 חשבון דמו + הערות reviewer בעברית/אנגלית · ‏age-rating questionnaire · זהירות 2.5.2 לגבי OTA-bundle.
**‏Platform**: ‏safe-areas ‏(§12) · ‏status-bar style תואם רקע חם · מקלדת ‏(contentInset "always" קיים — לאמת עם טפסים) · ‏downloads/share דרך share-sheet plugin (ה-ZIP!) · קישורים חיצוניים ב-SFSafariViewController · ‏back = ניווט in-app עקבי (אין hardware back).
**‏Decisions**: ‏iPhone-only בהגשה ראשונה (iPad אינו חובה; ‏compatibility-mode יציג את ה-compact tier — קביל) · ‏portrait-first ב-iPhone מותר; לא נועלים ב-native כדי לא לסתור עתיד iPad.
**‏Recommendations**: ‏44pt · ‏Dynamic-Type/Larger-Text ‏(rem-scale §17 מכין ל-200%) · ‏Accessibility Nutrition Labels (וולונטרי→עתיד-חובה).

## 15. Remote WebView Decision

**הערכה**: המודל הנוכחי (‏`server.url` מרוחק) הוא ‏**קביל לטווח קצר, בתנאי הקשחה; לא היעד הבינוני**.
- ‏Play: תקין (מדיניות Webviews = בעלות; יש) . ‏Apple: סיכון 4.2 בינוני — ‏wrapper "דק" נדחה; ההגנה: ‏plugins ‏native מורגשים (מצלמה/סריקה להעלאת מסמכים, ‏share, ‏push בעתיד, ‏offline screen ממותג, ‏haptics), ולא הסרת המודל.
- יתרון: ‏release semantics מיידיים (אין review פר-דיפלוי); חסרון: תלות-רשת מלאה, ‏TTI, תחושת-native, ורגישות 2.5.2 אם נעבור ל-bundle+OTA בהמשך.
- **המלצה**: שלב א' — ‏remote+hardening (מהיר להגשה); שלב ב' (‏owner decision §34.4) — מעבר ל-bundle מקומי של ה-shell הקריטי (או לפחות splash→app-shell מקומי) לשיפור يقינות ו-4.2.

## 16. OAuth / Navigation Policy

- ‏flows מזוהים: ‏Google OAuth ‏(Gmail import) · ‏Meta/WhatsApp connect · דפי סליקה חיצוניים ‏(Tranzila/CardCom hosted) · קישורים חיצוניים (עמודי קופון ציבוריים, ‏share).
- **מדיניות**: ‏OAuth ‏**לעולם לא בתוך ה-WebView** — ‏Google חוסמת embedded user-agents ממילא; משתמשים ב-Browser plugin ‏(Custom Tabs / ‏ASWebAuthenticationSession) עם חזרה ב-universal/app link. ‏`allowNavigation` נשאר **מינימלי ומפורש**: הדומיין שלנו בלבד; דפי סליקה — עדיפות ל-Browser; אם מוצרית חייבים in-app, ‏allowlist נקודתי לדומיין הסליקה בלבד. אין wildcards.

## 17. Accessibility / Scaling Contract

- **מפסיקים CSS ‏`zoom`.** ה-FAB עובר לסקאלת טקסט: ‏`html{font-size:100%|110%|125%}` + טיפוגרפיה/spacings מרכזיים ב-rem (מיגרציה הדרגתית של רכיבי ליבה). ‏breakpoints לא זזים; ‏layout לא נשבר; תואם יעד "‏Larger Text 200%".
- ‏browser-zoom 200% = ‏reflow לגיטימי ל-tier נמוך — נבדק ב-test-matrix.
- ‏FAB: מיקום לפי form-factor (צמוד ל-bar ב-compact; פינת inline-end ב-desktop), ‏z מ-tokens.

## 18. RTL Contract

‏invariants: ‏logical properties בלבד בקוד חדש (‏margin/padding/inset-inline-*) · ‏sidebar/rail ב-inset-inline-start (קיים) · חיצי ניווט מתהפכים לפי dir · טבלאות ומספרים: ‏digits LTR בתוך תא RTL · ‏overlays ב-logical · ‏`android:supportsRtl="true"` · ‏iOS ירש מה-web. אכיפה: ‏lint שאוסר ‏`left:`/`right:`/`margin-left` וכו' בקבצי style חדשים (רשימת חריגים מפורשת), ‏+ בדיקת RTL בצילומי ה-CI.

## 19. Dark Mode Decision

**המלצה: ‏B — ‏light-only עקבי עכשיו.** מבטלים את ה-flip האוטומטי ב-`globals.css`, מוסיפים `color-scheme: light` — נעלם המסך השחור-מאחורי-קלפים. ‏Dark מלא נשאר backlog מותנה-תשתית (כל הצבעים ההרדקודים → tokens; מהלך גדול שייתכן אחרי אימוץ ה-DS). פער מול המלצת T-Theme_Support מתועד ומקובל זמנית. ‏(owner sign-off ‏§34.2)

## 20. Documents Target

| Route | Intent | ‏compact | ‏medium | ‏expanded/wide |
|---|---|---|---|---|
| ‏hub | ‏content | קיים | ‏2-col סיכומים | ‏pulse+פעולות ב-grid, ‏960 |
| ‏inbox | ‏data | ‏cards (קיים) | ‏compact-table | הטבלה הקיימת ב-1280, פילטרים בשורה; ‏wide: עמודות נוספות (‏hash/מקור) |
| ‏search | ‏data | קיים | טבלה | טבלת תוצאות 1280 + פילטרים צד |
| ‏dashboard | ‏data | קיים | ‏2-col | ‏KPI auto-fit סוף-סוף מתרחב; גרפים בשורה |
| ‏upload | ‏focused | קיים | קיים | ממורכז 560–760, ‏preview לצד dropzone ב-wide (רכיב קיים) |
| ‏email / uniform-export | ‏focused | קיים | קיים | ‏560 |
| ‏accountant-pack | ‏standard | קיים | קיים | ‏760 + היסטוריית חבילות עתידית ב-side-panel ‏(wave נפרד) |
| ‏review/[id] | ‏workspace | קיים | קיים ‏(mid-tier) | **כבר היעד** — רק יישור tokens |

## 21. Inventory Target

עיקרון: מחליפים את `--inv-content-max` הקשיח ב-**‏var לפי intent פר-עמוד** — המודול כבר בנוי על CSS vars, כך שהמיגרציה היא קביעת intent, לא שכתוב.
- ‏hub → ‏content/data-dashboard: ‏KPI רצועה + בריאות-מלאי + פעולות (4 בשורה ב-expanded) + "דורש טיפול" כטבלה. לא 520.
- ‏items → ‏data: מצב טבלה ב-expanded ‏(שם/מק"ט/כמות/ספים/ערך/ספק), ‏cards ב-compact; ‏wide: ‏master-detail עם item-detail בצד ‏(WorkspaceLayout) — ‏detail הקיים הופך pane.
- ‏item/[id] → ‏workspace-detail (בתוך ה-master-detail; עצמאי ב-compact/medium).
- ‏alerts / drafts / sales / unmatched / supplier-purchases / pending / history → ‏data (רשימות-טבלה 1280; ‏pending — המסך הצפוף במודול — המרוויח הגדול).
- ‏count → ‏standard (עבודה ממוקדת — נשאר צר בכוונה).
- ‏sales/create, ‏receive, ‏send → ‏standard.
- ‏purchase-order wizard ‏(new/cart/confirm) → ‏standard + ה-2-col הקיים ‏(build|cart-sticky) עולה ל-expanded.
- ‏integrations/import → ‏focused/standard.

## 22. Home Target ‏(`/app`)

‏intent ‏content. אותם רכיבים, קומפוזיציה: ‏compact — עמודה (קיים); ‏medium — ‏2-col ‏(סיכום/priorities | פעולות); ‏expanded/wide — ‏grid ‏3 אזורים: ‏greeting+summary עליון, ‏priorities/attention feed ראשי, ‏quick-actions+contextual panel צד. אפס features חדשים — ‏composition בלבד. ‏(480→960 עם עיצוב, לא מתיחה.)

## 23. CRM / Suppliers / Payments Target

- ‏**Customers** = ‏reference; שינוי יחיד: סף 1200→1280 ‏(tokens) + ‏detail card ‏720→ממלא pane עם עמודת-קריאה פנימית ‏840.
- ‏**Payments**: מעבר ל-WorkspaceLayout המאוחד; ‏detail-leaf ‏560→ממלא pane: כותרת+ציר-זמן בעמודה ראשית, פעולות/סיכום sticky בצד ב-wide.
- ‏**Suppliers**: אימוץ אחד-לאחד של חוזה Customers ‏(layout קיים דלת-ליד-דלת): ‏list-pane 380 | ‏detail; ‏compact נשאר כקיים.
- ‏**Collection/Attention**: ‏data ‏(worklist 1280 עם טבלה ב-expanded).

## 24. Billing Target

- ‏hub → ‏data ‏(980→1280, טבלת מסמכים).
- ‏**builder ‏/billing/[id]** → ‏workspace ב-wide: ‏pane עריכה (פרטי מסמך + טבלת שורות ברוחב מלא של ה-pane) | ‏pane צד sticky: סיכום סכומים/מע"מ + פעולות + preview המסמך (רכיב ה-preview הקיים; אם אין רכיב מוכן — שלב א' צד-סיכום בלבד, ‏preview ב-wave עתידי). ‏compact/medium — זרימה אנכית קיימת. אפס שינויי מוצר — ‏composition בלבד.

## 25. Revenue / Phone-Frame Decision Points

הפרדה מחייבת: **‏consumer preview = ‏phone-frame מוצדק; ‏management = לא.**
- ‏`/revenue` ‏(Marketing Center): ‏management → ‏data בתוך ה-shell (מחזירים ניווט!), עם ‏PhoneFrame כ-**רכיב preview** בתוך המסך. ‏⚠️ ‏owner decision ‏§34.1 — שינוי UX מהותי; וגם תיאום עם branch הקופונים הפעיל שלך.
- ‏coupon consumer page (הנצפית ע"י לקוח קצה) — נשארת mobile-first (מוצדק).
- ‏`/pricing` → ‏standard-wizard (ה-mock ‏460 נזנח) — ‏owner sign-off.
- ‏`/coupon-design` — גלריית dev; ‏full, נשאר.

## 26. Migration Map — סמכויות רוחב קיימות → קנוני

| ‏Current authority | ‏→ ‏Target |
|---|---|
| ‏documents ‏`pageMain 760` + עותקים | ‏PageContainer ‏intent per §20 |
| ‏inventory ‏`--inv-content-max:720` / ‏960 / ‏1080 | ‏var מ-intent ‏(§21), ואז PageContainer בקליפה |
| ‏CRM ‏`.crm-page 720` | ‏pane-width מ-WorkspaceLayout + עמודת-קריאה 840 |
| ‏Tailwind ‏`max-w-md/2xl/4xl` ‏(settings/tools/app) | ‏PageContainer ‏focused/standard/content |
| ‏`PhoneFrame 480/390` | רכיב preview בלבד; מסכים → intents |
| ‏billing ‏980/720 | ‏data / workspace |
| קבועים בודדים ‏(attention 640, ‏collection 720, ‏posts 520, ‏dashboard 500…) | ‏intent מתאים או מחיקה ‏(legacy) |
| ‏9 משפחות breakpoints | ‏`layout.bp` בלבד |
| ‏z ‏100/101/2147483000 | ‏`layout.z` |

## 27. Pilot Screens (מוכיחים כל intent לפני רוחב)

1. **‏Documents Inbox** — ‏data/table (הטבלה קיימת; ‏ROI מיידי).
2. **‏Inventory Hub** — ‏dashboard-composition (המקרה הקשה: ‏recompose, לא stretch).
3. **‏Payments Detail** — ‏workspace-leaf + איחוד ה-primitive.
4. **‏Settings/WhatsApp** — ‏focused (מוכיח שגם "להישאר צר" עובר דרך המערכת).
5. **‏Billing Builder** — ‏workspace מורכב.

## 28. Implementation Waves

- **‏W0 Foundation**: ‏layout tokens · ‏PageContainer v2 · ‏AdaptiveOverlay · ‏safe-area vars ב-shell · ‏CI בסיס (‏no-overflow gate + snapshot harness) · ‏a11y zoom→rem · ‏dark-mode B.
- **‏W1 Pilots**: חמשת המסכים ‏(§27) + אימות מטריצה.
- **‏W2 Documents cluster** ‏(§20).
- **‏W3 Inventory cluster** ‏(§21).
- **‏W4 Home + CRM convergence** ‏(§22–23; כולל suppliers).
- **‏W5 Billing + long tail** ‏(content wizard יישור, ‏settings, ‏legacy ‏/search+/upload החלפה/מחיקה, קישורים מתים).
- **‏W6 Native Foundation** *(מקבילי ל-W0–W1, לא אחריהם — בגלל דדליין targetSdk)*: ‏plugins, ‏insets, ‏predictive-back, ‏supportsRtl, ‏OAuth-Browser, ‏splash/icon, ‏targetSdk36/iOS26-SDK, ‏UIScene.
- **‏W7 Native closure**: אימות מכשירים אמיתיים ‏(iPhone notch, ‏Android gesture-nav, טאבלט), ‏store dry-run.
תלות: ‏W1 לפני W2–W5; ‏W6 עצמאי; ‏W7 אחרי W6+W2.

## 29. CI / Anti-Drift Guardrails (חכמים, לא grep טיפשי)

1. **‏no-overflow gate**: הרצת harness המדידה (קיים — ‏responsive-audit.mjs) על preview לכל PR שנוגע ב-UI: ‏assert ‏scrollWidth≤innerWidth בכל route×viewport.
2. **‏page-intent gate**: כל `page.tsx` תחת קבוצות המוצר חייב לרנדר ‏`data-page-intent` (דרך PageContainer/WorkspaceLayout) — סקריפט מיפוי route→intent, עם allowlist ל-legacy עד מיגרציה.
3. **‏raw-width lint** ממוקד: אסור ‏`maxWidth:` ‏חדש **בקבצי page/screen wrappers** (לא ברכיבים — רוחב רכיב לגיטימי); חריגה דורשת ‏`// layout-exempt: <סיבה>`.
4. **‏breakpoint lint**: ‏`@media`/`min-width` עם px מחוץ לקבצי DS/primitives — אסור בקוד חדש (allowlist לקיים, מצטמק).
5. אסור ‏`window.innerWidth` ב-routes; אסור `env(safe-area` מחוץ ל-shell/primitives; אסור z-index מספרי חדש.
6. **‏snapshot suite**: צילומי route×{390, 768, 1280, 1920} עם diff — ‏regression ויזואלי.

## 30. Test Matrix

‏viewports: ‏320/390/430 · ‏768/1024 ‏(שני הכיוונים) · ‏1280/1440/1920 · ‏zoom 200% ‏(1280) · ‏text-scale 125% — לכל pilot ואשכול בעת מיגרציה; ‏native: ‏iPhone עם Dynamic-Island, ‏Android gesture-nav ‏(15/16), טאבלט Android ‏(בדיקת ביטול-נעילה), מקלדת בטפסים, ‏RTL, העלאת קובץ ממצלמה, הורדת ZIP, ‏OAuth round-trip, ‏back-flows.

## 31. Google Play UI/Native Readiness — ‏DoD

‏targetSdk 36 ✅ · ‏edge-to-edge: אף מסך עם תוכן תחת bars במכשירי בדיקה ✅ · ‏predictive-back עובד ✅ · ‏supportsRtl ✅ · ‏IME לא שובר טפסים ✅ · ‏OAuth ב-Custom Tabs ✅ · ‏upload/download עובדים ✅ · ‏splash/icon ממותגים ✅ · הוכחת בעלות דומיין מוכנה ✅ · טאבלט ≥600dp שמיש בלי נעילה ✅ · ‏vitals ניטור מחובר ✅.

## 32. App Store UI/Native Readiness — ‏DoD

‏Xcode26/iOS26 build נקי ✅ · ‏UIScene ✅ · ‏safe-areas בכל מסך (notch/island/home-indicator) ✅ · ‏status-bar style תקין ✅ · לפחות 2–3 יכולות native מורגשות ל-4.2 (מצלמה-להעלאה, ‏share, ‏offline screen) ✅ · ‏OAuth ב-ASWebAuth ✅ · ‏external links ב-Safari-VC ✅ · חשבון דמו + review notes ✅ · ‏age-rating ✅ · צילומי store אמיתיים ✅ · החלטת iPad מתועדת ✅.

## 33. Risks / Dependencies

- ‏branch הקופונים הפעיל שלך נוגע ב-revenue/coupon — ‏W-revenue מחייב תיאום/מיזוג קודם.
- ‏D2/P7 ‏(W4D+) ממשיך במקביל — אין חפיפת קבצים צפויה, אבל כל PR עובר freshness.
- ‏rem-מיגרציה ‏(§17) נוגעת בטיפוגרפיה רחבה — לבצע ב-W0 על רכיבי ליבה בלבד ואז הדרגתי.
- ‏Heebo synthetic-bold ‏700+ (סיכון ידוע) — ‏snapshot suite יגלה רגרסיות.
- ‏content-wizard ‏22 מסכים — ‏long-tail; לא חוסם.
- ‏WebView versions ישנים ב-Android ‏(env-insets) — ‏POC plugin לפני W6-סגירה.

## 34. Owner Decisions Required

1. **‏Revenue/Marketing Center** כ-workspace עם preview מוטמע (שינוי UX מהותי) — ‏GO/NO-GO.
2. **‏Dark mode**: אישור B ‏(light-only עכשיו).
3. **‏iPad**: אישור iPhone-only להגשה ראשונה.
4. **‏WebView**: אישור remote+hardening לטווח קצר; יעד bundle בינוני.
5. **איחוד Workspace primitives** — אישור שה-spec גובר על ה-non-requirement של DIS-closure.
6. ‏Pricing redesign ל-standard-wizard.
7. סף workspace ‏1280 (מיישר את Customers מ-1200) — אישור.

## 35. Recommended Exact Implementation Order

**‏(1)** ‏W6 ‏Native Foundation ‏(דדליין 31.08 ל-targetSdk; עצמאי) ‏∥ **‏(2)** ‏W0 ‏Foundation ‏(tokens/PageContainer/Overlay/safe-vars/CI/zoom→rem/dark-B) → **‏(3)** ‏W1 חמשת ה-pilots → **‏(4)** ‏W2 ‏Documents → **‏(5)** ‏W3 ‏Inventory → **‏(6)** ‏W4 ‏Home+CRM+Suppliers → **‏(7)** ‏W5 ‏Billing+long-tail → **‏(8)** ‏W-Revenue (אחרי החלטה 34.1 ותיאום branch) → **‏(9)** ‏W7 ‏Native closure + ‏store dry-run.

---
*עצירה כאן בהתאם להנחיה: אין implementation עד אישור מפורש.*
