# Billing Adaptive Design Report v1

**Status:** DESIGN ONLY — awaiting owner approval. No Billing code was changed.
**Date:** 2026-08-30
**Scope:** `/billing`, `/billing/[id]` — presentation and composition only.
**Evidence base:** code read at `bf0d7e4` + a runtime matrix of 6 surfaces × 7 viewports
(`scripts/qa/ui/billing-audit.mjs`, READ-ONLY: it creates no billing documents).

> **Evidence tiers used below.** *Runtime-proven* = measured this run. *Code verified* =
> read in the source, not exercised. *Not reachable* = the state exists in code but no
> document in the dev tenant reaches it, and creating one would mean writing a fiscal
> object, which this audit does not do.

---

## 1. Current architecture

Billing is two client pages plus six small shared components.

| File | Lines | Role |
|---|---|---|
| `app/billing/page.tsx` | 1,784 | Hub: list, filters, summary pills, create-draft modal, identity gate |
| `app/billing/[id]/page.tsx` | 4,642 | Document workspace: every stage of one document |
| `app/billing/layout.tsx` | 11 | Wraps both in `ShellChrome` |
| `components/billing/*` | 6 files | Customer picker, style picker, signature field, identity banner/setup, issuer badge |

**The 4,642-line file is not one flow, and it is not undifferentiated.** It already contains
**~35 named components** with clean props boundaries. The monolith is a *co-location*
problem, not an absence of structure — which changes the decomposition question from
"how do we break this apart safely" to "which of these already-separate pieces need to
move into their own files to be composed differently".

**Billing is entirely outside the adaptive layout system.** It imports no `PageContainer`,
no `LAYOUT` tokens, no `useBreakpoint`, no `WorkspaceLayout`, no `AdaptiveOverlay`.
*(Code verified — the grep returns nothing.)*

---

## 2. Route / state inventory

### Routes

| Route | Surface |
|---|---|
| `/billing` | hub / list |
| `/billing/[id]` | document workspace, all stages |

There is no separate create route: creation is a modal on the hub (`CreateDraftModal`),
gated by `IdentityGateModal` when the business identity is incomplete.

### The real state machine

Persisted status is three values — `DRAFT | PENDING_REVIEW | ISSUED` — but the UI
branches on a **derived seven-value stage** (`StageKey`), which is what actually decides
composition:

`draft_missing · draft_ready · quote_ready · quote_converted · pending_review · issued`

Derived at `app/billing/[id]/page.tsx:1562-1570`:

| Stage flag | Condition | Renders |
|---|---|---|
| `customerFocus` | `isDraft && !customerOk && !quoteLocked` | `DraftEditorSection` |
| `itemsFocus` | `isDraft && customerOk && (!linesOk \|\| dirtyLines)` | `DraftLinesSection` + `CustomerSummaryCard` + `TotalsCard` |
| `readyInvoiceFocus` | `isDraft && type≠QUOTE && editingComplete` | `ReviewSummaryCard` + `DraftIssuePrimarySection` + `IssuerSummaryBadge` + collapsible editor |
| `readyQuoteFocus` | `isQuoteDraft && editingComplete` | `ReviewSummaryCard` + `QuoteDraftHero` + collapsible editor |
| `convertedQuoteFocus` | `type=QUOTE && quoteLocked` | `QuoteDraftHero` + `ReviewSummaryCard` |
| `pendingReviewFocus` | `status = PENDING_REVIEW` | `PendingReviewLifecycleSection` + `ReviewSummaryCard` |
| `issuedFocus` | `status = ISSUED` | `IssuedHero` + `CollectionsSection` + `ReviewSummaryCard` |

Orthogonal to stage: `LoadState` (`loading / error / not-found / ready`),
`PatchSaveStatus`, `linesSaving`, `dirtyLines`, `lifecycleBusy`, and two overlays
(`IssueConfirmDialog`, `UnsavedChangesDialog`).

**This is a staged wizard over one document, not an editor with a preview.** Section 7
returns to what that means for the desktop hypothesis.

### Document types

