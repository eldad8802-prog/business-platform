"use client";

import type { ReactNode } from "react";
import { TOKEN } from "@/lib/design/tokens";
import { BottomBar } from "./bottom-bar";
import { SideNav } from "./side-nav";
import { useShellChromeHidden } from "./shell-chrome-visibility";

type ShellChromeProps = {
  children: ReactNode;
};

const d = TOKEN.dsv1;

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
  background: ${d.card};
  border-inline-end: 1px solid ${d.line};
  box-shadow: 0 1px 2px rgba(88, 62, 38, 0.05), 8px 0 22px rgba(120, 88, 52, 0.04);
  overflow-y: auto;
  overflow-x: hidden;
  direction: rtl;
}
.shell-sidenav--full { width: 248px; padding: 18px 14px; }
.shell-sidenav--rail { width: 76px; padding: 18px 10px; align-items: center; }

.shell-brand { display: flex; align-items: center; height: 44px; margin-bottom: 14px; padding-inline-start: 8px; }
.shell-sidenav--rail .shell-brand { justify-content: center; padding: 0; }
.shell-brand__word { font-size: 20px; font-weight: 600; letter-spacing: -0.4px; color: ${d.accent}; }
.shell-brand__mark { width: 34px; height: 34px; border-radius: 10px; background: ${d.successBg}; color: ${d.accent}; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 600; }

.shell-navlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; width: 100%; }
.shell-navitem {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  color: ${d.muted};
  text-decoration: none;
  font-size: 14.5px;
  font-weight: 500;
  transition: background 150ms ease, color 150ms ease;
}
.shell-sidenav--rail .shell-navitem { justify-content: center; width: 52px; height: 52px; padding: 0; margin-inline: auto; gap: 0; }
.shell-navitem__icon { display: flex; width: 22px; height: 22px; align-items: center; justify-content: center; flex-shrink: 0; }
.shell-navitem:hover { background: ${d.surface2}; color: ${d.ink}; }
.shell-navitem[aria-current="page"] { background: ${d.successBg}; color: ${d.accent}; font-weight: 600; }
.shell-navitem[aria-current="page"]::before {
  content: ""; position: absolute; inset-inline-start: 0; top: 50%; transform: translateY(-50%);
  width: 3px; height: 22px; border-radius: 999px; background: ${d.accent};
}
.shell-sidenav--rail .shell-navitem[aria-current="page"]::before { height: 26px; }
.shell-navitem:focus-visible { outline: 2px solid ${d.accent}; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .shell-navitem { transition: none; } }
`;

/**
 * Shell chrome: main scroll area + adaptive navigation (bottom bar / rail /
 * sidebar). Wrapped by `app/(shell)/layout.tsx`.
 */
export function ShellChrome({ children }: ShellChromeProps) {
  const chromeHidden = useShellChromeHidden();

  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-full flex-col"
      data-shell-root
      data-chrome={chromeHidden ? "off" : "on"}
      style={{ background: "var(--background, #ffffff)" }}
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
