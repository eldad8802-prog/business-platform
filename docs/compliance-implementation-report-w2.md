# Compliance Implementation Report — W2 (Platform Enablement)

**Wave:** W2 — Platform Enablement (NOT retrofit). Turn the WP1 dialog requirements from a document a developer must remember into infrastructure they inherit.
**Date:** 2026-07-02
**Branch:** `chore/compliance-foundation-w0` (isolated; not pushed). Independent commit per wave.
**Deliverables:** build the A-18 shared dialog primitive; verify it meets the constitution; migrate **one** additional dialog to it and prove no regression + simpler code + faster future dialogs.

---

## 1. What was implemented
- **`components/ui/use-accessible-dialog.ts`** — the shared **A-18** dialog primitive (`useAccessibleDialog`). Implements the full **A-11** dialog shell once:
  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby` / `aria-label` / `aria-describedby` wiring
  - focus **moved into** the dialog on open + **restored to the opener** on close
  - focus **trap** (Tab / Shift+Tab cycle)
  - **Escape** to close (with an optional `disableClose` for busy states)
  - background **`inert`** (every top-level `<body>` child except the dialog's container) + **body scroll-lock**
  - returns `{ dialogRef, dialogProps, backdropProps }` to spread — the developer does **not** re-declare role/aria/onKeyDown.
- **Migrated one dialog** — `components/documents/DocumentFilePreviewOverlay.tsx` — to the primitive: replaced its hand-rolled Escape handler, manual `role`/`aria-modal`/`aria-label`, and backdrop `stopPropagation` with two prop-spreads + one hook call.

## 2. Constitution clauses implemented
| Clause | Where | Result |
|--------|-------|--------|
| A-11 dialog shell (role, aria-modal, label, focus-in, focus-restore, focus-trap, Escape, inert) | primitive | **Covered** — once, reusable |
| A-18 shared primitive ("correctness inherited, not re-derived") | primitive | **Covered** — this is the primitive A-18 mandates |
| A-11 applied to a real dialog | preview overlay | **Covered** — including focus-trap/restore/inert it previously **lacked** |
| A-13 live regions / A-15 forms | n/a here | Out of the *dialog-shell* scope — these are per-content (error/form) and remain per-dialog; the primitive makes the A-11 shell free so authors only add content-specific a11y |

## 3. Simplification & reuse (the measurable proof)
- **Migrated overlay: net −5 lines** (`+10 / −15`), and the only lines changed are a11y wiring — the blob-fetch / preview / download logic is **untouched** (confirmed by the diff).
- The overlay **lost** hand-rolled Escape + manual ARIA + `stopPropagation`, and **gained** focus-trap + focus-restore + inert + scroll-lock that it never had. **Simpler *and* more compliant.**
- **Future dialog cost:** a new dialog becomes compliant with:
  ```ts
  const { dialogProps, backdropProps } = useAccessibleDialog({ open, onClose, ariaLabel });
  // <div {...backdropProps}><div {...dialogProps}>…</div></div>
  ```
  — no memorising of A-11. The 158-line primitive is written once and amortised across every dialog.

## 4. Difficulties encountered
1. **`inert` scope for inline vs portaled dialogs.** The primitive inerts every top-level `<body>` child except the one containing the dialog. For **portaled** dialogs (like this overlay) that yields true background inert (closing, in practice, the W1 C-7 concern). For **inline** dialogs it inerts sibling body-roots but not the shared app-root — still an improvement, and `aria-modal` + focus-trap cover the intent. Documented in the hook.
2. **TS ergonomics of spreadable props** — the backdrop `onClick` is typed `MouseEvent<HTMLElement>` so it spreads cleanly onto any element without strict-function-type friction. Verified type-clean.

## 5. Was any clause interpretation required?
No new interpretation beyond W1's. The primitive **operationalises** the W1 reading of A-11 (aria-modal + trap as the core; inert via portal) rather than reinterpreting it.

## 6. Constitution gaps discovered
- **None new.** The primitive **addresses C-7 in practice** (portaled dialogs now get real `inert`); the C-7 *text* clarification for WP1 remains parked in **Backlog v2** for a future Governance cycle. **WP1 was not edited. The constitution stays frozen.**

## 7. Did business behavior stay identical?
**Yes** for the migrated overlay: the diff touches only a11y wiring; blob fetch, PDF/image preview, download, and close-on-backdrop / close-on-Escape all behave the same (backdrop now closes via `target === currentTarget`, equivalent to the previous `stopPropagation` pattern; the responsive `.documents-file-overlay section` CSS still matches — the element is still a `<section>`).
**Honest caveat:** verified by `eslint` (0/0 on both files), `tsc --noEmit` (no type errors in either), and diff inspection — **not** a live browser click-through. A quick manual/e2e pass on the preview overlay is recommended before this primitive is rolled out widely.

## 8. Lessons for the rest of the system
1. **The knowledge moved from the document into the platform.** A11y for dialogs is now a hook, not a checklist — exactly the goal.
2. **`useModalDismiss` (Escape-only) is superseded** by `useAccessibleDialog`. Leave it in place (other dialogs still use it), but **new dialogs use the full primitive**, and existing hand-rolled dialogs migrate opportunistically (net-negative lines each time).
3. **The repeated-pattern rule proved itself:** dialog a11y appeared 2+ times (movement-modal W1, this overlay) → it became infrastructure. This is the standing rule for the rest of the rollout.
4. **Next natural primitives** (same rule, when they recur): an accessible **form-field wrapper** (A-15: label + required/invalid/describedby + focus-to-error — seen in movement-modal and inventory forms), a **reduced-motion** utility (A-8), and a **skip-link** (A-4). Each should be built the first time it would otherwise be copied.

---

## Success Criterion — the one question
> *"Can every new dialog built in Dubiz from now on be accessible by default, without the developer having to remember all the constitution clauses?"*

**Yes.** `useAccessibleDialog` makes the A-11 dialog shell automatic — a new dialog is compliant by spreading two prop bags. The knowledge now lives in the platform, not only in the document. **The easiest path for a developer is now also the correct one.**

## Files touched (W2)
`components/ui/use-accessible-dialog.ts` (new primitive) · `components/documents/DocumentFilePreviewOverlay.tsx` (migrated, −5 lines) · this report.
**Uncommitted** on `chore/compliance-foundation-w0` — a separate W2 commit follows.
