"use client";

import { useRouter } from "next/navigation";
import BackButton from "@/components/ui/back-button";

/**
 * SmartBackButton — history-aware "חזרה" for deep-linkable detail/sub screens.
 *
 * The system-wide rule is that back returns the user to the PREVIOUS SCREEN they
 * were on, not to a fixed parent that may differ from where they came. A plain
 * `href` on a detail page breaks that: a user who reached it from search/dashboard
 * would be thrown to the fixed parent instead of back to search.
 *
 * This uses the browser history when it exists (router.back → the real previous
 * screen) and only falls back to `fallbackHref` when there is no history to go
 * back to (a fresh deep link, QR/email open, or hard refresh) so we never
 * dead-end on a blank screen. Extracted from the secretary's proven BackControl.
 *
 * Use this for deep-linkable detail/sub pages. Genuine wizard steps should keep a
 * fixed `href` to the previous step (that is the intended exception to the rule),
 * and top-level hubs may keep a deliberate fixed exit.
 */
export default function SmartBackButton({
  fallbackHref,
  label,
}: {
  fallbackHref: string;
  label?: string;
}) {
  const router = useRouter();

  return (
    <BackButton
      label={label}
      onClick={() => {
        if (typeof window !== "undefined" && window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
    />
  );
}
