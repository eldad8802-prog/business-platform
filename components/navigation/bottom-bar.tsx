"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ActionSheet } from "./action-sheet";

/** Below in-app modals (~200); shell content is z-index 1 — bar stays above page for the strip only. */
export const BOTTOM_BAR_Z_INDEX = 100;

/**
 * Space for fixed bar + FAB lip + safe area — keep aligned with BottomBar layout constants below.
 */
export const SHELL_SCROLL_BOTTOM_PADDING =
  "calc(100px + env(safe-area-inset-bottom, 0px))";

function isActive(pathname: string, href: string) {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

const NAV_TOP_PAD = 8;
const NAV_BOTTOM_PAD = 12;
const ROW_MIN_H = 56;
const FAB_SIZE = 50;
const FAB_SLOT_SIZE = 62;
const FAB_LIFT = 14;

type TabDef = {
  key: string;
  label: string;
  href: string;
  icon: (props: { active: boolean }) => ReactNode;
};

export function BottomBar() {
  const pathname = usePathname() || "/";
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [fabPressed, setFabPressed] = useState(false);

  const tabs: TabDef[] = [
    { key: "home", label: "בית", href: "/", icon: IconHome },
    { key: "chats", label: "שיחות", href: "/inbox", icon: IconChat },
    { key: "docs", label: "מסמכים", href: "/documents", icon: IconDocs },
    { key: "more", label: "עוד", href: "/settings", icon: IconMore },
  ];

  return (
    <>
      <nav
        dir="rtl"
        data-component="shell-bottom-bar"
        aria-label="ניווט תחתון"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: BOTTOM_BAR_Z_INDEX,
          width: "100%",
          maxWidth: "100vw",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 6,
          paddingTop: NAV_TOP_PAD,
          paddingLeft: 8,
          paddingRight: 8,
          paddingBottom: `calc(${NAV_BOTTOM_PAD}px + env(safe-area-inset-bottom, 0px))`,
          background: "rgba(255, 255, 255, 0.76)",
          backdropFilter: "blur(18px) saturate(160%)",
          WebkitBackdropFilter: "blur(18px) saturate(160%)",
          borderTop: "1px solid rgba(15, 23, 42, 0.06)",
          boxShadow:
            "0 1px 0 rgba(255, 255, 255, 0.65) inset, 0 -6px 28px rgba(15, 23, 42, 0.045)",
          WebkitTapHighlightColor: "transparent",
          height: "fit-content",
          maxHeight: "132px",
          pointerEvents: "auto",
        }}
      >
        <BarLink
          href={tabs[0].href}
          label={tabs[0].label}
          icon={tabs[0].icon}
          active={isActive(pathname, tabs[0].href)}
        />
        <BarLink
          href={tabs[1].href}
          label={tabs[1].label}
          icon={tabs[1].icon}
          active={isActive(pathname, tabs[1].href)}
        />
        <span
          style={{
            flex: "0 0 auto",
            width: FAB_SLOT_SIZE,
            minWidth: FAB_SLOT_SIZE,
            alignSelf: "flex-end",
            marginBottom: NAV_BOTTOM_PAD,
            marginTop: -FAB_LIFT,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <button
            type="button"
            aria-label="פעולות מהירות"
            aria-expanded={actionSheetOpen}
            onClick={() => setActionSheetOpen(true)}
            onPointerDown={() => setFabPressed(true)}
            onPointerUp={() => setFabPressed(false)}
            onPointerLeave={() => setFabPressed(false)}
            onPointerCancel={() => setFabPressed(false)}
            style={{
              width: FAB_SIZE,
              height: FAB_SIZE,
              minWidth: FAB_SIZE,
              minHeight: FAB_SIZE,
              borderRadius: 999,
              border: "1px solid rgba(255, 255, 255, 0.28)",
              background:
                "linear-gradient(165deg, #2dd4bf 0%, #0f766e 48%, #0d5c54 100%)",
              color: "#ffffff",
              fontSize: 26,
              fontWeight: 300,
              lineHeight: 1,
              boxShadow: fabPressed
                ? "0 4px 14px rgba(15, 118, 110, 0.35)"
                : "0 8px 24px rgba(15, 118, 110, 0.42), 0 2px 8px rgba(15, 23, 42, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
              paddingBottom: 2,
              touchAction: "manipulation",
              WebkitTapHighlightColor: "transparent",
              pointerEvents: "auto",
              transform: fabPressed ? "scale(0.94)" : "scale(1)",
              transition:
                "transform 0.14s cubic-bezier(0.32, 0.72, 0, 1), box-shadow 0.14s ease",
            }}
          >
            ＋
          </button>
        </span>
        <BarLink
          href={tabs[2].href}
          label={tabs[2].label}
          icon={tabs[2].icon}
          active={isActive(pathname, tabs[2].href)}
        />
        <BarLink
          href={tabs[3].href}
          label={tabs[3].label}
          icon={tabs[3].icon}
          active={isActive(pathname, tabs[3].href)}
        />
      </nav>
      <ActionSheet
        open={actionSheetOpen}
        onClose={() => setActionSheetOpen(false)}
      />
    </>
  );
}

function BarLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => ReactNode;
  active: boolean;
}) {
  const color = active ? "#0f766e" : "#64748b";

  return (
    <Link
      href={href}
      prefetch={false}
      style={{
        flex: 1,
        minWidth: 0,
        maxWidth: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: ROW_MIN_H,
        padding: "6px 4px",
        borderRadius: 14,
        textDecoration: "none",
        color,
        background: active ? "rgba(15, 118, 110, 0.11)" : "transparent",
        boxShadow: active
          ? "inset 0 0 0 1px rgba(15, 118, 110, 0.2), 0 1px 2px rgba(15, 118, 110, 0.06)"
          : "none",
        touchAction: "manipulation",
        WebkitTapHighlightColor: "transparent",
        pointerEvents: "auto",
        transition: "background 0.15s ease, box-shadow 0.15s ease, color 0.15s ease",
      }}
    >
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          minWidth: 48,
          minHeight: 48,
          maxWidth: "100%",
        }}
      >
        <span
          style={{
            display: "flex",
            width: 24,
            height: 24,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
            color,
          }}
          aria-hidden
        >
          <Icon active={active} />
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: active ? 800 : 600,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            textAlign: "center",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      </span>
    </Link>
  );
}

function IconHome({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5z"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChat({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconDocs({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M9 13h6M9 17h6"
        stroke="currentColor"
        strokeWidth={w}
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMore({ active }: { active: boolean }) {
  const r = active ? 2.1 : 1.85;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="12" r={r} fill="currentColor" />
      <circle cx="12" cy="12" r={r} fill="currentColor" />
      <circle cx="18" cy="12" r={r} fill="currentColor" />
    </svg>
  );
}