`TAX_INVOICE`, `QUOTE`, `RECEIPT` (+ credit note and conversion endpoints). Type changes
composition materially: only `QUOTE` gets `validUntil`, the convert-to-invoice path and
`QuoteDraftHero`; only `TAX_INVOICE` gets `IssuerSummaryBadge`; collections appear per
`shouldShowCollections(type, status)`.

---

## 3. Monolith responsibility map

Grouped by what each piece is *for* — this is the seam map for §14.

| Group | Components | Fiscal exposure |
|---|---|---|
| **Page shell** | `BillingDocumentWorkspacePage` header, back, `StatusBadge`, completion notice | none |
| **Load states** | `WorkspaceSkeleton`, `ErrorBanner`, `NotFoundCard` | none |
| **Stage router** | `DocumentBody` (the 7-branch switch), `StageAwarePanel` | none — routes only |
| **Draft editing** | `DraftEditorSection`, `CustomerPicker`, `DraftLinesSection`, `DraftLineEditorCard` | **writes** lines/customer |
| **Read models** | `CustomerSummaryCard`, `ReviewSummaryCard`, `ReviewSummaryRow`, `DetailsCard`, `DetailRow`, `LinesSection`, `LineCard`, `TotalsCard`, `TotalRow` | display only |
| **Lifecycle** | `DraftIssuePrimarySection`, `PendingReviewLifecycleSection`, `QuoteDraftHero`, `IssuedHero` | **triggers** submit/revert/issue/convert |
| **Actions** | `StickyActionBar`, `ShareOptionButton`, PDF open/download/share | reads PDF |
| **Overlays** | `IssueConfirmDialog`, `UnsavedChangesDialog` | issue confirmation |
| **Collections** | `CollectionsSection`, `PaymentStatusBadge`, `toPaymentRequestView` | payment requests |
| **Chrome** | `CollapsiblePanel` | none |

---

## 4. Existing responsive behavior

**Runtime-proven, 6 surfaces × 7 viewports, zero horizontal overflow anywhere.**

| Surface | 320 | 390 | 768 | 1024 | 1280 | 1440 | 1920 |
|---|---|---|---|---|---|---|---|
| detail column | 288 | 358 | **720** | **720** | **720** | **720** | **720** |
| hub column | 292 | 362 | 664 | 724 | **928** | **928** | **928** |

The detail page contains **one width literal and zero media queries in 4,642 lines**:
`maxWidth: 720` at line 1017. The hub has `maxWidth: 980` plus a single
`@media (max-width: 980px)` block — a *max-width arm*, i.e. mobile overrides layered on a
desktop base, the inverse of the one-`min-width`-boundary rule the Documents inbox
adopted after the Artifact B fractional-dead-zone lesson.

**Shell chrome is suppressed on the detail page at every width.**
`useHideShellChrome(true)` is called unconditionally at line 290. Runtime-proven at 1440:
`/billing` renders the 248px sidebar; `/billing/36` renders **no nav surface at all** —
no sidebar, no rail, no bottom bar. The only way out of a document is the in-page
"חזרה" button.

---

## 5. Current Desktop problems

1. **A 720px column inside a 1920px viewport.** ~600px of dead canvas on each side, at
   every desktop width. Runtime-proven.
2. **The sidebar is given up for nothing.** Hiding chrome buys the full viewport, and
   then the page declines to use it. On mobile the trade is defensible; on desktop the
   user loses navigation *and* gains no space.
3. **Line items render as stacked cards where a table belongs.** `DraftLineEditorCard`
   is description (full row) → `1fr 1fr` quantity/unit-price → VAT rate (full row), one
   card per line. Comparing five lines means five vertical scans of a 720px column.
4. **Totals are far from the lines that produce them.** `TotalsCard` sits below or
   inside a collapsible; on a long document the numbers a user is checking against are
   off-screen from the numbers they are checking.
5. **The document is never visible next to its own data.** The PDF is only reachable via
   view/download/share — there is no preview surface at any width.

## 6. Current Tablet problems

At 768 and 1024 the detail page has **already reached its final composition** — 720 is
the cap, so 1024 renders exactly what 1920 renders. Tablet is not a distinct form factor
here; it is mobile's layout with more margin. The hub does differentiate (664 → 724),
but only via the `max-width: 980` arm, so 1024 and 1280 differ by container width alone.

## 7. Mobile invariants (must not regress)

