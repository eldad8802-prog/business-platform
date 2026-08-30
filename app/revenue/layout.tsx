import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";

/**
 * Revenue shell.
 *
 * Until now `/revenue` had **no layout at all** — unlike `/offers` and
 * `/coupon-design`, which wrap themselves in `ShellChrome`. So the absence of
 * navigation across the entire Revenue feature was structural, not a hook call:
 * there was no chrome to hide. That is why the Billing fix (relaxing a
 * `useHideShellChrome(true)`) does not transfer; the chrome has to exist first.
 *
 * This layout supplies it. It deliberately covers management **and** consumer
 * routes, because they share the `/revenue` prefix, and each page then declares
 * its own chrome policy — which is the honest place for that decision, since it
 * follows from what the surface *is*:
 *
 *   /revenue            MANAGEMENT — chrome from the shell's desktop tier up
 *   /revenue/redeem     MANAGEMENT — same
 *   /revenue/coupons/*  CONSUMER   — never; a customer's coupon is not a
 *                                    management surface and must not grow the
 *                                    owner's navigation
 *
 * With chrome suppressed the shell renders `data-chrome="off"` and drops its
 * offsets, so a surface that opts out is laid out exactly as it was before this
 * layout existed.
 */
export default function RevenueLayout({ children }: { children: ReactNode }) {
  return <ShellChrome>{children}</ShellChrome>;
}
