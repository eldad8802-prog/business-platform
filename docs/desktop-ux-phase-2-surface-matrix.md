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
| Inbox | `/inbox` conversations |
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

## Slice 5 — billing document detail, secretary beyond home, payables

These three desks share one vocabulary. A billing document is the source evidence. A secretary obligation is what is owed and when. A payable is the payment workflow. Recording a payment, marking an obligation handled, and preparing a payout stay separate actions. There is no inline PDF on the document: view, download, and share open the existing file actions. There is no live outbound payment provider in this slice, and the payable desk says so.

Document statuses that exist are draft, pending review, and issued. Paid, partial, and no-activity are collection figures on an issued tax invoice. Overdue and cancelled are not billing-document statuses, so they are not drawn as document badges. Receipts, credit notes, and payment requests are not a second document workspace: a payment request appears inside the collection pane and links to `/collection`.

| Domain | Surface | Route | State | Desktop composition | Status |
| --- | --- | --- | --- | --- | --- |
| Billing | Document | `/billing/[id]` | draft, customer missing | editor in the stage, identity rail from 1200 | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | draft, lines | line editor beside the money rail | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | draft ready to issue | issue action in the rail; extra editing stays collapsed | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | quote ready | same rail; convert stays a confirmed action | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | quote converted | locked quote beside the invoice it became | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | pending review | revert and issue stay in the rail | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | issued, open balance | number, customer, lines, collection, and share | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | issued, partial | paid and remaining sit in the collection pane | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | issued, paid | closed collection, no collect action | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | issued, no request | collection shows the balance without a request | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | issued, with request | the latest request status links into collection | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | collection failed to load | the warning stays in the collection pane | DESKTOP-ADAPTED |
| Billing | Document | `/billing/[id]` | load error / not found | one message and a retry or a missing-document card | INTENTIONALLY-FOCUSED |
| Secretary | All obligations | `/secretary?screen=all` | empty / many / selected | calendar and queue beside the selected obligation | DESKTOP-ADAPTED |
| Secretary | Detail | `/secretary?screen=detail` | overdue / today / future / recurring / installment / handled | payee, amount, due date, and history beside the next action | DESKTOP-ADAPTED |
| Secretary | Watching | `/secretary?screen=watching` | quiet / horizons | three horizons across the desk | DESKTOP-ADAPTED |
| Secretary | Category bank | `/secretary?screen=bank` | picker | category chips in a wider grid | DESKTOP-ADAPTED |
| Secretary | Capture | `/secretary?screen=capture` | new obligation | a capture sheet; creating one is a single task | INTENTIONALLY-FOCUSED |
| Secretary | Edit | `/secretary?screen=update` | edit | a short form, not a second ledger | INTENTIONALLY-FOCUSED |
| Secretary | Remind | `/secretary?screen=remind` | snooze | a date choice, then a confirmation | INTENTIONALLY-FOCUSED |
| Secretary | Loop result | `/secretary?screen=loops` | handled / removed | a confirmation, not a dashboard | INTENTIONALLY-FOCUSED |
| Secretary | Notifications prefs | `/secretary?screen=notify` | settings | a short settings column | INTENTIONALLY-FOCUSED |
| Payables | Queue | `/payables` | empty / open / selected | dense rows and the selected commitment | DESKTOP-ADAPTED |
| Payables | New commitment | `/payables?new=1` | form | the form beside the queue | DESKTOP-ADAPTED |
| Payables | Detail | `/payables/[id]` | installment / recurring / legacy | schedule and history beside prepare and record | DESKTOP-ADAPTED |
| Payables | Preparation | `/payables/[id]` | prepared / approved / completed / failed | destination, source, and the real next step | DESKTOP-ADAPTED |
| Payables | No provider | `/payables/[id]` | execution unavailable | the desk says money is not sent from here | DESKTOP-ADAPTED |
| Payables | Cheques | `/payables/cheques` | accounts and cheques | accounts beside the cheque register | DESKTOP-ADAPTED |
| Payables | Bank | `/payables/bank` | evidence / empty | the statement rule beside the lines | DESKTOP-ADAPTED |
| Payables | Match | `/payables/match/[documentId]` | document evidence | the source document beside candidate payments | DESKTOP-ADAPTED |
| Payables | Load error | `/payables` | error | one message and a retry | INTENTIONALLY-FOCUSED |

