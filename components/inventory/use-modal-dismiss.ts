"use client";

import { useEffect } from "react";

/**
 * Listens for the Escape key while a modal is open and calls `onClose`.
 *
 * Pair with:
 *  - `onClick={onClose}` on the backdrop element
 *  - `onClick={(e) => e.stopPropagation()}` on the modal content element
 *
 * Keeps modal accessibility consistent across the inventory module
 * without introducing a shared modal component.
 */
export function useModalDismiss({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!isOpen) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);
}
