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

## Documents slice

There is no separate document-detail route. Review is the decision surface.
WhatsApp ingestion opens `/settings/whatsapp`, which stays in the Settings domain.

| Surface | Route | State | Desktop composition | Action |
| --- | --- | --- | --- | --- |
| Documents hub | `/documents` | empty | intake, stations, and an empty list with a selection prompt | DESKTOP-ADAPTED |
| Documents hub | `/documents` | populated | month counts, intake, stations, document table | DESKTOP-ADAPTED |
| Documents hub | `/documents` | selected | table beside the selected document, then open review | DESKTOP-ADAPTED |
| Search | `/documents/search` | empty | persistent filters and an empty result pane | DESKTOP-ADAPTED |
| Search | `/documents/search` | populated | filters, comparison table, selection pane | DESKTOP-ADAPTED |
| Search | `/documents/search` | selected | row context and open action stay beside the table | DESKTOP-ADAPTED |
| Inbox | `/documents/inbox` | empty | month queue with a pending count and an empty inspector | DESKTOP-ADAPTED |
| Inbox | `/documents/inbox` | pending review | queue table beside the selected-document inspector | DESKTOP-ADAPTED |
| Inbox | `/documents/inbox` | selected | extracted fields visible; approval stays on the review screen | DESKTOP-ADAPTED |
| Review | `/documents/review/[id]` | review flow | source preview beside extracted fields and approve / correct actions | DESKTOP-ADAPTED |
| Gmail ingestion | `/documents/email` | disconnected | connect action beside what the connection does | DESKTOP-ADAPTED |
| Gmail ingestion | `/documents/email` | connected | account state beside the attachment table and import actions | DESKTOP-ADAPTED |
| Upload | `/documents/upload` | empty | dropzone beside a real empty queue | DESKTOP-ADAPTED |
| Upload | `/documents/upload` | populated | dropzone beside pending and recent documents | DESKTOP-ADAPTED |
| Reports | `/documents/dashboard` | empty | period controls beside the empty report | DESKTOP-ADAPTED |
| Reports | `/documents/dashboard` | populated | period beside summary, chart, and category breakdown | DESKTOP-ADAPTED |
| Uniform export | `/documents/uniform-export` | configure | date range beside the real ZIP contents and generate action | DESKTOP-ADAPTED |
| Accountant pack | `/documents/accountant-pack` | configure / export | unchanged from the previous slice; rechecked at 1280 / 1600 / 1920 | DESKTOP-ADAPTED |

No Documents surface in this slice is INTENTIONALLY-FOCUSED. None of these routes remain NOT YET DONE.

## Still remaining

These were found in the route crawl and are not closed by this slice. Each one
still needs a first-principles desktop composition, then visual QA.

| Domain | Surfaces still open |
| --- | --- |
| Billing | document detail `/billing/[id]`, create modal, issue flow |
| Secretary | obligation detail and other secretary routes beyond the home desk |
| Payables | list, detail, cheques, bank, match |
| Settings | settings hub, WhatsApp |
| Inbox | `/inbox` conversations |
| Opportunities / offers | offer creation and related routes |
| Business / bot | `/business`, `/business/bot-settings` |
| Content studio | the phone-shell wizard routes; desktop may become configuration beside preview without collapsing confirmation steps |
| Tools | tools entry if it is only a launcher into billing |

## Slice 3 — inventory operations, collection create, payments

Desktop is a work queue plus a selected record. Mobile keeps the cards. Confirmation that changes stock or creates a payment request stays an explicit action.

