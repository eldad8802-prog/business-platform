"use client";

/**
 * Accessible form-field primitive (WP1 A-15).
 *
 * `getAccessibleFieldProps` is a PURE prop-builder (not a hook — it uses no React
 * state) that wires the A-15 relationships once, so a developer gets an accessible
 * field by spreading prop bags onto their existing markup — no memorising which
 * ARIA attribute links to what. It is markup/style agnostic: it works with any
 * label element (native `<label>` or a styled `<div>`), any control, and any CSS.
 *
 * Covers:
 *   - label binding (via `aria-labelledby`, so a styled `<div>` label works without
 *     changing the element type / CSS)
 *   - `aria-required`
 *   - `aria-invalid`
 *   - `aria-describedby` linking BOTH the hint and the error message
 *   - error-message binding + `role="alert"` (announced)
 *   - helper/hint-text binding
 * RTL-safe by construction (only ids + ARIA; no physical positioning).
 *
 * Form-level "focus the first field with an error" is provided by the companion
 * `focusFirstInvalidField` helper (below).
 *
 * Usage:
 *   const f = getAccessibleFieldProps({ id: "item-name", error: errors.name, required: true });
 *   <div {...f.labelProps} className="lab">שם <span>*</span></div>
 *   <input {...f.controlProps} value={name} onChange={...} />
 *   {errors.name ? <div {...f.errorProps} className="err">{errors.name}</div> : null}
 *   {hint ? <div {...f.hintProps} className="help">{hint}</div> : null}
 */
export type AccessibleFieldOptions = {
  /** Stable base id for the field; derived ids are `${id}-label|hint|error`. */
  id: string;
  /** Current error message (falsy = valid). */
  error?: string | null | false;
  /** Whether a hint/helper element is present (drives aria-describedby). */
  hint?: boolean;
  /** Whether the field is required. */
  required?: boolean;
};

export function getAccessibleFieldProps({
  id,
  error,
  hint = false,
  required = false,
}: AccessibleFieldOptions) {
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");

  return {
    labelId,
    hintId,
    errorId,
    labelProps: { id: labelId },
    controlProps: {
      id,
      "aria-labelledby": labelId,
      "aria-required": required || undefined,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy || undefined,
    },
    hintProps: { id: hintId },
    errorProps: { id: errorId, role: "alert" as const },
  };
}

/**
 * WP1 A-15: after a submit fails validation, move focus to the first field that
 * is marked invalid. Deferred one frame so the DOM reflects the just-set
 * `aria-invalid` state. Works for every field whose control sets
 * `aria-invalid="true"` (including fields not yet migrated to the primitive).
 */
export function focusFirstInvalidField(container?: HTMLElement | null) {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => {
    const root: ParentNode = container ?? document;
    const el = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus?.();
  });
}
