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
