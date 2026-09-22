"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ActionSheet } from "./action-sheet";
import { useShellChromeHidden } from "./shell-chrome-visibility";
import { PRIMARY_DESTINATIONS, isNavActive } from "./nav-destinations";

/** Below in-app modals (~200); shell content is z-index 1 - bar stays above page for the strip only. */
export const BOTTOM_BAR_Z_INDEX = 100;

/**
 * Space for fixed bar + FAB lip + safe area - keep aligned with BottomBar layout constants below.
 */
export const SHELL_SCROLL_BOTTOM_PADDING =
  "calc(100px + env(safe-area-inset-bottom, 0px))";

const NAV_TOP_PAD = 8;
const NAV_BOTTOM_PAD = 12;
const ROW_MIN_H = 56;
const FAB_SIZE = 54;
const FAB_SLOT_SIZE = 68;
const FAB_LIFT = 16;

export function BottomBar() {
  const pathname = usePathname() || "/";
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [fabPressed, setFabPressed] = useState(false);
  const chromeHidden = useShellChromeHidden();
  const hasUnread = useUnreadNotifications(pathname);

  // A full-screen surface (e.g. a secretary sub-screen/modal) has requested the
  // shell chrome be hidden so its bottom CTA is not covered by the fixed bar.
  if (chromeHidden) return null;

  // Fixed, uniform navigation on every screen the bar appears on — no per-screen
  // variants. The four primary tabs come from the single nav source
  // (nav-destinations); the tablet/desktop sidebar renders the full list from
  // the same source, so the nav list is never duplicated.
  const tabs = PRIMARY_DESTINATIONS;

  // Unified Dubiz active state across every section of the app — the Documents
  // feature teal (Dubiz Mist brand), so the whole app shares one language.
  const activeColor = "var(--dz-nav-item-active)";
  const activeBg = "var(--dz-nav-item-active-bg)";
  const activeRing = "var(--dz-nav-item-active-ring)";
  const fabBackground =
    "var(--dz-nav-fab)";
  const fabShadow =
    "var(--dz-nav-fab-shadow)";

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
          background: "var(--dz-nav-surface)",
          backdropFilter: "blur(18px) saturate(160%)",
          WebkitBackdropFilter: "blur(18px) saturate(160%)",
          borderTop: "1px solid var(--dz-nav-border)",
          boxShadow: "var(--dz-nav-shadow)",
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
          // Home links to "/" but the authenticated home renders at "/app"
          // (via redirect); isNavActive treats both as the active home route.
          unread={hasUnread && tabs[0].key === "notifications"}
          active={isNavActive(pathname, tabs[0].href)}
          activeColor={activeColor}
          activeBg={activeBg}
          activeRing={activeRing}
        />
        <BarLink
          href={tabs[1].href}
          label={tabs[1].label}
          icon={tabs[1].icon}
          unread={hasUnread && tabs[1].key === "notifications"}
          active={isNavActive(pathname, tabs[1].href)}
          activeColor={activeColor}
          activeBg={activeBg}
          activeRing={activeRing}
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
              border: "1px solid rgba(255, 255, 255, 0.32)",
              background: fabBackground,
              color: "var(--dz-nav-fab-ink)",
              fontSize: 30,
              fontWeight: 300,
              lineHeight: 1,
              boxShadow: fabPressed
                ? "var(--dz-nav-fab-shadow-pressed)"
                : fabShadow,
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
            +
          </button>
        </span>
        <BarLink
          href={tabs[2].href}
          label={tabs[2].label}
          icon={tabs[2].icon}
          unread={hasUnread && tabs[2].key === "notifications"}
          active={isNavActive(pathname, tabs[2].href)}
          activeColor={activeColor}
          activeBg={activeBg}
          activeRing={activeRing}
        />
        <BarLink
          href={tabs[3].href}
          label={tabs[3].label}
          icon={tabs[3].icon}
          unread={hasUnread && tabs[3].key === "notifications"}
          active={isNavActive(pathname, tabs[3].href)}
          activeColor={activeColor}
          activeBg={activeBg}
          activeRing={activeRing}
        />
      </nav>
      <ActionSheet
        open={actionSheetOpen}
        onClose={() => setActionSheetOpen(false)}
      />
    </>
  );
}

/**
 * Whether anything is waiting in the notification centre.
 *
 * Read once per navigation rather than polled: the count changes when the
 * owner reads something, and re-reading on every route change is enough to
 * clear the dot right after they do. A failure leaves the dot off — a bell
 * that cries wolf because a request failed is worse than a quiet one.
 */
function useUnreadNotifications(pathname: string): boolean {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    let token: string | null = null;
    try {
      token = localStorage.getItem("token");
    } catch {
      token = null;
    }
    if (!token) return;

    let cancelled = false;
    fetch("/api/notifications/unread-count", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json && typeof json.unreadCount === "number") {
          setHasUnread(json.unreadCount > 0);
        }
      })
      .catch(() => {
        /* The bell stays quiet. */
      });

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return hasUnread;
}

function BarLink({
  href,
  label,
  icon: Icon,
  active,
  unread,
  activeColor,
  activeBg,
  activeRing,
}: {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => ReactNode;
  active: boolean;
  unread?: boolean;
  activeColor: string;
  activeBg: string;
  activeRing: string;
}) {
  const color = active ? activeColor : "var(--dz-nav-item)";

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
        background: active ? activeBg : "transparent",
        boxShadow: active
          ? `inset 0 0 0 1px ${activeRing}, var(--dz-nav-item-active-shadow)`
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
            position: "relative",
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
          {unread ? (
            <span
              style={{
                position: "absolute",
                top: -1,
                insetInlineEnd: -2,
                width: 8,
                height: 8,
                borderRadius: 999,
                background: "#eba58f",
                boxShadow: "0 0 0 2px var(--dz-nav-surface)",
              }}
            />
          ) : null}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: active ? 850 : 650,
            lineHeight: 1.2,
            letterSpacing: 0,
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
      {unread ? <span className="sr-only">יש התראות שלא נקראו</span> : null}
    </Link>
  );
}