No billing-detail, secretary-beyond-home, or payables surface in this slice is NOT-YET-DONE.

## Slice 5 runtime QA

Evidence: `qa-evidence/desktop-ux-phase-2/billing-detail/`, `secretary/`, and `payables/`.
Mocked `/api` only. No document was issued, no payment was recorded, and no provider was called.
Viewports represented: 390, 768, 1024, 1280, 1440, 1600, 1920.
Horizontal overflow in the captured set: none.

Conflict closure with main kept `RecurringChanges` in the full-width recurrence context, directly under the single recurring notice and above the payment desk. Targeted payable-detail shots: `recurring-changes` at 390, 1024, 1440, 1920; `recurring-ended` at 390 and 1440; `recurring-installment` at 1440; `recurring-approved` at 390 and 1440. The recurring notice appears once. Overflow in that set: none.

## Slice 6 — settings, business, offers, content studio

Settings is a control center: a grouped rail beside the active area, and a hub that shows what is set up rather than repeating the links. Business is an identity desk. Offers (coupons) are a work queue plus the selected coupon, and creation keeps the live coupon beside every step. The content studio keeps one decision per step, because it branches between camera and AI, and places the choices already made in a brief beside the step. Mobile and tablet keep the existing stacks. No schema, integration, offering engine or AI provider was added.

