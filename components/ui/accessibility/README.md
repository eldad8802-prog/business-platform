# Accessibility Platform — developer guide (5 minutes)

These are Dubiz's shared **accessibility primitives**. Use them and your dialogs,
fields, and pages are accessible **by default** — you don't need to read the
accessibility constitution to get it right.

**One import:**

```ts
import {
  useAccessibleDialog,
  getAccessibleFieldProps,
  focusFirstInvalidField,
  SkipLink,
} from "@/components/ui/accessibility";
```

## When to use what

| You are building… | Use | It gives you |
|-------------------|-----|--------------|
| A **dialog / modal / sheet** | `useAccessibleDialog` (hook) | role=dialog + aria-modal, focus trap, focus-in on open, focus-restore on close, Escape, background `inert`, scroll-lock |
| A **form field** | `getAccessibleFieldProps` (builder) | label binding, `aria-required` / `aria-invalid` / `aria-describedby`, error `role="alert"`, hint binding |
| A **form's submit** | `focusFirstInvalidField()` | moves focus to the first invalid field after a failed submit |
| An **app page** | *(nothing — `SkipLink` is already global in the app shell)* | keyboard users skip to `#main-content` |
| A component with **animation / transition** | `usePrefersReducedMotion` (+ `motionSafe`) | drop/shorten motion when the user asked the OS to reduce motion (A-8) |

## Basic examples

**Dialog:**
```tsx
const { dialogProps, backdropProps } = useAccessibleDialog({ open, onClose, ariaLabel: "…" });
return (
  <div {...backdropProps} style={overlay}>
    <div {...dialogProps} style={panel}>…</div>
  </div>
);
```

**Field:**
```tsx
const f = getAccessibleFieldProps({ id: "item-name", error: errors.name, required: true });
<div {...f.labelProps} className="lab">שם <span>*</span></div>
<input {...f.controlProps} value={name} onChange={…} />
{errors.name ? <div {...f.errorProps} className="err">{errors.name}</div> : null}
// in your submit handler, after validation fails:
focusFirstInvalidField();
```

**Reduced motion:**
```tsx
const reduced = usePrefersReducedMotion();
<div style={{ transition: motionSafe(reduced, `transform 200ms ease`, "none") }} />
// motion is dropped for users who set prefers-reduced-motion; layout/behavior unchanged.
```

## What NOT to do

- ❌ Don't hand-roll focus traps, Escape handlers, or `aria-*` wiring — use the primitives (that's the whole point).
- ❌ Don't put business logic in these files. They implement **WP1 accessibility only**. Keep your data/validation/API logic in your component.
- ❌ Don't duplicate a primitive or fork its logic — extend the shared one (via a Governance change if the requirement itself changes).
- ❌ Don't import the files directly (`…/skip-link`) — import from the barrel `@/components/ui/accessibility`.
- ❌ Don't reach for the old Escape-only `useModalDismiss` for new dialogs — `useAccessibleDialog` supersedes it.

## Naming conventions (so new primitives stay consistent)

- `useX` → a **hook** (has React state/effects), e.g. `useAccessibleDialog`.
- `getXProps` → a **pure prop-builder** (no state), e.g. `getAccessibleFieldProps`.
- `PascalCase` → a **component**, e.g. `SkipLink`.
- Verb helpers → plain functions, e.g. `focusFirstInvalidField`.

*These primitives are the platform expression of WP1. The constitution says what's required; this folder is how you get it for free.*
