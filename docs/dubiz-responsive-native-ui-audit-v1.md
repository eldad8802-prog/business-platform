# Dubiz Full Responsive + Native UI Audit (v1)

**Status: AUDIT ONLY — לא בוצע שום שינוי קוד/CSS/‏PR.**
**Date: 2026-08-27 · Base: `origin/main` @ `70036c2` · Runtime evidence: Production (promaxgroup.co.il), session מאומת, 170 מדידות × ‏9 viewports + צילומי מסך (scratchpad/ui-audit) · מקורות חנויות: Apple/Google רשמיים בלבד (‏URLs בגוף).**

---

## 1. Executive Verdict

**הבעיה שזיהית אמיתית, רחבה מהדוגמאות שנתת, והיא בעיקרה 3–4 root causes מערכתיים — לא עשרות באגים נפרדים.**

1. **קיים shell אדפטיבי אחד אמיתי וטוב** (‏`ShellChrome`: ‏bottom-bar < 768 → rail 76px → sidebar 248px ב-1024+), אבל הוא **לא קובע רוחב תוכן** — כל מסך מחליט לבד. התוצאה ב-1920px: ‏canvas של 1672px שאליו רוב המסכים מציירים עמודת טלפון: ‏Inventory hub ‏**520px (ניצול 27%)**, ‏Documents hub ‏**600px (31%)**, כל תת-מסכי Documents ‏**760px (40%)**, כל מודול המלאי כלוא ב-**720px** (`--inv-content-max`), ‏home ‏`/app` ‏**480px ללא אף media query**, ‏Revenue הוא **מסגרת טלפון 480px בלי ניווט בכלל**. ‏PROVEN בקוד + ‏runtime + צילומים.
2. **הסמכות לרוחב קיימת כקוד מת**: ‏`PageContainer` (narrow 480/standard 760/wide 1200/full) נכתב במפורש כדי להחליף "~59 קבועי maxWidth" — **ואפס מסכים צורכים אותו**. גם `useBreakpoint` — אפס צרכנים. בפועל: **160 מופעי `maxWidth` ב-38 ערכים שונים ו-9 משפחות breakpoints** (768/769/900/960/980/1024/1100/1200/1280). ה-DS מפנה ל-"סקאלת breakpoints של ה-DS" — **שלא קיימת ב-`tokens.ts`**.
3. **היגיינת mobile טובה**: ‏**אפס horizontal overflow** בכל 170 המדידות כולל 320px. הבעיה אינה "שבור במובייל" אלא "לא תוכנן ל-Desktop".
4. **ה-native הוא scaffold בלבד עם חוזה לא-מטופל**: ‏`viewport-fit=cover` דלוק אבל `env(safe-area-inset-top)` מופיע **פעם אחת בכל האפליקציה** (toast של מלאי); אפס plugins (‏StatusBar/Keyboard/SafeArea); ‏orientation פתוח בשני ה-platforms; ‏`allowNavigation:[]` יחסום OAuth; ‏splash גנרי של Capacitor; אפס זיהוי native בקוד. ובינתיים Google **כופה** edge-to-edge ללא opt-out ב-targetSdk 36 — שהוא חובת Play מ-**31.08.2026** (עוד 4 ימים) לעדכונים חדשים.
5. שני שברים רוחביים נוספים: ‏**dark-mode שבור-לא-חסר** (משתנה רקע גלובלי מתהפך ל-#0a0a0a בעוד כל התוכן hardcoded בהיר), וה-**זום הנגישות** (CSS `zoom` עד 1.25) מקטין את ה-viewport האפקטיבי ומפיל משתמשים בשקט מ-two-pane של Review/Customers.

**מסקנה: בעיה מערכתית אחת (אין שכבת width/breakpoint משותפת ומאומצת) + שלושה אשכולות משניים (מוצרי phone-frame, ‏overlays מפוצלים, חוזה native), ולא 70 מסכים עצמאיים.**

---

## 2. Route / Screen Inventory

‏~110 routes ב-4 קבוצות (מלא בקוד; כאן התמצית):
- **`(shell)`** ‏(~60): ‏app, ‏attention, ‏collection, ‏content ‏(×22 שלבי wizard), ‏customers ‏(2), ‏documents ‏(9), ‏inbox, ‏inventory ‏(~20), ‏payments ‏(3), ‏secretary, ‏settings/whatsapp, ‏suppliers ‏(2).
- **מחוץ ל-shell אבל עוטפים `ShellChrome` בעצמם**: ‏billing ‏(2), ‏settings ‏(6), ‏tools, ‏business/bot* ‏(6), ‏dashboard, ‏opportunities, ‏pricing, ‏search, ‏coupon-design, ‏offers.
- **בלי שום chrome**: ‏revenue ‏(4), ‏posts, ‏onboarding, ‏upload, ‏test-upload, ‏brand-animation-demo, ‏login/register (מוצדק).
- **‏(corporate)** ‏(6) + **‏(platform-admin)** ‏(4).
- ‏Redirects: ‏offers*/promotions* → ‏/revenue; ‏(shell)/ → ‏/app; ‏revenue/issue → ‏/revenue.
- **קישורים מתים**: ‏/tools מקשר ל-`/collaborations` ו-`/growth` — ‏routes שלא קיימים.

## 3. Desktop Findings (1280/1440/1920 — runtime PROVEN)

ניצול רוחב `main` ב-1920px (מתוך המטריצה): ‏documents-hub ‏600 ‏(31%) · ‏inbox/search/dashboard/accountant/upload ‏760 ‏(40%) · ‏review ‏**1240 ‏(65%) — הטוב במערכת** · ‏inventory-hub ‏520 ‏(27%) · ‏items/supplier-purchases ‏960-קליפה/720-תוכן · ‏payments detail ‏560 בתוך pane של ~1270 · ‏customers detail ‏720 בתוך ~1290 · ‏suppliers ‏720 בלי two-pane (התאום של customers כן קיבל!) · ‏collection ‏720 · ‏attention ‏640 · ‏billing ‏980 · ‏billing/[id] ‏**720 לבונה חשבוניות של 3,300 שורות, אפס `@media`** · ‏settings ‏896-מדורג · ‏bot-settings ‏560 · ‏revenue ‏**480 phone-frame בלי nav** · ‏pricing ‏460-mock · ‏dashboard-legacy ‏325 · ‏/search ו-/upload — ההפך: ‏**אפס container, ‏full-bleed לא מעוצב**.

סיווג A/B/C/D מלא — ‏§16. ‏A אמיתיים: ‏Review ‏(1280+), ‏Inbox צ'אט ‏(two-pane 1280), ‏Customers list-pane, ‏Payments-structure. ‏B לגיטימיים: ‏secretary ‏(reading 760), ‏login/register, ‏content wizard (טופסי), ‏settings. ‏C (‏"Mobile-trapped") — הרוב. ‏D: ‏/search, ‏/upload, ‏/test-upload (לא מעוצבים), וקישורי /tools המתים.

## 4. Tablet Findings (768/1024)

- ‏768: ‏rail ‏76px נכנס — נכון. אבל כמעט אף מסך לא מוסיף עמודה/צפיפות ב-768–1023: זה phone מוגדל. ‏Inbox הוא היחיד עם two-pane כבר מ-769.
- ‏1024: ‏sidebar מלא + ‏Payments two-pane + ‏Documents card→table. ‏Customers מחכה ל-1200, ‏Review ל-1280 — שלושה ספים שונים לאותו רעיון.
- אין master/detail בשום מסך מלאי; ‏720px תקרת-תוכן גם ב-tablet רוחבי.

## 5. Mobile Findings (320/360/390/430)

- ‏**אפס overflow אופקי בכל המסכים בכל הרחבים** — כולל 320px. ‏PROVEN.
- ‏BottomBar עם safe-area-bottom מטופל היטב (30 שימושי `env(...-bottom)`), שריון 100px+inset ב-shell.
- סיכוני mobile שנמצאו: ‏modals מסוג bottom-sheet לעולם לא הופכים לדיאלוג ב-desktop (הפוך מהבעיה אך אותו root cause); ‏`.shell-content` הוא stacking-context ‏z-1 ולכן מודאלים בתוך הדף לא יכולים לצבוע מעל ה-bar — פתרון "שריון 160px" ב-CRM בלבד; מרוץ z-index ‏(100/101/40/2147483000).
- ‏Landscape-phone לא נמדד (מגבלת הרצה) — אבל בהינתן עמודות-מרכז צרות, הסיכון נמוך; מסומן לבדיקה ידנית.

## 6. Inventory Deep Dive

- ‏**Current Desktop ‏(1920)**: ‏viewport ‏1920 → ‏shell מקצה ‏1672 → ‏hub: ‏`.inv-hm-frame{max-width:520px}` ‏(`components/inventory/home/home-styles.ts:30-36`) עם grid פעולות `1fr 1fr` קשיח; תתי-מסכים: קליפה `.inv-subpage-main` ‏`--inv-max-width:960` ‏(`inventory-layout.css.ts:21`) אבל **כל primitive תוכן מקובע מחדש ל-`--inv-content-max:720`** ‏(`inventory-tokens.ts:180`; ‏`.inv-rows`/`.inv-page-content`/`.inv-fwrap`/`.inv-olines` ב-`inventory-primitives.css.ts`). ‏variant ‏`--wide:1080` קיים — אף עמוד לא מפעיל.
- **‏Why**: קבוע מודול יחיד + hub שנכתב mobile-first בלי אף breakpoint. ‏14 מסכי רשימה כלואים בקבוע אחד.
- **‏Correct adaptive**: ‏Desktop — ‏hub כ-dashboard רחב (KPI רצועה + פעולות + טבלת "דורש טיפול"); ‏items כטבלה ‏DataTable ברוחב workspace ‏(1200–1400) עם master/detail לפריט; ‏supplier-purchases כ-worklist+detail. ‏Tablet — שתי עמודות מ-1024. ‏Mobile — הקיים טוב. (עקבי עם ממצא "content-primitives, not jackets" מהאודיט האדפטיבי הקודם.)

## 7. Documents Deep Dive

- **‏Current Desktop**: ‏hub ‏`contentStyle.maxWidth:600` ‏(`components/documents/home/home-styles.ts:39-41`); כל השאר ‏`pageMain 760` ‏(`app/(shell)/documents/ui.ts:113-120` + עותקים מקומיים). **האבסורד המדויק**: ‏inbox בונה טבלת desktop אמיתית ב-≥1024 ‏(`DocumentsInboxScreen.tsx:29-36` → ‏`DocumentsInboxTable`) — ומרנדר אותה לתוך 760px; ‏documents/dashboard מבקש ‏`repeat(auto-fit,minmax(140px,1fr))` בתוך 760 — ה-auto-fit לעולם לא מתרחב.
- **‏Why**: קבוע feature ‏(760) שנולד כרוחב קריאה מובייל ושכפולו לכל המסכים, כולל טבלאות ודשבורדים.
- **‏Correct adaptive**: ‏hub — רוחב standard נדיב (‏~900–1100) עם pulse+פעולות בשתי עמודות; ‏inbox/search — ‏workspace ‏1200–1400 (הטבלה כבר קיימת!); ‏dashboard — ‏wide; ‏upload/accountant/uniform — ‏B לגיטימי ‏(760) ‏; ‏review — כבר נכון ‏(1240@1280), לחקות ממנו.

## 8. Shared Shell / Layout Findings

- ‏`ShellChrome` ‏— תקין ומצוין (‏CSS בלבד, ‏SSR-safe, מקור-ניווט יחיד `nav-destinations`). ‏חסר לו: ‏(א) ‏שום `main` משותף/‏PageContainer; ‏(ב) ‏`padding-inline-end` לא קיים — ה-offset חד-צדדי; ‏(ג) ‏אין טיפול safe-area-top לכותרות.
- שלוש דרכי-עטיפה שונות ל-shell (קבוצת ‏(shell), ‏layout ידני פר-route, וכלום) — ‏revenue אף קורא `useHideShellChrome(true)` בלי shell מעליו (no-op).
- ‏`WorkspaceLayout` ‏(2 צרכנים) ו-`MasterDetailLayout` ‏(1) חופפים ~90%; מסמך ה-DIS-closure הכריז על האיחוד כ-non-requirement וסגר את המערכת ב-~15% אימוץ.

## 9. Responsive Architecture Findings

- ‏Tailwind v4 בלי config (ברירות מחדל) — משמש רק ל-corporate/settings/tools/app-skeleton; כל השאר inline styles ו-`<style>` מוזרק.
- **אין tokens של רוחב/breakpoint באף קובץ theme** (‏documents/billing/bot/crm/tokens) — הסקאלה שה-DIS מפנה אליה לא קיימת.
- ‏9 משפחות breakpoints; ‏3 סולמות רוחב שונים (‏Tailwind ladder ‏448/672/896, ‏inventory ‏720/960/1080, קבועים פר-מסך).
- ‏dark-mode: כלל יחיד ב-`globals.css` מהפך `--background` — והתוכן כולו hardcoded בהיר → מצב חשוך = רקע שחור מאחורי קלפים בהירים. **שבור, וגם רלוונטי ל-Android quality (T-Theme_Support כולל web content).**
- זום נגישות ‏(CSS `zoom` ‏1.1/1.25) מקטין viewport אפקטיבי → מפיל את ספי 1200/1280. אף קוד לא מפצה.

## 10. iOS Findings

- ‏scaffold בלבד (מוצהר בקומיט): ‏`server.url` מ-env ‏(remote WebView), ‏`allowNavigation:[]` ‏(יחסום OAuth redirect בתוך ה-WebView), ‏`contentInset:"always"`, אפס plugins, ‏AppDelegate תבנית, ‏splash גנרי, ‏Info.plist מתיר Portrait+Landscape (בפועל המסכים לא תוכננו ל-landscape).
- ‏safe-area-top לא מטופל ← תחת notch/Dynamic-Island הכותרות ישבו מתחת ל-status bar (הדף היחיד שמטפל: עמוד ה-offline של Capacitor).
- ‏SDK: מאז ‏28.04.2026 חובה לבנות עם Xcode 26/iOS 26 SDK; ‏בנייה עם SDK 26 מבטלת letterboxing על גדלי-מסך חדשים ← ה-web חייב להיות fluid באמת. ‏UIScene יהפוך חובה בגרסה הבאה (התבנית הנוכחית ללא SceneDelegate — שבר מתוזמן).

## 11. Android Findings

- ‏targetSdk 36 חובה ב-Play לעדכונים מ-**31.08.2026** (הארכה אפשרית עד 1.11) ← גורר בכפייה: ‏**edge-to-edge ללא opt-out** (סטטוס-בר/ניווט שקופים, התוכן נמשך מתחתם אלא אם צורכים insets — וה-CSS ‏`env(safe-area-inset-*)` ב-WebView אמין רק מ-M136/M144), ‏`setStatusBarColor` ‏no-op, ‏cutout ‏`never` מתורגם ל-`always`, ‏**predictive back מבטל `onBackPressed`/KEYCODE_BACK** (לוודא גרסת Capacitor עם OnBackInvokedCallback), ‏**נעילת orientation נאכפת-לא על מסכים ≥600dp** (טאבלטים יסובבו בכוח — ה-adaptive הופך הכרחי), ‏IME resize חדש + אזהרת לולאת clear-focus.
- ‏`android:supportsRtl` ברירת מחדל **false** — לוודא במניפסט (דיאלוגים native/גלילה עבריים).
- ‏Manifest נוכחי: ‏INTERNET בלבד, בלי screenOrientation, בלי אף plugin ‏(`capacitor.build.gradle` ריק).

## 12. Store — Mandatory (מקורות רשמיים; ‏URLs בדוח המחקר המלא)

| # | דרישה | מקור |
|---|---|---|
| M1 | ‏Apple 4.2 Minimum Functionality — ‏wrapper בלי יכולות native/ערך app-like נדחה | ‏developer.apple.com/app-store/review/guidelines |
| M2 | ‏Apple 2.1 — חשבון דמו עובד לביקורת (הכשל הנפוץ באפליקציות עסקיות בעברית) | שם |
| M3 | ‏Apple 2.5.2 — קוד מרוחק שמשנה התנהגות; זהירות עם OTA-bundle | שם |
| M4 | ‏iOS 26 SDK חובה מ-28.04.2026 + ביטול letterboxing | ‏developer.apple.com/news/upcoming-requirements |
| M5 | ‏Play targetSdk 36 מ-31.08.2026 | ‏support.google.com/googleplay/android-developer/answer/11926878 |
| M6 | ‏Android 15/16 edge-to-edge כפוי + insets (פירוט ‎§11) | ‏developer.android.com/about/versions/16/behavior-changes-16 |
| M7 | ‏Play Webviews policy — מותר לעטוף רק אתר בבעלותך (אנחנו בסדר; להחזיק הוכחת בעלות) | ‏answer/9899034 |
| M8 | ‏Android vitals ‏(crash ‏1.09%/ANR ‏0.47%) — השלכות חשיפה | ‏answer/9844486 |
| M9 | ‏Apple age-rating questionnaire ‏(מ-31.01.2026) | ‏upcoming-requirements |

## 13. Store — Recommendations (רשמיות, לא חוסמות)

‏iPad אינו חובה לאפליקציית iPhone ‏(2.4.1 ‏"should"); ‏44pt ‏(Apple design tips) ו-48dp ‏(Android Core Quality) — הנחיות איכות; ‏Apple Accessibility Nutrition Labels — וולונטרי היום, הוכרז שיהפוך חובה (‏"Larger Text 200%" הוא הרף לתכנון); ‏Android Large-Screen Tier-3 — המלצה, אבל בשילוב M6+ביטול נעילת-orientation היא דה-פקטו הכרחית ‏≥600dp; ‏dark-theme לתוכן web ‏(T-Theme_Support); ‏RTL — הנחיות בלבד בשתי החנויות.

## 14. Accessibility Findings

- ‏FAB זום קיים (טוב) אבל מנגנון ה-zoom שובר breakpoints ‏(§9) ויושב בפינה קבועה גם ב-desktop בלי bar.
- אין contentDescription-סריקה שנעשתה כאן (מחוץ ל-scope הריצה); ‏label-ים לחנות עתידיים ידרשו הצהרות ‏VoiceOver/Larger-Text/Contrast — לתכנן.
- ‏touch-targets: לא נמדד אוטומטית; מהצילומים כפתורי הליבה גדולים; לסמן לבדיקת המשך.

## 15. RTL Findings

- ‏RTL עקבי ומצוין ב-web ‏(dir="rtl", ‏inline-start בכל ה-shell). סיכונים: ‏`android:supportsRtl` ‏(‎§11), ‏FAB בצד "שמאל" קבוע, וקבצי inline-style עם left/right ספורדיים — לא נמצאו שברים ב-runtime.

## 16. Full Screen Matrix (תמצית; ‏PASS=A, ‏MINOR=B-כמעט, ‏MAJOR=C, ‏BLOCKER=D/native)

| Screen(s) | Desktop | Tablet | Mobile | Native risk | Sev | Root cause |
|---|---|---|---|---|---|---|
| documents/review | PASS | PASS | PASS | top-inset | MINOR | — |
| inbox (צ'אט) | PASS | PASS | PASS | top-inset, ‏IME | MINOR | — |
| customers (list+detail) | PASS/MINOR ‏(detail ‏720) | MINOR | PASS | top-inset | MINOR | RC-2 |
| payments | MINOR ‏(detail ‏560) | MINOR | PASS | top-inset | MINOR | RC-2 |
| documents hub/inbox/search/dashboard/accountant/email/uniform | **MAJOR** ‏(600–760) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| inventory hub | **MAJOR** ‏(520) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| inventory ‏~18 מסכים | **MAJOR** ‏(720) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| suppliers ‏(2) | MAJOR ‏(720, בלי two-pane) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| collection / attention | MAJOR ‏(720/640) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| ‏/app ‏(home) | **MAJOR** ‏(480, אפס mq) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| billing hub / billing/[id] | MAJOR ‏(980/720, אפס mq בבילדר) | MAJOR | PASS | top-inset | MAJOR | RC-2 |
| revenue + redeem + coupons/[id] | **MAJOR** ‏(phone-frame 480, בלי nav) | MAJOR | PASS | top-inset | MAJOR | RC-3 |
| pricing / posts / onboarding / dashboard-legacy | MAJOR ‏(460–560/500/325) | MAJOR | PASS | top-inset | MAJOR | RC-3/‏RC-4 |
| settings ×6 / tools / bot-settings ×6 | MINOR ‏(896-ladder / 560) | MINOR | PASS | top-inset | MINOR | RC-2 |
| content wizard ×22 | B-מוצדק ‏(600–900) אך אחיד-קשיח | MINOR | PASS | top-inset | MINOR | RC-2 |
| secretary | B ‏(reading 760) | PASS | PASS | top-inset | PASS | — |
| ‏/search, ‏/upload, ‏/test-upload | **BROKEN** ‏(full-bleed לא מעוצב) | BROKEN | BROKEN | — | MAJOR | RC-4 |
| ‏/tools→collaborations/growth | קישורים מתים | — | — | — | MINOR | RC-4 |
| **כל האפליקציה ב-native** | — | — | — | **BLOCKER-cluster** ‏(§10-11) | **P0** | RC-6 |

## 17. Root-Cause Clusters

- **‏RC-1 — אין שכבת width/breakpoint ב-DS, וה-primitives מתים**: ‏`PageContainer`+`useBreakpoint` ‏0 צרכנים; ‏160 ‏maxWidth-ים; ‏9 משפחות breakpoints; אין tokens. *זה ה-root cause המערכתי.*
- **‏RC-2 — "desktop shell סביב תוכן בצורת טלפון"**: קבועי-feature צרים ‏(760/720/640/560/520/480) שהוחלים גם על טבלאות/דשבורדים; כולל "ה-jacket" — ‏two-pane נכון שהעלה נשאר צר ‏(payments 560, ‏customers-detail 720).
- **‏RC-3 — מוצרי Phone-Frame בכוונה**: ‏revenue/coupon ‏(PhoneFrame 480 + הסתרת nav), ‏pricing ‏(460 mock) — החלטת עיצוב ישנה שסותרת את דרישת המוצר.
- **‏RC-4 — פרגמנטציית קבוצות-routes ושאריות**: שלוש דרכי-shell; דפים בלי chrome; ‏/search+/upload לא מעוצבים; קישורים מתים; ‏redirect-ים כפולים.
- **‏RC-5 — ‏overlays בלי primitive משותף**: ‏bottom-sheets נצחיים, מרוץ z-index, ‏stacking-context שמכריח "שריון 160px".
- **‏RC-6 — חוזה native לא מטופל**: ‏safe-area-top יחיד, אפס plugins, ‏orientation פתוח (וגם ייאכף-לא בטאבלטים), ‏allowNavigation ריק, ‏edge-to-edge כפוי בפתח, ‏predictive-back, ‏splash גנרי, אפס זיהוי native.
- **‏RC-7 — סתירות רוחביות**: ‏dark-mode שבור-חצי; זום-נגישות מפיל breakpoints.

## 18. Priorities

- **‏P0 (חוסמי store/שמישות)**: ‏RC-6 כולו — ‏insets ‏(top+bottom) ל-edge-to-edge, ‏plugins בסיס ‏(StatusBar/Keyboard), ‏predictive-back, ‏supportsRtl, ‏allowNavigation ל-OAuth, ‏targetSdk 36, ‏splash ממותג, חשבון דמו לביקורת Apple; ‏+ תיקון dark-mode המשתנה-הגלובלי (שבר ויזואלי אמיתי למשתמשי דארק).
- **‏P1 (בעיות adaptive מרכזיות)**: ‏RC-1 (שכבת tokens+container) ואימוצה באשכולות הגדולים: ‏Documents ‏(hub+inbox+dashboard), ‏Inventory ‏(hub+720-cap), ‏home ‏/app, ‏payments-detail/customers-detail, ‏suppliers=customers, ‏billing/[id]; ‏+ החלטת מוצר ל-RC-3 ‏(revenue).
- **‏P2 (עקביות)**: איחוד breakpoints ל-3 ספים, ‏WorkspaceLayout⇄MasterDetail איחוד, ‏overlay primitive אחד ‏(sheet<640→dialog), זום-נגישות שלא שובר ספים ‏(rem-based במקום zoom), ‏content-wizard ליישור.
- **‏P3 (פוליש)**: ‏/search+/upload החלפה/מחיקה, קישורים מתים, ‏z-index scale, ‏FAB מיקום desktop, ‏landscape-phone בדיקות.

## 19. Proposed Remediation Architecture

1. **‏DS Layout Layer (התשתית שחסרה)**: ב-`lib/design/tokens.ts` — ‏`breakpoints {tablet:768, desktop:1024, workspace:1280}` ‏+ ‏`pageWidth {form:560, reading:760, standard:960, workspace:1280, full}`; להחיות את `PageContainer` כצרכן היחיד של הסקאלה.
2. **‏Container adoption במקום 160 קבועים**: מיגרציה פר-אשכול (לא פר-מסך): ‏documents→standard/workspace; ‏inventory→להחליף `--inv-content-max` ברוחב-role; ‏home/app→standard; ‏settings/bot→form; זה מכסה ~40 מסכים בשינויים ספורים.
3. **‏Content-primitives, לא jackets** (ממצא האודיט הקודם נשאר תקף): ‏DataTable-ברוחב-מלא לרשימות; ‏master/detail ל-inventory items ול-suppliers (השכפול מ-customers כבר קיים בקוד).
4. **‏Native Foundation Wave**: ‏safe-area top ב-`ShellChrome` ‏(שכבת header) + הרחבת ‏bottom; ‏plugins ‏StatusBar/Keyboard; ‏edge-to-edge insets ‏(native-zeroing או CSS לפי גרסת WebView); ‏predictive-back; ‏supportsRtl; ‏allowNavigation; ‏splash; ‏targetSdk; ‏util ‏`isNative()`.
5. **‏AdaptiveDialog primitive** אחד + סולם z-index tokens.
6. **החלטת מוצר ל-Revenue/Coupons**: ‏Marketing Center כ-workspace אמיתי (ה-preview הטלפוני נשאר כרכיב בתוךו) — דורש עיצוב, לא רק CSS.

## 20. Recommended Implementation Order

**(1)** ‏Native Foundation ‏(P0; בלוק אחד, לפני הגשה לחנויות ולפני 31.08 ל-targetSdk) → **(2)** ‏DS Layout Layer ‏(tokens+PageContainer) → **(3)** ‏Documents cluster ‏(hub/inbox/dashboard — הטבלה כבר קיימת, ‏ROI מיידי) → **(4)** ‏Inventory cluster ‏(720-cap+hub) → **(5)** ‏home ‏/app → **(6)** ‏detail-panes ‏(payments/customers) + ‏suppliers-two-pane → **(7)** ‏billing/[id] two-pane → **(8)** ‏dark-mode fix + זום-נגישות → **(9)** ‏overlay primitive + ‏breakpoint unification → **(10)** ‏Revenue redesign (אחרי החלטת מוצר) → **(11)** ‏P3 ניקיונות.

---

*נספחים: מטריצת runtime מלאה + צילומי מסך — ‏scratchpad/ui-audit; דוח מקורות החנויות המלא עם כל ה-URLs — בפלט סוכן המחקר (משוקף ב-§10–§13); טבלת רוחב פר-route מלאה (~110 שורות) — בפלט סוכן הסריקה, זמינה להעברה לקובץ נפרד לפי בקשה.*
