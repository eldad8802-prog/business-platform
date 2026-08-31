"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BottomBar } from "./bottom-bar";
import { SideNav } from "./side-nav";
import { useShellChromeHidden } from "./shell-chrome-visibility";

type ShellChromeProps = {
  children: ReactNode;
};


/**
 * Adaptive App Shell chrome — one shell, three device tiers, switched purely in
 * CSS (SSR-safe, no `window.innerWidth`, no hydration branch):
 *   mobile  (<768)      → fixed BottomBar + FAB (unchanged)
 *   tablet  (768–1023)  → compact SideNav rail (76px)
 *   desktop (≥1024)     → full SideNav sidebar (248px)
 *
 * All three read the SAME nav source (nav-destinations) — the nav list is never
 * duplicated. Exactly one nav surface is visible at any width (mutually
 * exclusive `.shell-nav-*` display rules). The content reserves the matching
 * inline-start padding (RTL → right) for the rail/sidebar and the bottom padding
 * for the mobile bar.
 *
 * A single visibility signal (`useShellChromeHidden`) removes ALL nav chrome for
 * full-workspace screens (secretary / billing detail / revenue / bot) and drops
 * the offsets via `data-chrome="off"` — the existing contract, now centralized.
 */
const shellCss = `
[data-shell-root] .shell-content { padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
@media (min-width: 768px) {
  [data-shell-root][data-chrome="on"] .shell-content { padding-bottom: 32px; padding-inline-start: 76px; }
}
@media (min-width: 1024px) {
  [data-shell-root][data-chrome="on"] .shell-content { padding-inline-start: 248px; }
}
[data-shell-root][data-chrome="off"] .shell-content { padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); padding-inline-start: 0; }

/* Mutually-exclusive nav visibility — pure CSS, no JS, no hydration branch. */
[data-shell-root] .shell-nav-mobile { display: block; }
[data-shell-root] .shell-nav-rail { display: none; }
[data-shell-root] .shell-nav-sidebar { display: none; }
@media (min-width: 768px) {
  [data-shell-root] .shell-nav-mobile { display: none; }
  [data-shell-root] .shell-nav-rail { display: block; }
}
@media (min-width: 1024px) {
  [data-shell-root] .shell-nav-rail { display: none; }
  [data-shell-root] .shell-nav-sidebar { display: block; }
}

/* SideNav (rail + sidebar) — DS v1 warm; fixed to the inline-start (right in RTL). */
.shell-sidenav {
  position: fixed;
  inset-block: 0;
  inset-inline-start: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--dz-nav-sidebar-surface);
  border-inline-end: 1px solid var(--dz-nav-sidebar-border);
  box-shadow: var(--dz-nav-sidebar-shadow);
  overflow-y: auto;
  overflow-x: hidden;
  direction: rtl;
}
.shell-sidenav--full { width: 248px; padding: 18px 14px; }
.shell-sidenav--rail { width: 76px; padding: 18px 10px; align-items: center; }

.shell-brand { display: flex; align-items: center; height: 44px; margin-bottom: 14px; padding-inline-start: 8px; }
.shell-sidenav--rail .shell-brand { justify-content: center; padding: 0; }
.shell-brand__word { font-size: 20px; font-weight: 600; letter-spacing: -0.4px; color: var(--dz-nav-brand-word); }
.shell-brand__mark { width: 34px; height: 34px; border-radius: 10px; background: var(--dz-nav-brand-mark-bg); color: var(--dz-nav-brand-word); display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600; }

.shell-navlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; width: 100%; }
.shell-navitem {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  color: var(--dz-nav-sidebar-item);
  text-decoration: none;
  font-size: 14.5px;
  font-weight: 500;
  transition: background 150ms ease, color 150ms ease;
}
.shell-sidenav--rail .shell-navitem { justify-content: center; width: 52px; height: 52px; padding: 0; margin-inline: auto; gap: 0; }
.shell-navitem__icon { display: flex; width: 22px; height: 22px; align-items: center; justify-content: center; flex-shrink: 0; }
.shell-navitem:hover { background: var(--dz-nav-item-hover-bg); color: var(--dz-nav-item-hover-ink); }
.shell-navitem[aria-current="page"] { background: var(--dz-nav-item-active-bg); color: var(--dz-nav-item-active); font-weight: 600; }
.shell-navitem[aria-current="page"]::before {
  content: ""; position: absolute; inset-inline-start: 0; top: 50%; transform: translateY(-50%);
  width: 3px; height: 22px; border-radius: 999px; background: var(--dz-nav-item-active);
}
.shell-sidenav--rail .shell-navitem[aria-current="page"]::before { height: 26px; }
.shell-navitem:focus-visible { outline: 2px solid var(--dz-nav-item-active); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .shell-navitem { transition: none; } }
`;

/**
 * Shell chrome: main scroll area + adaptive navigation (bottom bar / rail /
 * sidebar). Wrapped by `app/(shell)/layout.tsx`.
 */
export function ShellChrome({ children }: ShellChromeProps) {
  const chromeHidden = useShellChromeHidden();
  const pathname = usePathname() || "/";

  /**
   * Home exclusion (Dubiz Mist §12). The authenticated Dubiz home is `/app` —
   * `app/(shell)/page.tsx` redirects `/` there, so `/app` is the only pathname
   * that ever renders it. The screen itself is self-scoped under `.dzhome` and
   * reads no platform token, so the ONLY shared surfaces that paint on it are
   * the nav chrome below. Flagging the route here restores their pre-Mist
   * values through the `[data-dz-home]` block in `app/dubiz-mist.css`, which is
   * what makes the Home guarantee pixel-exact rather than approximate.
   *
   * `usePathname` resolves during SSR in the App Router, so the attribute is
   * present on the very first paint — no flash, no hydration branch.
   */
  const isHome = pathname === "/app";

  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-full flex-col"
      data-shell-root
      data-chrome={chromeHidden ? "off" : "on"}
      data-dz-home={isHome ? "1" : undefined}
      style={{ background: "var(--dz-shell-ground)" }}
    >
      <style>{shellCss}</style>

      <div
        className="shell-content min-h-0 min-w-0 flex-1 overflow-x-hidden"
        style={{ position: "relative", zIndex: 1 }}
      >
        {children}
      </div>

      {chromeHidden ? null : (
        <>
          <div className="shell-nav-mobile">
            <BottomBar />
          </div>
          <div className="shell-nav-rail">
            <SideNav compact />
          </div>
          <div className="shell-nav-sidebar">
            <SideNav />
          </div>
        </>
      )}
    </div>
  );
}
