/**
 * Where a bottom sheet must sit while an on-screen keyboard is open.
 *
 * On iOS Safari (and Chrome's default) the keyboard does not shrink the layout
 * viewport: a `position: fixed; bottom: 0` sheet stays glued to the bottom of the
 * full screen, so its last rows — the movement sheet's "אישור עדכון"/"ביטול" —
 * end up behind the keyboard. The visual viewport does shrink. Lifting the sheet
 * by the keyboard's height and capping it to the visible height keeps the whole
 * sheet (scrollable) above the keyboard.
 *
 * Returns null when nothing covers the bottom (no keyboard, or no visualViewport):
 * the sheet then keeps its normal CSS.
 */
export type SheetViewportInset = { bottom: number; maxHeight: number };

export function keyboardSheetInset(
  layoutHeight: number,
  visual: { height: number; offsetTop: number } | null | undefined
): SheetViewportInset | null {
  if (!visual || !Number.isFinite(visual.height) || visual.height <= 0) return null;
  const covered = Math.round(layoutHeight - visual.height - Math.max(0, visual.offsetTop));
  if (covered < 1) return null;
  return { bottom: covered, maxHeight: Math.floor(visual.height * 0.92) };
}
