# UI / Accessibility Cleanup Backlog v1

**Status:** Living backlog — opened 2026-08-30 during the CRM-tail adaptive wave (#288)
**Purpose:** the home for **presentation-layer** defects found while doing other work
and deliberately not fixed there. Each item is small, real, and out of scope for the
wave that found it. Nothing here blocks a merge; everything here is a tracked gap.

> Scope boundary: this backlog holds **UI/CSS/accessibility** items. Fiscal, data,
> and API-contract defects do not belong here — they get their own PR (see #289).

---

## Why these were not fixed on discovery

The adaptive waves run under a standing rule: *convergence, not redesign*. A wave that
finds an unrelated product defect **documents it and moves on**, because fixing it
opportunistically means shipping an unreviewed change inside a PR whose stated scope
is something else. All three items below are byte-identical on `main` — none is a
regression introduced by the wave that found them.

---

## 1. Open items

| # | Item | Rule | Severity | Where |
|---|------|------|----------|-------|
| U-1 | `.crm-hd__back` is **20px** tall | **A-7 gating (24×24) — FAIL** | Must fix | `app/(shell)/customers/crm.css` |
| U-2 | `.crm-chip` is **28px** tall | A-7 gating PASS; below the 44×44 non-gating target | Should fix | `app/(shell)/customers/crm.css` |
| U-3 | `.crm-scope { min-height: 100% }` leaves a background seam | — (visual) | Should fix | `app/(shell)/customers/crm.css` |

### U-1 — CRM back link fails the gating target size

`.crm-hd__back` ("› חזרה ללקוחות") renders as an inline-flex text link at
`font-size: 13px` with no vertical padding, measuring **20 × 82 px** at 320 and 390.
Accessibility Constitution **A-7** sets the *gating* threshold at **≥ 24×24 CSS px**
(WCAG 2.2 §2.5.8), so 20px height is a genuine MUST-level failure, not a
best-practice gap.

It appears on customer and supplier detail cards below 1280 (it is `display: none`
at the workspace tier, where the master pane provides navigation instead), so it is
**mobile- and tablet-only** — precisely where target size matters most.

Fix shape: give the link vertical padding (or a `min-height`) to clear 24px without
changing the header's visual rhythm. Cheap, but it is a CRM density decision and
wants its own review.

### U-2 — CRM filter chips sit below the touch best-practice

`.crm-chip` (`פעילים` / `לא פעילים` / `הכול`) is `4px 10px` padding at `font-size: 12px`
→ **28 × 46–75 px**. That **passes** the A-7 gating 24×24 MUST, so this is not a
conformance failure; it is below the separate non-gating **44×44** target that A-7
records as best practice for primary touch controls.

These chips are the primary filter control on the customers and suppliers lists, so
they are a reasonable candidate for the 44×44 treatment on compact viewports —
tracked, not required.

### U-3 — CRM surface background does not fill short desktop pages

`.crm-scope` sets `min-height: 100%`, which resolves against a parent with no definite
height and therefore collapses to the content height. On desktop widths where CRM
content is short — the customers list with few rows, or the detail empty state — the
surface background ends partway down and the page background shows through as a
visible horizontal seam.

Confirmed by eye at 1920 on both the local build and production. The fix is a
**shell-height** decision (does `.shell-content` hand its children a definite height,
or does `.crm-scope` switch to a viewport-relative min-height?), not a CRM one, which
is why it is not a one-line change.

---

## 2. Measurement note

The CRM evidence harness (`scripts/qa/ui/crm-cluster-evidence.mjs`) originally asserted
a **32px** minimum, a number with no basis in any Dubiz rule. It now measures against
**A-7's real gating threshold of 24px** and reports anything between 24 and 44 as a
non-gating observation. Future harnesses should take their thresholds from the
Accessibility Constitution rather than inventing one.

---

## 3. Provenance

Found during the CRM-tail adaptive cluster (#288, merged as `bf0d7e4`) while running
the viewport matrix across `/customers`, `/customers/[id]`, `/suppliers`,
`/suppliers/[id]`, `/opportunities` and `/attention`. Owner decision on 2026-08-30:
document, do not fix opportunistically.