Runtime-proven at 320 and 390 unless noted:

1. **Zero horizontal overflow** — currently true on all six surfaces.
2. **One stage at a time.** The stage switch is the mobile flow. Any desktop composition
   must not leak a second region into ≤390.
3. **`StickyActionBar` remains reachable.** It is `position: sticky; bottom: 0; z-index: 50`.
4. **No shell nav on the detail page.** Suppression is deliberate; the bottom bar would
   otherwise sit under the sticky action bar.
5. **The "what's missing" panel drives the flow** — it is the primary navigation inside
   a draft.
6. **`inputMode="decimal"`** on quantity, unit price and VAT rate — the numeric keypad
   must survive any input restructuring.
7. **The unsaved-changes guard.** Navigating away from a dirty draft opens
   `UnsavedChangesDialog`; it must keep intercepting.

## 8. Fiscal invariants (must not be touched)

**The single most important finding for scoping: the client never computes money.**

`TotalsCard` reads `doc.subtotalAmount`, `doc.vatAmount`, `doc.totalAmount` — server
strings, passed only through `formatMoney` for display. Line figures come from
`BillingDocumentLine.lineSubtotal / vatAmount / lineTotal`, also server-computed. There
is no VAT rate arithmetic, no rounding, and no total derivation anywhere in the 4,642
lines. *(Code verified.)*

**Consequence: a presentation-only change physically cannot alter a total**, provided the
following stay untouched:

| # | Invariant | Where it lives |
|---|---|---|
| F-1 | Totals/VAT/subtotals are server-owned; the client formats | `TotalsCard`, `LineCard` |
| F-2 | Numbering & `documentNumberFormatted` | server; displayed only |
| F-3 | Issue / submit / revert / convert state machine | `POST .../issue \| /submit \| /revert \| /convert-to-invoice` |
| F-4 | Issued documents are read-only | `isDraft` gating on every editor |
| F-5 | Allocation number & authority decision | `/allocations`, `/authority-decision` — **not rendered by this page today** |
| F-6 | Signature | `BillingSignatureField` |
| F-7 | Payments / collections | `/api/payments/requests` |
| F-8 | Line persistence | `PUT .../lines` — the only line write path |
| F-9 | Validation semantics (`looksLikeDecimalInput`, `linesAreDirty`) | client-side *input* guards, not fiscal math |
| F-10 | PDF generation | `GET .../pdf` |

**If any proposed composition requires changing one of these, that is the STOP signal.**
Nothing in §10–§12 does.

---

## 9. Proposed canonical intent

**`workspace` — but only from 1280 up, and not the CRM two-pane shape.**

Reasoning, against the Spec's `editor | preview/summary` hypothesis:

- The product is a **staged wizard**, not an editor with a document view. Six of the
  seven stages render a *result* or a *decision*, not an editable form. An editor pane
  would be empty in four of them.
- A preview pane has nothing to show before issue: the PDF exists as an endpoint, and a
  draft has no issued document to preview.
- What *is* constant across every stage is a **summary** — customer, line count, totals,
  status — currently rendered as `ReviewSummaryCard` / `CustomerSummaryCard` / `TotalsCard`
  repeated inside branch after branch.

So the honest desktop shape is **stage content + a persistent document context rail**,
which is `WorkspaceLayout` with `start` = context, `end` = stage — the *same primitive*
CRM uses, in a different proportion. **No new primitive, no new breakpoint family.**

- Below 1280: single region — mobile composition, unchanged.
- 1280 and up: context rail (~340) + stage content (`content`-class column, ≤960).
- The **nested column inside the workspace is `content`, not `focused`** — line editing
  is the one genuinely wide task.

Chrome suppression should become **width-aware**: keep `useHideShellChrome(true)` below
1024 (mobile needs the viewport), release it at 1024+ so desktop users keep the sidebar.
That is a presentation change to an existing hook call, not new machinery.

## 10. Proposed Mobile composition (320–767)

**Unchanged.** The stage switch already is the mobile design and every invariant in §7
holds. The only mobile items proposed are two defects:

- Raise the "what's missing" links to ≥24px (see §18, R-1).
- Verify `StickyActionBar` and `#billing-lines-sticky-controls` — both `bottom: 0` —
  cannot pin simultaneously (see §15).

