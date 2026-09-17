/**
 * The five tool tints — declared once, used by Home and by "כל הכלים".
 *
 * These are the exact pairs that already shipped on main in the home screen's
 * tool strip (`.c-teal / .c-sage / .c-amber / .c-clay / .c-slate`). They are
 * moved here, byte for byte, so that the two screens that paint a tool cannot
 * drift apart and so that no sixth hue can be added by accident: a tool names
 * one of these five, and nothing in the product writes a tool colour inline.
 *
 * Every rule requires BOTH `.dz-tint` and the tint class, so `c-teal` cannot
 * leak onto unrelated markup the way the old global `.ftb` rule did.
 */

export const TOOL_TINTS = ["teal", "sage", "amber", "clay", "slate"] as const;

export type ToolTint = (typeof TOOL_TINTS)[number];

export const TOOL_TINT_CSS = `
.dz-tint{display:flex;align-items:center;justify-content:center}
.dz-tint.c-teal{background:#E3F0EC;color:#2E7C6E}
.dz-tint.c-sage{background:#E7EFE0;color:#4F7A52}
.dz-tint.c-amber{background:#F8EBD2;color:#B8801F}
.dz-tint.c-clay{background:#F8E7DE;color:#B0654A}
.dz-tint.c-slate{background:#E7EDF1;color:#4E6C7E}
`;
