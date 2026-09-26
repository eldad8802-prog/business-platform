# Desktop UX Phase 2 — surface matrix

Living inventory for the desktop composition reconstruction. This file is the
master list so screens are not dropped between pull requests.

Classification:

- **DESKTOP-ADAPTED** — desktop composition was redesigned for the task. Still
  needs runtime visual QA at 390 / 768 / 1024 / 1280 / 1440 / 1600 / 1920
  before it can be called done.
- **INTENTIONALLY-FOCUSED** — the page is a short reading-width task and the
  surrounding canvas is not an empty mockup. Not yet visually signed off.
- **REMAINING** — still a mobile or tablet composition on a desktop canvas, or
  not yet inspected as a user surface.

Breakpoints stay: mobile `<768`, tablet `768–1199`, desktop `≥1200`, wide
`≥1600` where a real task uses the extra width. No backend, schema, or
authority changes.

## This slice

| Surface | Route | State | Desktop problem | Proposed composition | Action |
| --- | --- | --- | --- | --- | --- |
| Customers, no selection | `/customers` | empty detail | narrow list, blank canvas | wider master + what the card contains | DESKTOP-ADAPTED |
| Customers, selected | `/customers/[id]` | selected card | list was 380px | master widens at 1440 / 1800; card stays the work pane | DESKTOP-ADAPTED |
| Leads, no selection | `/leads` | empty detail | same as customers | same desk pattern | DESKTOP-ADAPTED |
| Leads, selected | `/leads/[id]` | selected card | same | same | DESKTOP-ADAPTED |
| Suppliers, no selection | `/suppliers` | empty detail | same | same | DESKTOP-ADAPTED |
| Suppliers, selected | `/suppliers/[id]` | selected card | same | same | DESKTOP-ADAPTED |
| Collection inbox | `/collection` | queue | 760 column in a large page | sticky summary + work queue | DESKTOP-ADAPTED |
| Collection thread | `/collection/c/[customerId]` | timeline | 680 column | customer summary + payment history | DESKTOP-ADAPTED |
| Accountant pack | `/documents/accountant-pack` | configure / export | centered form | period and categories beside package summary and export | DESKTOP-ADAPTED |
| Secretary home, populated | `/secretary` | due / new | centered card stack | status beside today's obligations | DESKTOP-ADAPTED |
| Secretary home, empty setup | `/secretary` | first-run | would become a fake dashboard | stays a 640 setup column | INTENTIONALLY-FOCUSED |
| Billing hub | `/billing` | list + create | 980 column | create actions beside the document archive | DESKTOP-ADAPTED |
| Inventory data lists | inventory `data` intent | lists | 1280 cap on wide screens | workspace width from 1600 | DESKTOP-ADAPTED |

## Still remaining

These were found in the route crawl and are not closed by this slice. Each one
still needs a first-principles desktop composition, then visual QA.

| Domain | Surfaces still open |
| --- | --- |
| Home / app | `/`, `/app` |
| Documents | hub, search populated workspace, upload, inbox, review, email, uniform export, dashboard beyond the existing report grid |
| Inventory | home control desk beyond the current band, items, item detail, alerts, unmatched, count, drafts, sales, supplier purchases and their create / cart / confirm / receive / send / import states |
| Collection | `/collection/new` |
| Payments | `/payments`, `/payments/new` |
| Billing | document detail `/billing/[id]`, create modal, issue flow |
| Secretary | obligation detail and other secretary routes beyond the home desk |
| Payables | list, detail, cheques, bank, match |
| Settings | settings hub, WhatsApp |
| Search | `/search` |
| Attention | `/attention` is still a card list (two columns is not a work queue) |
| Opportunities / offers | offer creation and related routes |
| Business / bot | `/business`, `/business/bot-settings` |
| Content studio | the phone-shell wizard routes; desktop may become configuration beside preview without collapsing confirmation steps |
| Inbox / notifications | `/inbox`, `/notifications` |
| Tools | tools entry if it is only a launcher into billing |

## Runtime QA for this slice

Captured with a local app and mocked `/api` responses (no production database).
Evidence: `qa-evidence/desktop-ux-phase-2/`.

Viewports: 390, 768, 1024, 1280, 1440, 1600, 1920 where the composition changes.
Horizontal overflow: none in the captured set.

Fixes after the first look:

- Collection inbox: portfolio counts beside a collection table. Mobile keeps the cards.
- Collection thread: open invoice beside a payment-history table. Mobile keeps the cards.
- Secretary with obligations: the real obligations sit beside today's status. First-run setup stays a focused column.
- Inventory items from 1600: minimum, reorder, cost, and sell price are their own columns.
- Accountant pack from 1600: the configuration stays a readable width and the package summary uses the rest of the workspace.
- CRM with nothing selected: the detail pane is three workspace regions (contact, documents, activity), not a sentence in an empty canvas.

## Counts for this slice only

These counts are the slice, not the product.

- Surfaces touched in this slice: 13
- Classified DESKTOP-ADAPTED in this slice: 12
- Classified INTENTIONALLY-FOCUSED in this slice: 1
- Remaining: every surface in the table above, plus states inside those flows
- Runtime screenshot QA: not done yet
- Production merge: not requested