## 11. Proposed Tablet composition (768–1279)

**Explicitly: no side information.** 768–1023 keeps the single column but should widen
past 720 to a `content` cap so tablets stop rendering the phone layout with margins.
1024–1279 restores the shell sidebar (248) leaving ~776 — enough for one comfortable
column, **not** enough for a rail plus a column without cramping both. The two-region
switch waits for 1280.

## 12. Proposed Desktop composition (1280+)

```
┌──────────────── 1280+ ────────────────┐
│ sidebar │  stage content  │  context  │   RTL: sidebar inline-start
│  248    │   ≤960          │   ~340    │
└───────────────────────────────────────┘
```

- **Context rail** (persistent, all stages): document identity + status, customer,
  totals, and the primary lifecycle action. This is the existing `ReviewSummaryCard` +
  `TotalsCard` + `StickyActionBar` content, hoisted out of the per-branch repetition
  rather than newly written.
- **Stage content**: exactly what `DocumentBody` renders today.
- **Line items become a table at ≥1280** — description | qty | unit price | VAT | line
  total — reading the same server-computed fields the cards already read.

Deliberately **not** proposed: a PDF preview pane. It would be empty for every
pre-issue stage, and post-issue the existing view/download/share already works.

---

## 13. State × viewport matrix

Only states that exist in the code. Evidence tier per row.

| State | Evidence | Mobile 320–767 | Tablet 768–1279 | Desktop 1280+ |
|---|---|---|---|---|
| Loading | runtime | skeleton, single col | same, `content` cap | skeleton in stage region; rail skeleton |
| Error / not-found | code verified | banner, single col | same | banner in stage region; rail hidden |
| `draft_missing` (new draft) | **runtime** (doc 40) | missing-list → editor | same, wider | editor in stage; rail shows what is still missing |
| `draft_ready` (invoice) | **not reachable** — no `TAX_INVOICE` draft in dev | review + issue CTA | same | review in stage; rail carries the issue action |
| `itemsFocus` (line editing) | **not reachable** — no draft with lines pending | line cards | line cards, wider | **line table**; rail shows live totals |
| `quote_ready` | not reachable | quote hero + collapsible editor | same | hero in stage; rail + convert action |
| `quote_converted` | code verified | hero + summary | same | hero in stage; rail links the invoice |
| `pending_review` | **runtime** (doc 39) | lifecycle section | same | lifecycle in stage; rail carries revert/issue |
| `issued` | **runtime** (docs 36/37/38) | hero + collections | same | hero + collections in stage; rail = identity/totals/share |
| Validation errors | code verified | inline + missing-list | same | inline in stage **and** summarised in rail |
| Long line-item document | **not reachable** — dev docs have 0 lines | scrolling cards | scrolling cards | table + rail totals stay visible |

**Four of eleven states are not runtime-proven.** Reaching them requires creating billing
documents, which is a fiscal write this audit does not perform. Owner decision D-3 below.

---

## 14. Component decomposition proposal

The seams already exist. The minimum needed for §12, and nothing more.

**Must move out of the file** (they become composition units the layout places):

| Component | Why | Risk |
|---|---|---|
| `DocumentBody` stage switch | it is the composition root; layout cannot vary while it is buried | MEDIUM — pure routing, but every branch flows through it |
| `ReviewSummaryCard` + `CustomerSummaryCard` + `TotalsCard` | become the context rail; today repeated in 5 branches | LOW — display only, read server fields |
| `StickyActionBar` | moves from page-bottom to rail on desktop | MEDIUM — owns the primary lifecycle action |
| `DraftLinesSection` + `DraftLineEditorCard` | needs a table variant at ≥1280 | **HIGH** — the only line write path |

**Can stay where they are** (never repositioned): `WorkspaceSkeleton`, `ErrorBanner`,
`NotFoundCard`, `StatusBadge`, `CollapsiblePanel`, `DetailsCard`/`DetailRow`,
`LinesSection`/`LineCard` (read-only), `ShareOptionButton`, `PaymentStatusBadge`,
all formatters.

**Dangerous to move:**

