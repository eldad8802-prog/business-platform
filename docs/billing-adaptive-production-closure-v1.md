# Billing Adaptive Production Closure

**Date:** 2026-08-31
**Verdict:** **Billing Adaptive v1 — PARTIAL / SAFE SHIPPED SCOPE.** B0–B3 Production = **PASS**.
**Predecessor:** `docs/billing-adaptive-implementation-closure-v1.md` (pre-merge results)
**Design of record:** `docs/billing-adaptive-design-report-v1.md`

---

## 1. Merge SHAs

| PR | Squash SHA on `main` |
|---|---|
| #291 — B0 safety + B1 mechanical decomposition | **`5c1a457`** |
| #293 — B2 container/chrome + B3 contextual rail | **`d18a1c8`** |

Merged dependency-safe, #291 first. Merging #291 deleted its branch, which GitHub
treats as closing any PR based on it — #293 was auto-closed, so it was reopened,
rebased onto the new `main` (dropping the now-squashed B0/B1 commit), CI re-run
**6/6 including `ci-1-guard`** (which had not run before, because a non-`main`
base skips it), and then merged. No intermediate broken state: #291 is a valid
production state on its own — two defect fixes and a set of file moves.

Freshness before merge: **#292** (payments tenant isolation) had landed in
between, with **zero file overlap**. The B1 invariant was re-proven against the
updated `main`: **40 declarations compared, B1 GATE PASS.**

Both scopes verified present on `main` after merge: 3 B1 modules,
`MISSING_LINK_STYLE`, `linesEditorActive`, `useHideShellChrome(!isDesktop)`,
`WorkspaceLayout`, ratchet `pageMaxWidth: 75`.

## 2. Production deployment

`Production – business-platform`, deployment **`6171199059`**, SHA **`d18a1c8`**,
state **`success`**.

This is the project that serves `promaxgroup.co.il`. The `business-platform-btrl`
project deploys the same SHAs and is **not** the domain — an earlier smoke in this
programme was run against a `-btrl` deployment and still showed pre-fix behaviour,
so the deployment identity is checked explicitly rather than assumed.

## 3. B0–B3 production results — 15/16

Harness: `scripts/qa/ui/billing-prod-smoke.mjs`. Read-only by construction: it
navigates and measures. No PATCH, no issue/void, no document created.

**Production holds 0 billing documents.** The stage states are therefore not
reachable without a fiscal write, which D-3 forbids. What *is* reachable is the
detail **route**: a missing id renders the not-found state, which sits inside the
same `<main data-page-intent>`, the same `[data-billing-column]` and the same
ShellChrome contract. A GET against nothing creates nothing — and it proves the
container and chrome halves of B2 in production.

| Check | Result |
|---|---|
| Zero horizontal overflow (12 cells) | PASS |
| RTL preserved | PASS |
| `data-page-intent="workspace"` on the detail route, 6/6 viewports | PASS |
| Column at the content cap below 1280 | PASS — 358 / 736 / 744 |
| Column at the data cap from 1280 | PASS — 1000 / 1160 / 1280 |
| ShellChrome absent below 1024 (focused treatment preserved) | PASS — 0 navs at 390, 768 |
| ShellChrome present from 1024 (**D-1**) | PASS — one 248px "ניווט ראשי" at 1024/1280/1440/1920 |
| Never two navigation surfaces at once | PASS |
| At most one page-owned pinned element per state | PASS |
| No refetch regression (one document fetch per load) | PASS |
| No request loop on any load | PASS |
| No interactive target under 24×24 | **FAIL — hub only, pre-existing** |

Eye-verified at 1920: sidebar restored, column at the data cap, RTL, single
navigation surface, no dead canvas.

**The one failure is not this wave's.** `components/billing/BillingIdentityBanner.tsx:313`
("העסק שלי") renders a **19px** target on the hub at all six viewports — an A-7
gating failure. That file was last changed in #87 and is not in this wave's diff;
`app/billing/page.tsx` is likewise untouched. Logged as new backlog debt (§8).

## 4. Viewport matrix — production, detail route

| | 390 | 768 | 1024 | 1280 | 1440 | 1920 |
|---|---|---|---|---|---|---|
| column | 358 | 736 | 744 | 1000 | 1160 | 1280 |
| shell nav | — | — | 248 | 248 | 248 | 248 |
| horizontal overflow | none | none | none | none | none | none |
| page-owned pinned | 0 | 0 | 0 | 0 | 0 | 0 |

Before this wave the same column measured **720 at every width from 768 up**, and
the shell nav was **absent at every width**.

## 5. Fiscal regression

