"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Removes a one-shot query flag (e.g. `?new=1` from the "+" action sheet) once
 * the screen has read it into its own state. Without this, returning to the
 * screen (back, refresh) would re-trigger the action — a create form reopening
 * on every visit. Uses `replace` with no scroll, so no history entry is added
 * and the screen keeps its state.
 */
export function useConsumeQueryFlag(name: string): void {
  const router = useRouter();
  const searchParams = useSearchParams();
  const present = searchParams?.has(name) ?? false;

  useEffect(() => {
    if (!present) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  }, [present, name, router]);
}
