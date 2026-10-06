"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { BottomBar } from "./bottom-bar";
import { NavRail, NavSidebar } from "./side-nav";
import { useShellChromeHidden } from "./shell-chrome-visibility";

type ShellChromeProps = {
  children: ReactNode;
};

/** Routes drawn in the warm language — see `[data-dz-ground]` in dubiz-mist.css. */
const WARM_GROUND_PATHS = new Set(["/profile", "/settings", "/business/identity"]);

/**
 * Adaptive App Shell chrome — one shell, three device tiers, switched purely in
 * CSS (SSR-safe, no `window.innerWidth`, no hydration branch):
 *   mobile  (<768)      → fixed BottomBar with the raised "+"
 *   tablet  (768–1279)  → NavRail (100px)
 *   desktop (≥1280)     → NavSidebar (264px)
 *
 * The tiers and every measurement below come from the approved Home
 * references (mobile 390 / tablet 1194 / desktop 1440). All three surfaces read
 * the SAME nav source (nav-destinations) — the nav list is never duplicated.
 * Exactly one nav surface is visible at any width (mutually exclusive
 * `.shell-nav-*` display rules). The content reserves the matching inline-start
 * padding (RTL → right) for the rail/sidebar and the bottom padding for the
 * mobile bar.
 *
 * A single visibility signal (`useShellChromeHidden`) removes ALL nav chrome for
 * full-workspace screens (secretary / billing detail / revenue / bot) and drops
 * the offsets via `data-chrome="off"` — the existing contract, now centralized.
 */
