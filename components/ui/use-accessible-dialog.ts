"use client";

import { useEffect, useRef } from "react";

/**
 * Shared accessible-dialog behavior (Wave 2B · UI-005). One hook that gives every
 * modal the interaction contract that only the AccessibilityFab had before:
 *   - Escape closes.
 *   - focus is trapped inside the dialog (Tab / Shift+Tab wrap).
 *   - initial focus moves into the dialog when it opens.
 *   - focus is restored to the element that opened it when it closes.
 *   - background scroll is locked while open.
 *
 * The consumer attaches the returned ref to the dialog CONTENT element and sets the
 * ARIA on it (this hook can't add attributes to markup it doesn't own):
 *   const dialogRef = useAccessibleDialog({ isOpen, onClose });
 *   <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="…">
 * Pair with a backdrop `onClick={onClose}` and content `onClick={stopPropagation}`.
 */
export function useAccessibleDialog<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<T>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Remember what to restore focus to, then move focus into the dialog.
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = () =>
      dialogRef.current
        ? Array.from(
            dialogRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          ).filter((el) => el.offsetParent !== null || el === document.activeElement)
        : [];

    // Initial focus: first focusable, else the dialog container itself.
    const initial = focusables()[0] ?? dialogRef.current;
    initial?.focus();

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Trap: wrap at the ends and pull focus back if it escaped the dialog.
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey, true);

    // Scroll lock.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKey, true);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the opener.
      restoreFocusRef.current?.focus?.();
    };
  }, [isOpen, onClose]);

  return dialogRef;
}