**Nothing to compare in production:** with 0 documents, no monetary value,
document number, total or lifecycle action is rendered anywhere on the Billing
surface there. Fiscal parity therefore rests on the dev-environment suite —
`scripts/qa/ui/billing-fiscal-snapshot.mjs`, 7 surfaces × 4 viewports, baselined
on `main` and re-run after B0, after B1 and after B2/B3. **PASS every time** on
monetary values, document numbers, headings, lifecycle actions (with disabled
state) and API request counts.

One dev-run difference was investigated rather than waved through:
`invoice-profile` counted 19 against a baseline of 20. A per-surface probe run
twice on the same build showed **detail pages 12, stable** and **hub 8 then 7** —
the variance is the hub's, and the hub is not in this wave's diff. Detail pages
issue exactly one fetch per load.

## 6. Request / refetch parity

Production: **one document fetch per page load, no loop on any load**, across 12
loads. Dev: request-count map identical to the `main` baseline. No state
transition is triggered by layout — the tier switch is CSS and fires no effect.

## 7. B4 / B5 canonical status

> **DEFERRED — runtime state unavailable under D-3.**

Not `FAILED`. Not `PASS`. Not `STRUCTURALLY PROVEN`. **They were not verified.**

Reachability was tested, not assumed:

- `itemsFocus` needs a draft with pending lines — none exists.
- `IssueConfirmDialog`'s trigger is **`disabled`** on the only `PENDING_REVIEW`
  document, and `readyInvoiceFocus` needs a `TAX_INVOICE` draft — none exists.
- `UnsavedChangesDialog` needs a dirty draft, which means a PATCH.

No draft was created, no line item added, no draft dirtied, no dialog forced, no
`PENDING_REVIEW` document altered, nothing issued — in dev or in production.

### Recommended future validation route (not built)

An **isolated component/story harness** that mounts `DraftLinesSection` /
`DraftLineEditorCard`, `IssueConfirmDialog`, `UnsavedChangesDialog` and the sticky
interactions against **synthetic props and state**, with no API client, no
persistence and no fiscal write.

B1 already left every one of those components in a module with an explicit prop
contract, so such a harness needs **no further decomposition** — only a mounting
shell. No harness of that kind exists in the repo today (every `scripts/qa/ui/*`
harness drives a real browser against a real server), so building one is a scope
decision of its own and is **not** taken here.

## 8. Remaining Billing adaptive debt

1. **B4 (line table) and B5 (overlay migration)** — deferred as above.
2. **The hub keeps its `max-width: 980` arm** — mobile overrides layered on a
   desktop base, the inverse of the one-boundary rule. Its own wave.
3. **Billing z-index values bypass `LAYOUT.z`** (50, 200, 220; hub 120, 130).
   B5 would have fixed the dialogs as a side effect.
4. **`BillingIdentityBanner` 19px target** — new A-7 gating finding on the hub,
   pre-existing, surfaced by this smoke.
5. **The rail itself is not production-verified** — production has no document to
   render one. Runtime-proven in dev at 1280 / 1440 / 1920.

## 9. Canonical regression finding — CSS-driven responsive composition

Kept because the harness caught it and inspection did not.

The first B3 implementation branched on `useMediaQuery` and returned a **different
React tree per tier**. When the media query resolved after hydration the subtree
**remounted**, child effects re-ran, and `CollectionsSection` and
`IssuerSummaryBadge` re-fetched — `invoice-profile` 20 → 22,
`payments/requests` 8 → 12. Nothing about the rendered output looked wrong; only
the request tally showed it.

**Canonical rule for Billing:** *responsive composition is done in CSS whenever
behaviour and state do not need to change.* Render both compositions and let a
media query decide which is visible; reach for a JS branch only when the two tiers
genuinely need different **behaviour**, not merely a different arrangement.

This is strong, specific evidence **for the Billing surface**. It is deliberately
**not** promoted to a platform-wide law here — another surface may have a real
behavioural tier difference that justifies a JS branch.

## 10. Final verdict

| Phase | Status |
|---|---|
| B0 | **PASS** |
| B1 | **PASS** — hard gate, 40/40 byte-identical, re-proven against post-#292 `main` |
| B2 | **PASS** — production-verified |
| B3 | **PASS** — dev-verified; production has no document to render a rail |
| B4 | **DEFERRED — runtime state unavailable under D-3** |
| B5 | **DEFERRED — runtime state unavailable under D-3** |

**Billing Adaptive v1 — PARTIAL / SAFE SHIPPED SCOPE.**
**B0–B3 Production = PASS.** The single smoke failure is a pre-existing hub defect
outside this wave's diff. No fiscal, lifecycle, API, validation or persistence
semantics changed — proven by snapshot, not asserted.