const shellCss = `
[data-shell-root] .shell-content { padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
@media (min-width: 768px) {
  [data-shell-root][data-chrome="on"] .shell-content { padding-bottom: 32px; padding-inline-start: 100px; }
}
@media (min-width: 1280px) {
  [data-shell-root][data-chrome="on"] .shell-content { padding-inline-start: 264px; }
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
@media (min-width: 1280px) {
  [data-shell-root] .shell-nav-rail { display: none; }
  [data-shell-root] .shell-nav-sidebar { display: block; }
}

/* The references use the browser default line height, not the app's 1.5. */
.dz-rail, .dz-sidebar, [data-component="shell-bottom-bar"] { line-height: normal; }

/* ---- mobile bottom bar (reference: mobile.html) ---- */
.dz-bottom__item {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-height: 48px; justify-content: center;
  color: #5E6B69; font-size: 11px; font-weight: 500; text-decoration: none;
  touch-action: manipulation;
}
.dz-bottom__item[data-active] { color: #1D5552; font-weight: 600; }
.dz-bottom__icon { position: relative; height: 30px; display: flex; align-items: center; justify-content: center; }
.dz-bottom__item[data-active] .dz-bottom__icon { width: 56px; border-radius: 999px; background: #E3F2F0; }
.dz-bottom__dot { position: absolute; top: 4px; left: -2px; width: 7px; height: 7px; border-radius: 999px; background: #D2553D; }
.dz-bottom__item[data-active] .dz-bottom__dot { left: 16px; }
.dz-bottom__new {
  width: 58px; height: 58px; margin-top: -30px; border-radius: 999px;
  border: 4px solid #FEF8F2; background: #246966; color: #FFFFFF;
  display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
  box-shadow: 0 8px 18px -8px rgba(29,85,82,0.7);
  touch-action: manipulation;
}

/* ---- tablet rail (reference: tablet.html) ---- */
.dz-rail {
  position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 40;
  width: 100px; box-sizing: border-box; overflow-y: auto; overflow-x: hidden;
  background: #FFFDFA; border-inline-end: 1px solid #F0E3D3;
  padding: 24px 10px; display: flex; flex-direction: column; align-items: center; gap: 14px;
  direction: rtl;
}
.dz-rail__logo {
  width: 44px; height: 44px; flex-shrink: 0; border-radius: 14px;
  background: linear-gradient(150deg, #246966, #3D9C9A); color: #FFFFFF;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 22px; text-decoration: none;
}
.dz-rail__new {
  width: 56px; height: 56px; flex-shrink: 0; margin: 6px 0 10px; border-radius: 18px; border: 0;
  background: #246966; color: #FFFFFF; display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; box-shadow: 0 8px 18px -8px rgba(29,85,82,0.7);
}
.dz-rail__item {
  display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0;
  color: #5E6B69; font-size: 12px; font-weight: 500; text-decoration: none;
}
.dz-rail__item[data-active] { color: #1D5552; font-weight: 600; }
.dz-rail__icon { position: relative; height: 34px; display: flex; align-items: center; justify-content: center; }
.dz-rail__item[data-active] .dz-rail__icon { width: 60px; border-radius: 999px; background: #E3F2F0; }
.dz-rail__dot { position: absolute; top: 5px; left: -2px; width: 7px; height: 7px; border-radius: 999px; background: #D2553D; }
.dz-rail__item[data-active] .dz-rail__dot { left: 18px; }

/* ---- desktop sidebar (reference: desktop.html) ---- */
.dz-sidebar {
  position: fixed; inset-block: 0; inset-inline-start: 0; z-index: 40;
  width: 264px; box-sizing: border-box; overflow-y: auto; overflow-x: hidden;
  background: #FFFDFA; border-inline-end: 1px solid #F0E3D3;
  padding: 22px 14px; display: flex; flex-direction: column; gap: 14px;
  color: #1E2B2A; direction: rtl;
}
.dz-sidebar__brand { display: flex; align-items: center; gap: 10px; padding: 0 8px; text-decoration: none; }
.dz-sidebar__mark {
  width: 36px; height: 36px; border-radius: 11px; background: linear-gradient(150deg, #246966, #3D9C9A);
  color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 19px;
}
.dz-sidebar__word { font-size: 25px; font-weight: 600; color: #246966; letter-spacing: -0.5px; }
.dz-sidebar__business {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 56px; box-sizing: border-box; flex-shrink: 0;
  padding: 0 12px; border-radius: 14px; border: 1px solid #F0E3D3; background: #FEF8F2; color: #1E2B2A;
  text-decoration: none; transition: background 150ms ease, border-color 150ms ease;
}
.dz-sidebar__business:hover { background: #FBF3EA; border-color: #E8D6C0; }
.dz-sidebar__business[aria-current="page"] { border-color: #BFD8D5; background: #EEF7F5; }
.dz-sidebar__business-mark {
  width: 34px; height: 34px; flex-shrink: 0; border-radius: 10px; background: #FBEEDD; color: #A0601F;
  display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px;
}
.dz-sidebar__business-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dz-sidebar__actions { display: grid; grid-template-columns: minmax(0, 1fr) 44px; gap: 8px; }
.dz-sidebar__new {
  height: 44px; border-radius: 12px; border: 0; background: #246966; color: #FFFFFF;
  font-family: inherit; font-size: 14px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px;
  cursor: pointer; box-shadow: 0 8px 18px -10px rgba(29,85,82,0.7);
}
.dz-sidebar__search {
  height: 44px; border-radius: 12px; border: 1px solid #F0E3D3; background: #FEF8F2; color: #1E2B2A;
  display: flex; align-items: center; justify-content: center; box-sizing: border-box;
}
.dz-sidebar__group { display: flex; flex-direction: column; gap: 1px; }
.dz-sidebar__group-title { display: flex; align-items: center; gap: 8px; padding: 4px 12px; font-size: 11px; font-weight: 600; color: #5E6B69; letter-spacing: 0.2px; }
.dz-sidebar__item {
  display: flex; align-items: center; gap: 12px; height: 40px; flex-shrink: 0; padding: 0 12px; border-radius: 11px;
  color: #3B4544; text-decoration: none; font-size: 14px; font-weight: 400;
  transition: background 150ms ease, color 150ms ease;
}
.dz-sidebar__item:hover { background: #FBF3EA; color: #1D5552; }
.dz-sidebar__item[data-active] { background: #E3F2F0; color: #1D5552; font-weight: 600; }
/* The accessibility entry is a <button> dressed as a nav item. */
button.dz-rail__item, button.dz-sidebar__item {
  border: 0; background: transparent; font-family: inherit; cursor: pointer; padding-block: 0; text-align: start;
}
button.dz-sidebar__item { width: 100%; padding-inline: 12px; }
button.dz-rail__item { padding-inline: 0; }
.dz-sidebar__badge { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 7px; }

.dz-rail a:focus-visible, .dz-rail button:focus-visible,
.dz-sidebar a:focus-visible, .dz-sidebar button:focus-visible,
[data-component="shell-bottom-bar"] a:focus-visible, [data-component="shell-bottom-bar"] button:focus-visible {
  outline: 2px solid #246966; outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) { .dz-sidebar__item { transition: none; } }
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
   * that ever renders it. Flagging the route lets `app/dubiz-mist.css` paint the
   * shell ground in the Home canvas colour, so nothing shows behind the screen.
   *
   * `usePathname` resolves during SSR in the App Router, so the attribute is
   * present on the very first paint — no flash, no hydration branch.
   */
  const isHome = pathname === "/app";

  /**
   * Screens drawn in the warm language paint their own cream canvas; the shell
   * ground around and below them must match or a Mist band shows under the
   * content. Exact paths only — the Settings sub-pages are still Mist screens.
   */
  const isWarmGround = WARM_GROUND_PATHS.has(pathname);

  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-full flex-col"
      data-shell-root
      data-chrome={chromeHidden ? "off" : "on"}
      data-dz-home={isHome ? "1" : undefined}
      data-dz-ground={isWarmGround ? "warm" : undefined}
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
            <NavRail />
          </div>
          <div className="shell-nav-sidebar">
            <NavSidebar />
          </div>
        </>
      )}
    </div>
  );
}