| Domain | Surface | Route | State | Desktop composition | Status |
| --- | --- | --- | --- | --- | --- |
| Inventory | Home | `/inventory` | populated | attention table and selected item beside health, value, and actions | DESKTOP-ADAPTED |
| Inventory | Home | `/inventory` | empty | quick actions beside the empty-stock guidance | DESKTOP-ADAPTED |
| Inventory | Home | `/inventory` | item selected | selected item context and open action | DESKTOP-ADAPTED |
| Inventory | Alerts | `/inventory/alerts` | queue / empty / selected | filterable table and the resolve action for the selected alert | DESKTOP-ADAPTED |
| Inventory | Drafts | `/inventory/drafts` | no selection / selected | decision queue; approve and merge stay on a confirmation sheet | DESKTOP-ADAPTED |
| Inventory | Unmatched sales | `/inventory/unmatched` | no selection / selected | sale evidence beside link, create, or reject | DESKTOP-ADAPTED |
| Inventory | Sales | `/inventory/sales` | pending POS | unmatched sales table and a link into the decision screen | DESKTOP-ADAPTED |
| Inventory | Supplier purchases | `/inventory/supplier-purchases` | list / selected | order table, lines, supplier, and receive when quantity is still open | DESKTOP-ADAPTED |
| Inventory | Purchase intake | `/inventory/supplier-purchases/pending` | selected draft | line match decisions beside the queue; cancel still needs a second press | DESKTOP-ADAPTED |
| Inventory | Purchase history | `/inventory/supplier-purchases/history` | selected | past order lines in the inspector | DESKTOP-ADAPTED |
| Inventory | New order | `/inventory/supplier-purchases/new` | browse | product table and the current cart; cart and confirm stay later steps | DESKTOP-ADAPTED |
| Inventory | Order cart | `/inventory/supplier-purchases/new/cart` | lines | quantity and cost table; continue still goes to confirmation | DESKTOP-ADAPTED |
| Inventory | Order confirm | `/inventory/supplier-purchases/new/confirm` | review | line totals beside the supplier; the send dialog stays | DESKTOP-ADAPTED |
| Inventory | Receive | `/inventory/supplier-purchases/[id]/receive` | count | received lines beside the intake summary; posting still confirms | DESKTOP-ADAPTED |
| Inventory | Send | `/inventory/supplier-purchases/[id]/send` | ready | order lines beside share, PDF, and intake | DESKTOP-ADAPTED |
| Inventory | Import | `/inventory/supplier-purchases/import` | file | file picker beside the rule that import creates drafts, not stock | DESKTOP-ADAPTED |
| Inventory | Integrations | `/inventory/supplier-purchases/integrations` | connections | connection list beside what each connection actually does | DESKTOP-ADAPTED |
| Inventory | Stock count | `/inventory/count` | empty session | scan action, the rule for unscanned items, and a progress rail | DESKTOP-ADAPTED |
| Inventory | Count sheet | `/inventory/count` | products counted | expected, counted, and delta table; save stays explicit | DESKTOP-ADAPTED |
| Inventory | Create item | `/inventory/items/create` | form | two-column fields and a live summary of what will be saved | DESKTOP-ADAPTED |
| Inventory | Create sale | `/inventory/sales/create` | search / cart | product search beside the cart | DESKTOP-ADAPTED |
| Inventory | Item detail | `/inventory/items/[id]` | item | identity and stock beside details and movement history | DESKTOP-ADAPTED |
| Inventory | Items list | `/inventory/items` | list | unchanged from slice 1 | DESKTOP-ADAPTED |
| Inventory | Barcode camera | count and create item | scanner open | a camera capture stays on the barcode; it is not a dashboard | INTENTIONALLY-FOCUSED |
| Collection | Create | `/collection/new` | entry | customer picker beside what must be seen before a request exists | DESKTOP-ADAPTED |
| Collection | Create | `/collection/new` | customer and invoice | open invoices beside amount, partial-payment note, and the create button | DESKTOP-ADAPTED |
| Collection | Create | `/collection/new` | validation | over-invoice amount keeps the create button disabled | DESKTOP-ADAPTED |
| Collection | Create | `/collection/new` | configured | amount and invoice stay visible together before submit | DESKTOP-ADAPTED |
| Collection | Create | `/collection/new` | not ready | setup blockers stay a single task until collection can run | INTENTIONALLY-FOCUSED |
| Payments | Overview | `/payments` | redirect | the route opens the collection inbox, already a desktop queue | DESKTOP-ADAPTED |
| Payments | New request | `/payments/new` | redirect | opens `/collection/new` with the same customer or invoice query | DESKTOP-ADAPTED |
| Payments | Legacy request | `/payments/[id]` | redirect | resolves the customer and opens that financial thread | INTENTIONALLY-FOCUSED |
| Payments | Thread | `/collection/c/[customerId]` | pending / failed / paid | history table; the selected event keeps share, cancel, retry, and refund | DESKTOP-ADAPTED |

No inventory, collection-create, or payments surface in this slice is NOT-YET-DONE.

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

## Documents runtime QA

Evidence: `qa-evidence/desktop-ux-phase-2/documents/`. Mocked `/api` only.
Viewports: 390, 768, 1024, 1280, 1440, 1600, 1920.
States: empty, populated, pending review, selected row, review flow, Gmail connected and disconnected.
Horizontal overflow: none.

Fixes after the first look:

- The hub capture card was still placed by the 1024 grid, so it covered the counts and the table. It now sits in its own column beside the work area.
- Uniform export's generate button lived in a fixed bar under the mobile navigation. The action now sits in the package-contents card, on every width.

## Slice 3 runtime QA

