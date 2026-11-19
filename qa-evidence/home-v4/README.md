# HOME v4 — visual evidence

Screens rendered from the **real components** (ShellChrome, the floating BottomBar, HomeV4 with its real data hook
`useHomeV4Data`, MyToolsScreen, MoreCapabilitiesScreen, the create sheet) against a **mocked `fetch`**. Every state is a
synthetic API world defined in `harness/entry.tsx`. No database and no Production data were used. The clock is fixed
at 09:00 Israel time. Viewport 390×844 @2x unless named otherwise.

Reproduce from the repo root: `node qa-evidence/home-v4/harness/build.mjs && node qa-evidence/home-v4/harness/shoot.mjs`

| File | What it shows |
|---|---|
| `01-hero.png` / `01-hero-full.png` | The reference image on real-shaped data (service business: ₪12,450 this month, 8 open calls, 2 enquiries, 11:30 meeting, 3 quotes) |
| `02-state-A.png` | A: brand-new business. Real ₪0 / 0 with "not yet" notes, a first action ("הוספת לקוח"), a compact empty day, and an intro to a tool the business already has |
| `02-state-B.png` | B: limited plan (documents + inbox only). Metrics fit the available modules; no day card (no calendar/tasks), no empty cards |
| `02-state-C.png` | C: service & repairs. Open calls metric; overdue payments lead the secretary |
| `02-state-D.png` | D: customers, leads, meetings (no service desk). Enquiries metric and quotes; no service data |
| `02-state-E.png` | E: very busy, broad plan. Still 2 metrics, 1 recommendation, 1 upcoming item, 1 smart item; capped counts read "N+" |
| `02-state-F.png` | F: active business, nothing planned today. Compact empty day |
| `02-state-G.png` | G: nothing waiting and every source answered. Calm secretary |
| `02-state-H.png` | H: receipts, briefing and calendar fail. "לא נטען · נסו שוב" (never ₪0); the rest keeps working |
| `02-state-loading.png` | First load. Skeletons, no numbers |
| `02-state-capsfail.png` | Capabilities unreadable. Everything module-bound fails closed |
| `03-tools-limited.png` / `03-tools-broad.png` | "הכלים שלי": direct grid (7 tools) vs favourites + search + non-empty categories (15 tools) |
| `03-more-limited.png` | "יכולות נוספות": capabilities that are not active, informational only (no upgrade button) |
| `04-size-*.png` | 320 / 430 phones, 820 tablet (rail), 1440 desktop (sidebar) |
| `05-scroll-*.png` | The floating bar at the top, middle, bottom and after scrolling back up |
| `06-create-sheet-*.png` | "+" per plan: broad, limited (4 actions), booking business (appointment first) |
| `07-*.png` | More metrics expanded, metric chooser, secretary after "לא רלוונטי", For-you menu |
| `report.json` | Per screen: areas drawn, console errors (all 0), API requests made; bar geometry; sheet scroll check |

Floating-bar measurements (`report.json → floatingBar`), identical at every scroll position:

- `position: fixed`, 10px above the bottom edge (plus the safe area), 12px from each side, 64px tall.
- The "+" centre is (195, 802). The bar centre is (195, 802), so the "+" is centred on both axes.
- The "+" top is at 778 and the bar top at 770, so the "+" does not rise above the bar.
- The last card ends at 736, above the bar top at 770, so the bar hides nothing.
- Opening and closing "+" keeps the scroll position (180 → 180).

## Device profiles: `devices/` (emulation, NOT real phones)

Reproduce with `node qa-evidence/home-v4/harness/build.mjs && node qa-evidence/home-v4/harness/devices.mjs`. All checks passed in 3 of 3 runs; per-check values are in `devices/devices-report.json`.

| Profile | Engine | Safe area (bottom) |
|---|---|---|
| iPhone SE (3rd gen), 375×667 | WebKit | 0 (WebKit cannot simulate insets) |
| iPhone 15 Pro Max, 430×739 | WebKit | 0 (WebKit cannot simulate insets) |
| iPhone 15 Pro Max size, rendered by Chromium | Chromium | 34px home indicator (CDP `setSafeAreaInsetsOverride`) |
| Pixel 7, gesture navigation | Chromium | 24px |
| Galaxy S9+, button navigation | Chromium | 0 |

Each profile checks the following:
- The bar stays fixed and visible at the top and the bottom of the page.
- The bar is lifted exactly 10px plus the safe area.
- The "+" is centred within 1px on both axes and does not rise above the bar.
- The last card clears the bar.
- There is no sideways scroll.
- The create sheet opens with its last action above the safe area, and closes without moving the page.
- The console shows no errors.

## Real app (CI, not the harness)