| Domain | Surface | Route | State | Desktop composition | Status |
| --- | --- | --- | --- | --- | --- |
| Settings | Hub | `/settings` | connected / disconnected | grouped rail beside account, business and connection status, read from the same cards the sub-pages use | DESKTOP-ADAPTED |
| Settings | Connections | `/settings/connections` | connected | payment, tax authority, WhatsApp and Gmail as a 2×2 grid beside the rail | DESKTOP-ADAPTED |
| Settings | Connections | `/settings/connections` | disconnected | the same grid with each disconnected state | DESKTOP-ADAPTED |
| Settings | WhatsApp | `/settings/whatsapp` | connected | linked number and actions beside what Dubiz stores from Meta | DESKTOP-ADAPTED |
| Settings | WhatsApp | `/settings/whatsapp` | disconnected | invitation beside the privacy section | DESKTOP-ADAPTED |
| Settings | WhatsApp | `/settings/whatsapp` | load error | retry beside the privacy section. It never offers connect | DESKTOP-ADAPTED |
| Settings | Historical records | `/settings/import-export/historical/records` | populated | five filters in one row above a full-width table (type, number, date, amount, customer, source) | DESKTOP-ADAPTED |
| Settings | Account | `/settings/team` | signed in | name, email, business and logout at a reading measure beside the rail. No team or permissions model exists | INTENTIONALLY-FOCUSED |
| Settings | Business pointer | `/settings/business` | summary | a summary that links to the canonical editor at `/business` | INTENTIONALLY-FOCUSED |
| Settings | Locale | `/settings/workspace` | read-only | four fixed system facts | INTENTIONALLY-FOCUSED |
| Settings | Devices | `/settings/security` | populated | a short list whose one action ends a session, kept next to each device | INTENTIONALLY-FOCUSED |
| Settings | Account deletion | `/settings/account` | destructive | one irreversible confirmation | INTENTIONALLY-FOCUSED |
| Settings | Import/export hub | `/settings/import-export` | directions | five destinations, in or out | INTENTIONALLY-FOCUSED |
| Settings | Import | `/settings/import-export/import` | pick domain | check a file before any write | INTENTIONALLY-FOCUSED |
| Settings | Templates | `/settings/import-export/templates` | download | a sample file per domain | INTENTIONALLY-FOCUSED |
| Settings | Document import | `/settings/import-export/documents` | check | file check before any write | INTENTIONALLY-FOCUSED |
| Settings | Historical import | `/settings/import-export/historical` | check | review before write | INTENTIONALLY-FOCUSED |
| Settings | Historical record | `/settings/import-export/historical/records/[id]` | detail | one read-only external document. Covered by the import/export layout; not captured separately | INTENTIONALLY-FOCUSED |
| Settings | Export | `/settings/import-export/export` | configure | what leaves the business; the fixed download bar aligns to the content column | INTENTIONALLY-FOCUSED |
| Business | Identity | `/business` | populated | legal identity as a two-column form beside optional document details and links to the bot, coupons and connections | DESKTOP-ADAPTED |
| Business | Identity | `/business` | sparse | the same desk with the existing missing-invoice-details warning. No new completeness score | DESKTOP-ADAPTED |
| Business | Identity | `/business` | save error | the alert spans the desk | DESKTOP-ADAPTED |
| Business | Bot hub | `/business/bot` | categories | category grid; activation stays draft-only | DESKTOP-ADAPTED |
| Business | Bot editor | `/business/bot-settings` | preview | settings beside the simulated customer chat; the app sidebar now stays on desktop | DESKTOP-ADAPTED |
| Business | Bot category sheet | `/business/bot` | one category | a modal sheet over the hub | INTENTIONALLY-FOCUSED |
| Business | Bot area | `/business/bot-settings/[area]` | one area | one chip choice and one save | INTENTIONALLY-FOCUSED |
| Business | Activation outcome | `/business/bot/setup/success` | outcome / no activation | what was applied, then leave. Still a phone-shaped column; a one-time screen | INTENTIONALLY-FOCUSED |
| Offers | My coupons | `/revenue` | empty | toolbar actions beside the empty-collection copy | DESKTOP-ADAPTED |
| Offers | My coupons | `/revenue` | populated / selected | counts per state, the queue as aligned rows grouped live and ended, the existing card as inspector; arrow keys move the selection | DESKTOP-ADAPTED |
| Offers | My coupons | `/revenue` | disabled / expired / long benefit | the same queue; the row truncates, the inspector shows the full benefit and the real state action | DESKTOP-ADAPTED |
| Offers | Create | `/revenue?view=create` | goal / direction | the step beside the coupon being built | DESKTOP-ADAPTED |
| Offers | Create | `/revenue?view=create` | builder | fields beside the live customer view, which stays in sight while editing | DESKTOP-ADAPTED |
| Offers | Create | `/revenue?view=create` | published | one column: the step already shows the public coupon. Not reached in QA — publishing is not executed | INTENTIONALLY-FOCUSED |
| Offers | Legacy list | `/offers` | redirect | to `/revenue` | INTENTIONALLY-FOCUSED |
| Offers | Legacy create | `/offers/create` | redirect | to `/revenue` | INTENTIONALLY-FOCUSED |
| Offers | Legacy issue | `/revenue/issue` | redirect | to `/revenue` | INTENTIONALLY-FOCUSED |
| Offers | Marketplace | `/revenue?view=browse` | consumer | a consumer surface, deliberately phone-shaped | INTENTIONALLY-FOCUSED |
| Offers | Public coupon | `/revenue/coupons/[id]` | customer view | the coupon the customer receives | INTENTIONALLY-FOCUSED |
| Offers | Redeem | `/revenue/redeem` | scan | a camera and one input | INTENTIONALLY-FOCUSED |
| Content | Home | `/content` | first visit | vibe tiles at a landscape ratio beside "how it works" | DESKTOP-ADAPTED |
| Content | Home | `/content` | vibe chosen | the camera question under the tiles, the brief beside | DESKTOP-ADAPTED |
| Content | Goal | `/content/goal` | unselected / selected | the step beside the brief of earlier choices | DESKTOP-ADAPTED |
| Content | Direction | `/content/archetype` | recommendation | same | DESKTOP-ADAPTED |
| Content | Setup | `/content/setup` | context | same | DESKTOP-ADAPTED |
| Content | Creator plan | `/content/creator-plan` | preparing | same | DESKTOP-ADAPTED |
| Content | Shot direction | `/content/shot-direction` | loading | same | DESKTOP-ADAPTED |
| Content | Asset upload | `/content/assets-upload` | no plan yet | same | DESKTOP-ADAPTED |
| Content | AI assets | `/content/ai-assets` | preparing | same | DESKTOP-ADAPTED |
| Content | Render | `/content/render` | working | same | DESKTOP-ADAPTED |
| Content | Result | `/content/result` | ready | video and publish copy beside what the video was built from | DESKTOP-ADAPTED |
| Content | Result | `/content/result` | nothing rendered | the page's own empty state beside the brief | DESKTOP-ADAPTED |
| Content | Create (action sheet) | `/content/create` | building | same frame | DESKTOP-ADAPTED |
| Content | Assets | `/content/assets` | no flow | same frame | DESKTOP-ADAPTED |
| Content | Generate | `/content/generate` | working | same frame | DESKTOP-ADAPTED |
| Content | Format | `/content/format` | working | same frame | DESKTOP-ADAPTED |
| Content | Direction (legacy) | `/content/direction` | choose | same frame | DESKTOP-ADAPTED |
| Content | AI brief | `/content/ai-brief` | describe | same frame | DESKTOP-ADAPTED |