Evidence: `qa-evidence/desktop-ux-phase-2/inventory/`, `collection-create/`, and `payments/`.
Mocked `/api` only. No collection request was submitted and no provider was called.
Viewports represented: 390, 768, 1024, 1280, 1440, 1600, 1920.
Horizontal overflow in the captured set: none.

The first pass of `/collection/new` and `/payments` was taken while Next was still compiling, so those frames were reshot after the page text was present. A later pass added import, integrations, send, receive, the order cart and confirmation, the count sheet after a manual barcode, collection blockers, and the payments overview after the `/payments` redirect. No order, receipt, or collection request was submitted. Horizontal overflow in that pass: none.

Cart and confirmation keep the mobile sticky action bar. From 1200 the lines sit beside the cart summary or the supplier and send action, and the send dialog stays a separate confirmation.

## Slice 4 — home, attention, notifications, search

These four surfaces share one vocabulary. Home shows what is waiting and what came in. Attention is the business-status decision queue. Notifications say what happened and whether it was read. Search finds a financial record. Obligations stay on the Secretary; Attention does not copy them.

Search limitation: `GET /api/search` matches vendor and category on financial records only. Customers, inventory, obligations, and settings are not in that index, and this slice does not add a search backend.

| Domain | Surface | Route | State | Desktop composition | Status |
| --- | --- | --- | --- | --- | --- |
| Home | Redirect | `/` | forward | opens the home desk; there is no second home | INTENTIONALLY-FOCUSED |
| Home | Desk | `/app` | sparse / calm | money context beside a calm line, then the three work entries | DESKTOP-ADAPTED |
| Home | Desk | `/app` | busy | waiting queue beside collection, overdue, and the month | DESKTOP-ADAPTED |
| Home | Load failure | `/app` | error | one retry; a failed read is not filled with a desk of zeros | INTENTIONALLY-FOCUSED |
| Attention | Queue | `/attention` | empty | what the queue is for, with no invented items | DESKTOP-ADAPTED |
| Attention | Queue | `/attention` | one / mixed / selected | domain filter, table, and the selected item's own action | DESKTOP-ADAPTED |
| Notifications | Centre | `/notifications` | empty / unread / mixed / selected | what happened, read state, and a compact open action | DESKTOP-ADAPTED |
| Search | Records | `/search` | recent / none / one / mixed / keyboard | query, direction, grouped results, and the selected record | DESKTOP-ADAPTED |

No home, attention, notification, or search surface in this slice is NOT-YET-DONE.

## Slice 4 runtime QA

Evidence: `qa-evidence/desktop-ux-phase-2/home/`, `attention/`, `notifications/`, and `search/`.
Mocked `/api` only. No notification was marked read and no document was opened.
Viewports represented: 390, 768, 1024, 1280, 1440, 1600, 1920.
Horizontal overflow in the captured set: none.

Mobile keeps the home receipt carousel, the attention cards, and a single notification column. From 1200 the home splits into a waiting list and the collection, attention becomes a queue plus inspector, notifications become a list plus the selected notice, and search groups records beside the selected one.

## Counts

Slice 1 (CRM, collection inbox, accountant pack, secretary home, billing hub, inventory items): 13 surfaces, 12 DESKTOP-ADAPTED, 1 INTENTIONALLY-FOCUSED.

Documents slice: hub, search, inbox, review, email, upload, reports, uniform export, accountant pack recheck. None INTENTIONALLY-FOCUSED. None NOT-YET-DONE.

Slice 3 (inventory operations, collection create, payments), counted as surface/state rows in the slice 3 table:

- Inventory: 24 rows. 23 DESKTOP-ADAPTED. 1 INTENTIONALLY-FOCUSED (barcode camera). 0 NOT-YET-DONE.
- Collection create: 5 rows. 4 DESKTOP-ADAPTED. 1 INTENTIONALLY-FOCUSED (setup blockers). 0 NOT-YET-DONE.
- Payments: 4 rows. 3 DESKTOP-ADAPTED. 1 INTENTIONALLY-FOCUSED (legacy request redirect). 0 NOT-YET-DONE.

Slice 4 (home, attention, notifications, search), counted as rows in the slice 4 table:

- Home: 4 rows. 2 DESKTOP-ADAPTED. 2 INTENTIONALLY-FOCUSED (redirect, failed load). 0 NOT-YET-DONE.
- Attention: 2 rows. 2 DESKTOP-ADAPTED. 0 INTENTIONALLY-FOCUSED. 0 NOT-YET-DONE.
- Notifications: 1 row. 1 DESKTOP-ADAPTED. 0 NOT-YET-DONE.
- Search: 1 row. 1 DESKTOP-ADAPTED. 0 NOT-YET-DONE.

Still open: the domains in "Still remaining" above. Production merge: not requested.
