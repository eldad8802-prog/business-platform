"use client";

import { Suspense } from "react";
import RedeemScreen from "@/components/revenue/redeem/redeem-screen";
import { useHideShellChrome } from "@/components/navigation/shell-chrome-visibility";
import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { LAYOUT, type PageSurfaceIntent } from "@/lib/design/tokens";

/**
 * Redemption is a MANAGEMENT surface: the owner scans a customer's coupon at the
 * counter. It is genuinely mobile-first — a camera and one input — so the
 * compact composition is left exactly as it is, and only the chrome policy
 * changes: below the shell's desktop tier the scanner keeps the full viewport,
 * and from 1024 up the sidebar is available so the owner is not stranded here.
 */
const SHELL_DESKTOP_MIN = `(min-width: ${LAYOUT.bp.expanded}px)`;
const SURFACE_INTENT: PageSurfaceIntent = "focused";

export default function RevenueRedeemPage() {
  const isDesktop = useMediaQuery(SHELL_DESKTOP_MIN);
  useHideShellChrome(!isDesktop);
  return (
    <div data-page-intent={SURFACE_INTENT}>
      <Suspense fallback={null}>
        <RedeemScreen />
      </Suspense>
    </div>
  );
}