No settings, business, offers, or content-studio surface in this slice is NOT-YET-DONE.

Not surfaces: `/content/flow`, `/content/mode`, `/content/intent`, `/content/value`, `/content/style`, `/content/context` and `/content/summary` link only to each other and are linked from nowhere in the product. They inherit the studio frame but were not designed or counted; if opened by URL, their full-viewport fixed buttons run under the brief. `/settings/inbound-email` renders only when `INBOUND_EMAIL_ENABLED=true` and is not listed in Settings.

## Slice 6 runtime QA

`qa-evidence/desktop-ux-phase-2/shoot-slice6.mjs` against local `next dev`, every `/api` call mocked. No provider was connected, no message sent, no coupon published, no content generated. The Next dev badge is hidden in the captures. Evidence: `settings/`, `business/`, `offers/`, `content-studio/`; per-shot overflow in `slice6-metrics.json`. Horizontal overflow: none.

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

Slice 5 (billing document detail, secretary beyond home, payables), counted as rows in the slice 5 table:

- Billing detail: 13 rows. 12 DESKTOP-ADAPTED. 1 INTENTIONALLY-FOCUSED (load error / not found). 0 NOT-YET-DONE.
- Secretary beyond home: 9 rows. 4 DESKTOP-ADAPTED. 5 INTENTIONALLY-FOCUSED (capture, edit, remind, loop result, notification settings). 0 NOT-YET-DONE.
- Payables: 9 rows. 8 DESKTOP-ADAPTED. 1 INTENTIONALLY-FOCUSED (load error). 0 NOT-YET-DONE.

Slice 6 (settings, business, offers, content studio), counted as rows in the slice 6 table:

- Settings: 19 rows. 7 DESKTOP-ADAPTED. 12 INTENTIONALLY-FOCUSED. 0 NOT-YET-DONE.
- Business: 8 rows. 5 DESKTOP-ADAPTED. 3 INTENTIONALLY-FOCUSED. 0 NOT-YET-DONE.
- Offers: 12 rows. 5 DESKTOP-ADAPTED. 7 INTENTIONALLY-FOCUSED. 0 NOT-YET-DONE.
- Content studio: 18 rows. 18 DESKTOP-ADAPTED. 0 INTENTIONALLY-FOCUSED. 0 NOT-YET-DONE.

Still open: Inbox, Tools. Production merge: not requested.

Product limitations found in slice 6, left as they are:

- Settings has no team, permissions, or notification-preferences model. Account is the signed-in person plus logout; locale is read-only.
- Offers in the product are coupons. There is no line-item commercial offer and no sent/open/accepted/rejected lifecycle; coupon states are ACTIVE, DISABLED, EXPIRED and REDEEMED. `/offers`, `/offers/create` and `/revenue/issue` redirect to `/revenue`. Redemption counts beyond 0/1 are deliberately not modelled, so the queue shows no redemption totals.
- The Business Offering migration on main (`BusinessServiceAsset`, `InventoryItemAsset`, `OfferingDemandSignal`) has no model in `schema.prisma` and no code reading it. There is no offering editor to design, and none was added.
- The content studio's intermediate steps call generation APIs that were mocked empty in QA, so their loading and empty states are what was captured.