- `IssueConfirmDialog` / `UnsavedChangesDialog` — `position: fixed`, z 200/220. Moving
  them into a new stacking context can trap them behind chrome. They should migrate to
  `AdaptiveOverlay` (portal to `#dz-overlay-root`) rather than be relocated by hand.
- `CollectionsSection` — talks to `/api/payments/requests`; layout-only changes, no
  lifting of its fetch.
- The auto-scroll `useEffect` (lines ~1503-1559) reacts to stage transitions with
  `scrollToId`. **Any recomposition must re-point these ids**, or the product silently
  stops guiding the user after issue. Easy to miss; it is not visible in JSX.

---

## 15. Sticky / action architecture

Two elements pin to `bottom: 0`:

| Element | Position | z | Runtime observation |
|---|---|---|---|
| `StickyActionBar` | sticky, bottom 0 | 50 | @390 sits at y=177–307, h=66 — **in flow, not pinned**, because content (852px) barely exceeds the viewport (844px) |
| `#billing-lines-sticky-controls` | sticky, bottom 0 | *(none)* | only in `itemsFocus`; not runtime-reachable in dev |

**Two `bottom: 0` sticky elements in the same scroll container will stack on top of each
other** when a draft with lines is long enough to scroll — the lines controls have no
z-index and would land under the action bar. This is a latent collision, not yet observed
because no dev document reaches `itemsFocus` with enough content. It should be resolved
*before* any recomposition, not after.

Recommended: **totals and the primary action** are the two things worth pinning, and on
desktop neither needs to be sticky at all — they live in the rail. On mobile keep exactly
one pinned element.

**None of Billing's z-index values come from `LAYOUT.z`** (50, 200, 220 on detail;
120, 130 on the hub, vs `nav:100, fab:110, overlay:1300, toast:1400`). The dialogs at
200/220 sit above nav (100) but far below the canonical overlay tier. Migrating them to
`AdaptiveOverlay` fixes this as a side effect.

## 16. Preview strategy

**Recommendation: no preview pane.** The PDF exists only as `GET .../pdf`; a draft has
nothing to preview, and four of seven stages are pre-issue. Keep view / download / share
as they are. If the owner wants a preview later it belongs in the *rail region* on issued
documents only — a decision that can be made after the composition lands, without
revisiting it.

## 17. Overlay behavior

Two overlays, both hand-rolled `position: fixed` with `maxWidth: 420 / 430`. Both should
become `AdaptiveOverlay` (sheet below 640, dialog above), which gives them the canonical
z tier, the `#dz-overlay-root` portal, and the safe-area contract. That is a swap of an
existing primitive for a hand-rolled one — no behavioral change to issue confirmation.

The hub's `IdentityGateModal` and `CreateDraftModal` (z 120/130) are the same case.

## 18. Risk map

### LOW — presentation only
- Page/column width and gutters; replacing `maxWidth: 720` with an intent.
- Width-aware chrome suppression.
- Rail vs in-flow placement of read-only summary cards.
- Overlay migration to `AdaptiveOverlay`.
- **R-1:** the three "what's missing" links measure **20px** — an A-7 gating failure
  (≥24×24 MUST). Runtime-proven at all seven viewports on doc 40.

### MEDIUM — component movement / state coupling
- Extracting `DocumentBody` and hoisting the summary trio into a rail.
- Moving `StickyActionBar` into the rail on desktop (it owns the primary action).
- Re-pointing the `scrollToId` auto-scroll targets.
- Resolving the two-sticky collision.

### HIGH — do not touch during implementation
- Anything behind the F-1…F-10 invariants in §8.
- `DraftLinesSection` write path: the local-line model (`LocalLine`, `generateLocalLineKey`,
  `linesAreDirty`, `resolveServerLineForDraft`) and its `PUT .../lines` save. A table
  variant must be a **render-only** change over the same state; if it needs a different
  line model, **STOP**.
- `IssueConfirmDialog`'s missing-tax-id warning and the issue call.
- Conversion, credit-note, allocation and authority-decision endpoints.

---

## 19. Exact implementation boundaries

**In scope:** `app/billing/[id]/page.tsx` (JSX/layout/styles), `app/billing/page.tsx`
(container width, the max-width arm), new files under `components/billing/` receiving
extracted components verbatim, one `useHideShellChrome` call becoming width-aware.