`.appt/ui-e2e.mts` (workflow "calendar — the real app in a browser") runs `next build` + `next start` against a seeded PG17 lab business. Its artifact `appointments-calendar-screens` holds:
- `m00-phone-home*.png`: HOME v4 at 390px. The check requires the three fixed areas, a bar lifted off the edge, and no sideways scroll.
- `m08-phone-plus-sheet.png`: the real "+" sheet, waited for by its own dialog. Closing it must not move the page.
- `m01-phone-day.png`: the floating bar on /calendar. M8 now finds the bar by `data-component`. It used to look for a nav touching the bottom edge, which a floating bar never does.

## Hebrew dictionary weight

From the CI artifact `i18n-en-chunk-proof`, first visit with an empty cache. Weights are raw JS.

| Route | Before (main) | After (branch) |
|---|---|---|
| /app | 1058 KB | 1051.5 KB (the old Home code is gone) |
| /collection | 1026.9 KB | 1032.9 KB |
| /login (the whole flow) | 2003.3 KB | 2004.7 KB |

Each route grows by at most one copy of the new home strings (≈8.3 KB raw, ≈2.3 KB br), so there is no double load. Hebrew pages carry 0 English strings. The brotli deltas (+2.6–5.1 KB) are larger than the raw ones because the files are re-chunked differently. The owner accepted this weight on 11-19.

## Tablet and desktop: `widths/` (owner 11-19)

The four areas, their order and their content are the same at every width; only the arrangement changes. A wider screen never shows more information. Reproduce with `node qa-evidence/home-v4/harness/widths.mjs`; the numbers are in `widths/widths-report.json`.

| Width | Navigation (from the shell; exactly one visible) | Home layout |
|---|---|---|
| < 768 (phone) | the floating bottom bar | the approved single column, **unchanged** (identical bar, "+", page height and areas to the previous run) |
| 768–899 (portrait tablet) | the rail: בית · יומן · + · עדכונים · כלים | one wider column (max 680px) |
| 900–1279 (landscape tablet) | the rail | two columns: תמונת מצב across the top, then המזכירה שלי beside היום שלי, then בשבילך below |
| ≥ 1280 (desktop) | the sidebar on the right (RTL) | three columns: the main pair holds תמונת מצב over המזכירה שלי; the side column holds היום שלי over בשבילך; max 1480px |

- The sidebar's top section is now the same fixed actions as the bar: בית · יומן · עדכונים · כלים, with "פעולה חדשה" as the "+". It uses the bar's short labels, and יומן resolves as on the phone.
- שיחות and מסמכים left the sidebar's top section; they lead the tools screen. A primary action is not repeated in the module groups below it.
- When בשבילך has nothing true to show, the grid closes the gap. On desktop היום שלי then keeps its own height.
- The widest card: 623px at 1280, 729px at 1440, 932px at 1920. Before this change cards reached 1104–1408px.
- The tools screens ("הכלים שלי", "יכולות נוספות") use a wider column on ≥1024. The tile grid has 5 columns at 1024 and 7 at 1440/1920; the phone keeps 2.
- Checked:
  - states E (busy), A (new), B (few capabilities) at every width; G (no secretary items), H (partial failure) and loading at 1024/1440/1920;
  - a live resize 390 → 1920 → 390: the nav swaps at 768 and 1280, the columns change at 900 and 1280, and the area order stays the same;
  - no sideways scroll and 0 console errors anywhere;
  - keyboard Tab order at 1440: the header, then תמונת מצב, המזכירה שלי, היום שלי, בשבילך, then the navigation.

## Fixed 11-19: two screens measured the old bar's height

The floating bar is lifted 10px plus the safe area, so its own height (64px) is less than the space it covers (74px + safe area). The old bar's height already included the safe area. Two existing components used the bar's own height:

| Component | Effect with the old measurement | Fix |
|---|---|---|
| **The accessibility button** (`components/ui/accessibility/accessibility-fab.tsx`) | It sat at 64 + 12 = 76px. With a 34px home-indicator inset the bar spans 44–108px, so the button **overlapped the bar by about 32px** (iPhone, Android gesture navigation). | Both now measure from the window's bottom edge to the bar's top. |
| **The inventory action footer** (`components/inventory/v2/kit.tsx`) | It docked at 64px and slid 10px + the safe area behind the bar. | Same measurement. |

The device pass now checks `accessibilityButtonClearsBar` on every profile. The button sits 12px above the bar with 0, 24 and 34px insets. The harness mounts the real button, as `app/layout.tsx` does.

The same CI artifact (the i18n proof) showed `--i2-nav-h: 84px → 64px` on /inventory. That is how this was found.
