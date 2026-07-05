"use client";

import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

/**
 * useAccessibleDialog — the shared WP1 A-18 dialog primitive.
 *
 * Implements the WP1 A-11 dialog requirements ONCE so every dialog inherits them
 * instead of re-deriving focus management, keyboard behavior, and ARIA wiring:
 *   - role="dialog" + aria-modal="true"
 *   - aria-labelledby / aria-label / aria-describedby wiring
 *   - focus MOVED into the dialog on open, and RESTORED to the opener on close
 *   - focus TRAP (Tab / Shift+Tab cycle stays inside the dialog)
 *   - Escape to close
 *   - background made `inert` while open (siblings of the dialog's top-level
 *     container), plus body scroll lock
 *
 * Usage (spread the returned props; do not re-declare role/aria/onKeyDown):
 *   const { dialogProps, backdropProps } = useAccessibleDialog({
 *     open, onClose, ariaLabel: "...",  // or labelledById / describedById
 *   });
 *   return (
 *     <div {...backdropProps} style={overlayStyle}>
 *       <div {...dialogProps} style={panelStyle}>...</div>
 *     </div>
 *   );
 *
 * This is the default for every NEW dialog in Dubiz (supersedes the Escape-only
 * `useModalDismiss`). A developer gets a compliant dialog without memorising WP1.
 */
export type UseAccessibleDialogOptions = {
  /** Whether the dialog is currently open (drives focus/inert/keyboard effects). */
  open: boolean;
  /** Called on Escape and on backdrop click (unless `disableClose`). */
  onClose: () => void;
  /** Accessible name via a visible title element id (preferred). */
  labelledById?: string;
  /** Accessible name as a literal string (use when there is no visible title id). */
  ariaLabel?: string;
  /** Optional description element id. */
  describedById?: string;
  /** When true, Escape and backdrop click are ignored (e.g. while saving). */
  disableClose?: boolean;
  /**
   * Id of the element to focus on open (e.g. the first form field). When omitted,
   * focus moves to the first focusable element in the dialog.
   */
  initialFocusId?: string;
};

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useAccessibleDialog<T extends HTMLElement = HTMLElement>({
  open,
  onClose,
  labelledById,
  ariaLabel,
  describedById,
  disableClose = false,
  initialFocusId,
}: UseAccessibleDialogOptions) {
  const dialogRef = useRef<T | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Escape to close. stopPropagation keeps a parent surface (e.g. a wrapping
  // sheet) from also acting on the same Escape — this dialog owns the dismissal.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !disableClose) {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, disableClose, onClose]);

  // Move focus into the dialog on open; restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    const node = dialogRef.current;
    const preferred = initialFocusId
      ? node?.querySelector<HTMLElement>(`#${initialFocusId}`)
      : null;
    const target = preferred ?? node?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (target ?? node)?.focus?.();

    return () => {
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, initialFocusId]);

  // Make everything outside the dialog inert + lock body scroll while open.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const node = dialogRef.current;
    // The dialog's top-level container under <body> (its portal root, or the app
    // root if rendered inline). We inert every OTHER top-level container.
    const container = Array.from(document.body.children).find((child) =>
      child.contains(node)
    );
    const inerted = Array.from(document.body.children).filter(
      (child) => child !== container
    );
    inerted.forEach((el) => el.setAttribute("inert", ""));

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      inerted.forEach((el) => el.removeAttribute("inert"));
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Keyboard focus trap (Tab / Shift+Tab cycle inside the dialog).
  function onDialogKeyDown(event: ReactKeyboardEvent<T>) {
    if (event.key !== "Tab") return;
    const node = dialogRef.current;
    const focusables = node?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!focusables || focusables.length === 0) return;

    const list = Array.from(focusables).filter((el) => !el.hasAttribute("disabled"));
    if (list.length === 0) return;

    const firstEl = list[0];
    const lastEl = list[list.length - 1];
    if (event.shiftKey && document.activeElement === firstEl) {
      event.preventDefault();
      lastEl.focus();
    } else if (!event.shiftKey && document.activeElement === lastEl) {
      event.preventDefault();
      firstEl.focus();
    }
  }

  const dialogProps = {
    ref: dialogRef,
    role: "dialog" as const,
    "aria-modal": true as const,
    "aria-labelledby": labelledById,
    "aria-label": labelledById ? undefined : ariaLabel,
    "aria-describedby": describedById,
    tabIndex: -1,
    onKeyDown: onDialogKeyDown,
  };

  const backdropProps = {
    role: "presentation" as const,
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (!disableClose && event.target === event.currentTarget) {
        onClose();
      }
    },
  };

  return { dialogRef, dialogProps, backdropProps };
}