**Out of scope, no exceptions:** everything under `app/api/billing/**` and
`lib/services/billing/**`; the Prisma schema; `formatMoney` and every other formatter;
`looksLikeDecimalInput` / `linesAreDirty` / `normalizeNumericForCompare`; the lifecycle
fetch calls and their payloads; `BillingSignatureField`; PDF generation.

**Definition of "presentation only" for this wave:** if a diff line changes a value that
is sent to the server, or changes which endpoint is called, or changes a number that is
displayed, it is out of scope.

## 20. Test strategy

1. **Fiscal snapshot, before and after.** For every reachable document, capture the
   rendered subtotal / VAT / total / document number / status strings and assert byte
   equality across the change. This is the wave's real safety net and it is cheap
   precisely because §8 holds.
2. **Viewport matrix** — 6 surfaces × 7 viewports: zero overflow, RTL, intent per route,
   single region below 1280, rail geometry above.
3. **State coverage** — the eleven states in §13, which needs D-3 resolved.
4. **Sticky assertions** — at most one pinned element per scroll container on mobile;
   no pinned element covers the last actionable control.
5. **A-7** — no interactive target below 24×24 (currently failing, R-1).
6. **Overlay** — both dialogs portal outside the page container and sit at the canonical
   z tier; sheet below 640, dialog above.
7. **Auto-scroll** — after each stage transition the intended anchor is in view.

## 21. Migration plan

| Phase | Content | Gate |
|---|---|---|
| **B0** | Fix R-1 (tap target) and the two-sticky collision. No layout change. | own PR, mergeable alone |
| **B1** | Extract components verbatim into `components/billing/` — **zero JSX changes**, pure file moves. | fiscal snapshot identical |
| **B2** | Container intent: `720` → `content`; hub max-width arm → min-width boundary; width-aware chrome. | matrix green, still single-column |
| **B3** | Workspace composition at 1280+: context rail + stage region. | matrix + state coverage |
| **B4** | Line-item table at ≥1280 (render-only over the existing line model). | fiscal snapshot + line write path unchanged |
| **B5** | Overlay migration to `AdaptiveOverlay`. | overlay tests |

Each phase is independently revertible. **B1 is the load-bearing one**: if it cannot be
done without touching JSX, the plan is wrong and should come back for redesign.

## 22. Open owner decisions

- **D-1 — Chrome on desktop.** Release `useHideShellChrome` at ≥1024 so Billing regains
  the sidebar? *Recommend yes* — today desktop loses navigation and gains nothing.
- **D-2 — Rail contents.** Should the primary lifecycle action (issue / submit / convert)
  live in the desktop rail, or stay in flow? *Recommend rail* — it is the one control
  present in every stage.
- **D-3 — State coverage.** Four states are unreachable without creating billing
  documents in dev. Authorize creating **dev-only** QA documents (a `TAX_INVOICE` draft,
  a draft with pending lines, a long multi-line document), or accept those four states as
  code-verified only? *Recommend authorize* — otherwise the line-item table (B4) ships
  without ever having been seen.
- **D-4 — Line table threshold.** 1280 as proposed, or 1024? *Recommend 1280* — at 1024
  the sidebar leaves ~776, too narrow for five columns.
- **D-5 — Preview.** Confirm §16: no preview pane in this wave.

## 23. Recommendation

**Proceed, in the B0→B5 order, with `workspace` as the canonical intent above 1280 —
but with the rail carrying *context*, not an editor/preview split.**

The Spec's `editor | preview` hypothesis does not survive contact with the code: Billing
is a staged wizard, and four of its seven stages have nothing to edit. What repeats in
every stage is the document's identity, its totals and its next action — which is exactly
what a context rail is for, and which the code already renders three separate times.

The risk profile is better than the file size suggests. The client never computes money
(§8), so a presentation wave cannot move a total; the components are already separated,
so B1 is file moves rather than surgery; and the one genuinely dangerous area — the line
write path — is isolated behind a single `PUT .../lines`.

Two things should be fixed before any composition work, because they are defects rather
than design: the 20px targets, and the two `bottom: 0` sticky elements that will collide
the first time a draft is long enough to scroll.
