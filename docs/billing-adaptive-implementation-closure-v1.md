# Billing Adaptive Implementation Closure Report

**Date:** 2026-08-30 · **Base:** `main` @ `adb3195`
**Verdict:** **PARTIAL** — B0–B3 delivered and verified; B4–B5 deferred, blocked by owner decision D-3.

---

## 1. PRs + CI

| PR | Scope | Base | CI |
|---|---|---|---|
| [#291](https://github.com/eldad8802-prog/business-platform/pull/291) | B0 safety + B1 mechanical decomposition | `main` | 6/6 pass (`ci-1-guard`, `verify`, `release/verify`, Vercel ×3) |
| [#293](https://github.com/eldad8802-prog/business-platform/pull/293) | B2 container/chrome + B3 contextual rail | `#291` | 5/5 pass |

Stacked deliberately: #291 is a valid production state on its own (two defect fixes plus file moves, no visual change), so the split cannot leave an intermediate broken state. **Neither is merged.**

> `ci-1-guard` does not appear on #293 because its base branch is not `main`; it will run once #291 lands and #293 is retargeted.

## 2. B0 result — PASS

| Item | Before | After | Evidence |
|---|---|---|---|
| "what's missing" tap targets | **20px** (A-7 gating FAIL) | **24px** | runtime, 7 viewports, zero targets under 24×24 |
| Bottom sticky ownership | guard existed but never armed | one owner per state | runtime, exactly one page-owned pinned element |

**Correction to my own design report.** §15 claimed the two `bottom: 0` elements had no coordination. That was wrong — an `IntersectionObserver` on `#billing-lines-sticky-controls` existed. But it was attached in a mount-once effect while `StickyActionBar` renders *before* the stage branches, so the element did not exist yet, `getElementById` returned `null`, and the guard silently never armed. Replaced with a `linesEditorActive` prop: no timing dependency, ownership decided **per state** rather than per scroll position.

## 3. B1 invariant result — **PASS**

```
declarations compared: 40
B1 GATE PASS — every moved declaration is byte-identical to main apart from the added `export`.
```

Every moved declaration was extracted from `origin/main` and from its new home and compared byte for byte. No JSX restructured, no state changed owner, no callback, lifecycle, validation, API call or persistence path touched. **`B1 DESIGN ASSUMPTION FAILED` was not triggered.**

## 4. Exact structural changes

| Module | Declarations | Content |
|---|---|---|
| `lib/billing/document-view-model.ts` | 26 | types, labels, formatters, line helpers |
| `components/billing/document/load-states.tsx` | 3 | skeleton, error, not-found |
| `components/billing/document/read-models.tsx` | 11 | status, summaries, details, lines, totals |

`app/billing/[id]/page.tsx`: **4,642 → 3,798** lines (B1), then B2/B3 composition on top.

Behavioural edits, all in `page.tsx`: `MISSING_LINK_STYLE`; `linesEditorActive` prop; `useHideShellChrome(!isDesktop)`; `RAIL_CSS` + `data-billing-column` / `data-billing-stage` / `data-billing-flow`; `contextSummary` / `lifecycleAction` hoisting; `WorkspaceLayout` wrapper.

## 5. Mobile proof (320 / 390) — RUNTIME PROVEN

Zero horizontal overflow. Single region, rail absent. Column 288 / 358 — unchanged from before the wave. Stage order, content and actions identical (fiscal snapshot). One page-owned pinned element. Shell chrome still suppressed, as the focused treatment requires. Eye-verified at 390 on `/billing/36`.

## 6. Tablet proof (768 / 1024) — RUNTIME PROVEN

**Intentional, and explicitly not a desktop.** No side information at either width — the rail does not appear until 1280. Column 736 (768) and 744 (1024), up from a flat 720, so tablets stop rendering the phone layout with margins. At 1024 the shell sidebar returns (D-1): eye-verified, 248 sidebar + 744 column, no double navigation.

## 7. Desktop proof (1280 / 1440 / 1920) — RUNTIME PROVEN

| viewport | column | rail | stage | RTL order |
|---|---|---|---|---|
| 1280 | 1000 | 340 @ x676 | 660 @ x16 | rail inline-start ✓ |
| 1440 | 1160 | 340 @ x836 | 820 @ x16 | ✓ |
| 1920 | 1280 | 340 @ x1136 | 940 @ x196 | ✓ |

Was 720 at all three. Eye-verified at 1920: sidebar, rail with summary + action, stage with hero/collections/collapsible, no dead canvas.

## 8. State coverage

**RUNTIME PROVEN** — loading, `issued` (3 documents: TAX_INVOICE ×2, QUOTE, RECEIPT), `pending_review`, `draft_missing` (`customerFocus`), plus the hub list.

**STRUCTURALLY VERIFIED / NOT RUNTIME PROVEN** — `itemsFocus`, `draft_ready`, `quote_ready`, `quote_converted`, error, not-found, validation-error, long line-item document. These share the composition path with proven states (same `stageContent` grid, same `contextSummary` hoist, same CSS switch), but **structural inheritance is not runtime proof** and is not presented as such.

## 9. Contextual rail behaviour

The rail carries only what the product already showed: document identity, current state, server-derived totals and the stage's own next lifecycle action. It is **not a new authority** — it renders the same component instances, from the same props, computing nothing. The summary is **hoisted, not duplicated**: whichever region is visible, the other is `display: none`, so no monetary value gains or loses a rendering and nothing behind a collapsible becomes visible. `WorkspaceLayout` at `LAYOUT.bp.wide`; no new primitive, no new breakpoint family.

## 10. Sticky-control resolution

One owner per state. `StickyActionBar` yields whenever the lines editor is rendered (B0). Above 1280 it moves into the rail, where there is no bottom region to contend for. Runtime: **exactly one page-owned pinned element** in every observed state at every viewport (the second and third pinned elements at ≥1024 are the shell sidebar and the global accessibility button, neither page-owned).

Not verifiable here: keyboard-open behaviour and long line-item documents both require `itemsFocus` (§13).

## 11. Fiscal regression evidence — PASS

`scripts/qa/ui/billing-fiscal-snapshot.mjs`, baseline on `main`, re-run after B0, after B1 and after B2/B3:

```
PASS — monetary values, document numbers, lifecycle actions, headings and API calls all identical.
```

7 surfaces × 4 viewports. Captures every rendered monetary string (bidi-stripped — Intl he-IL embeds U+200F between number and symbol, which is why the first attempt matched nothing), every document number, the heading, and the full lifecycle-action set **with disabled state**. Creates no billing documents.

## 12. API / lifecycle regression evidence — PASS, and it earned its keep

Request counts are part of the snapshot. The first B3 attempt branched on `useMediaQuery` and returned a different tree per tier; that remounted the subtree when the query resolved after hydration, re-running child effects:

```
invoice-profile      20 → 22
payments/requests     8 → 12
```

Caught by the harness, not by inspection. The tier switch was rewritten to be entirely CSS — both regions always render, CSS decides visibility — and the counts are identical again. Lifecycle action sets and disabled states unchanged throughout.

## 13. Inaccessible states — why B4 and B5 are deferred

Owner decision D-3: create no billing documents for QA. Under that rule:

- **B4, line-item table.** Requires `itemsFocus` — a draft with lines pending. No dev document reaches it, and moving one there means a `PUT .../lines`.
- **B5, overlay migration.** `IssueConfirmDialog`'s trigger is **`disabled`** on the only `PENDING_REVIEW` document, and `readyInvoiceFocus` needs a `TAX_INVOICE` draft (none exists). `UnsavedChangesDialog` needs a dirty draft, which means a `PATCH`.

Both were verified unreachable at runtime, not assumed. Shipping unverified changes to the UI that **gates document issuance** is the wrong trade, so they are deferred rather than shipped blind. Unblocking them needs either dev-only QA documents (a reversal of D-3) or a story-level harness that mounts the components outside the fiscal flow.

## 14. Architecture / ratchet

Ratchet `pageMaxWidth` **76 → 75**, lowered in #293. `rawEnv` 26, `innerWidth` 5, `rawZ` 5 — unchanged. No new `env()`, no raw z-index, no new breakpoint family, no new primitive, no duplicated master–detail. Billing now declares `data-page-intent="workspace"` via the `PageSurfaceIntent` type.

## 15. Remaining findings

1. **B4 / B5 deferred** (§13) — needs an owner call on D-3.
2. **The hub keeps its `max-width: 980` arm.** The design report flagged it as a max-width arm (mobile overrides on a desktop base, the inverse of the one-boundary rule). Not converted here: it is a large `!important` block whose inversion is a visual-risk change of its own, and the approved design targets the document surface. Belongs in its own wave.
3. **Billing z-index values still bypass `LAYOUT.z`** (50, 200, 220; hub 120, 130). B5 would have fixed the dialogs as a side effect.
4. **Dev data is thin** — the observed documents report `0 פריטים` against non-zero totals. Not a UI defect; it does limit what can be proven.

## 16. Verdict

**PARTIAL.**

Delivered and runtime-verified: B0, B1 (hard gate passed), B2, B3. Zero fiscal, lifecycle, API, validation or persistence change — proven by snapshot rather than asserted. Deferred with cause: B4, B5.

Nothing was scaled down silently: the two deferred phases are the two that could not be seen running, and the reason is a rule the owner set.
