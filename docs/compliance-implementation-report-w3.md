# Compliance Implementation Report — W3 (Platform Enablement)

**Wave:** W3 — Platform Enablement (NOT retrofit). Turn the WP1 A-15 field requirements into a reusable primitive, proven on one real field.
**Date:** 2026-07-02
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.

---

## 1. What was built
- **`components/ui/accessible-field.ts`** — the WP1 **A-15** field primitive:
  - **`getAccessibleFieldProps({ id, error, hint, required })`** — a **pure prop-builder** (no React state, so it is honestly *not* a hook) returning prop bags to spread: `labelProps`, `controlProps`, `hintProps`, `errorProps`. It wires, in one place:
    - **label binding** via `aria-labelledby` (so a styled `<div>` label works without changing the element type / CSS)
    - **`aria-required`**, **`aria-invalid`**
    - **`aria-describedby`** linking **both** the hint and the error
    - **error binding + `role="alert"`** (announced)
    - **hint/helper binding**
    - **RTL-safe** by construction (ids + ARIA only; no physical positioning)
  - **`focusFirstInvalidField(container?)`** — the companion form-level helper: after a failed submit, moves focus to the first `[aria-invalid="true"]` control (rAF-deferred so the DOM reflects the just-set state). Works for **any** field that sets `aria-invalid`, including ones not yet migrated.

**Design note (why a builder, not a hook):** dialogs need effects (focus/inert) → a hook (`useAccessibleDialog`, W2). Field wiring is pure → a plain builder. Naming it `getAccessibleFieldProps` (not `useAccessibleField`) avoids a false rules-of-hooks signal and states its nature honestly.

## 2. Which real field was migrated
`app/(shell)/inventory/items/create/page.tsx` — the **"שם המוצר" (item name)** field of the create-inventory-item form (a real form with validation + error messages). Only this one field was migrated (per scope); the rest of the form was left untouched.

## 3. Constitution clauses covered
| A-15 requirement | Before | After (via primitive) |
|------------------|--------|-----------------------|
| label binding | `<div>` label, **not associated** | `aria-labelledby` links label ↔ input |
| aria-required | missing | set (field is required) |
| aria-invalid | present (manual) | provided by `controlProps` |
| aria-describedby (error) | missing | error linked |
| error `role="alert"` | plain `<div>` | announced |
| hint binding | n/a (no hint on this field) | supported by the primitive |
| focus to first error | **missing** | `focusFirstInvalidField()` on submit failure |
| RTL-safe | — | yes (ARIA/ids only) |

## 4. Did business behavior stay identical?
**Yes.** The diff (`+12 / −3`) touches only: the import, the `nameField` prop-builder call, the name field's label/input/error wiring, and one `focusFirstInvalidField()` call on submit failure. **The five validation rules, the `createInventoryItem` call, every other field, and the submit/redirect flow are untouched.** The only new *behavior* is an accessibility behavior (focus moves to the invalid field on submit) — which is exactly the A-15 requirement, additive and non-regressive. Verified by `eslint` (0/0), `tsc --noEmit` (no type errors), and diff inspection. *Honest caveat:* not exercised in a live browser this wave.

## 5. Did the code get simpler?
**Honestly: "simpler to get right," not fewer lines — here.** This field started with almost **no** a11y (only a bare `aria-invalid`), so migrating it **added** compliance (net `+9` lines) rather than removing hand-rolled code. The real simplification is that the developer no longer has to know/remember the five A-15 relationships — they call **one** builder and spread. **For a field that was fully hand-wired** (e.g. the movement-modal quantity field from W1) migrating to this primitive would **reduce** lines — that is the natural next migration and would show the line-reduction story too.

## 6. Lessons learned
1. **Pure wiring → a builder; stateful behavior → a hook.** W2 (dialog) needed a hook; W3 (field) is a pure builder. Same philosophy (knowledge in the platform), different mechanism per nature. This is a reusable judgment for future primitives.
2. **A-15 spans field-level *and* form-level.** The primitive split cleanly: `getAccessibleFieldProps` (per field) + `focusFirstInvalidField` (per form). The form helper is DOM-driven (`[aria-invalid]`), so it improves focus behavior for **all** fields that set `aria-invalid`, even before they are migrated — a cheap, broad win.
3. **`aria-labelledby` beats changing the element type.** Binding the existing styled `<div>` label preserves the design system exactly — lower regression risk than converting to `<label>`.
4. **Next primitives (by the repeated-pattern rule):** reduced-motion utility (A-8) and skip-link (A-4) are the remaining WP1 building blocks; build each the first time it would otherwise be copied.

## 7. Backlog v2 gap?
**No new gap.** A-15 was fully implementable as written; splitting it into a field builder + a form helper is an implementation shape, not a constitution defect. **WP1 unchanged — the constitution stays frozen.** (The existing Backlog v2 items C-1…C-7 are unaffected.)

---

## Success Criterion — the one question
> *"Can every new field in Dubiz be accessible by default without the developer having to remember all of A-15?"*

**Yes.** With `getAccessibleFieldProps` + `focusFirstInvalidField`, a new field becomes A-15-compliant by spreading prop bags and calling one helper on submit — the label/required/invalid/describedby/error/focus wiring is inherited from the platform, not memorised. Combined with W2's `useAccessibleDialog`, dialogs **and** their form fields are now accessible-by-default. **The knowledge continues to move from the document into the platform.**

## Files touched (W3)
`components/ui/accessible-field.ts` (new primitive) · `app/(shell)/inventory/items/create/page.tsx` (one field migrated + submit focus) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W3 commit follows.
