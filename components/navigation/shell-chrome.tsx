"use client";

import type { ReactNode } from "react";
import { BottomBar, SHELL_SCROLL_BOTTOM_PADDING } from "./bottom-bar";

type ShellChromeProps = {
  children: ReactNode;
};

/**
 * Runtime diagnostics — flip before merge / production.
 * Step A (device): DEBUG_SHELL_MARKER=true, ENABLE_SHELL_BOTTOM_BAR=true — confirm red banner + reproduce.
 * Step B (device): DEBUG_SHELL_MARKER=true, ENABLE_SHELL_BOTTOM_BAR=false — if issues vanish, blocker is BottomBar/stacking.
 */
const DEBUG_SHELL_MARKER = false;
const ENABLE_SHELL_BOTTOM_BAR = true;

const CONTENT_PADDING_BOTTOM = ENABLE_SHELL_BOTTOM_BAR
  ? SHELL_SCROLL_BOTTOM_PADDING
  : "calc(8px + env(safe-area-inset-bottom, 0px))";

/**
 * Shell chrome: main scroll area + optional fixed bottom nav.
 */
export function ShellChrome({ children }: ShellChromeProps) {
  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-full flex-col"
      data-shell-root
      data-shell-bottom-bar={ENABLE_SHELL_BOTTOM_BAR ? "on" : "off"}
      style={{ background: "var(--background, #ffffff)" }}
    >
      {DEBUG_SHELL_MARKER ? (
        <div
          data-shell-debug="active"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 99999,
            padding: "4px 8px",
            fontSize: 11,
            fontWeight: 800,
            textAlign: "center",
            background: "#b91c1c",
            color: "#fff",
            pointerEvents: "none",
          }}
        >
          SHELL DEBUG ACTIVE
        </div>
      ) : null}
      <div
        id="main-content"
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden"
        style={{
          position: "relative",
          zIndex: 1,
          paddingBottom: CONTENT_PADDING_BOTTOM,
        }}
      >
        {children}
      </div>
      {ENABLE_SHELL_BOTTOM_BAR ? <BottomBar /> : null}
    </div>
  );
}
