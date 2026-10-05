"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ActionSheet } from "./action-sheet";
import { useShellChromeHidden } from "./shell-chrome-visibility";
import { PRIMARY_DESTINATIONS, isNavActive, type NavDestination } from "./nav-destinations";
import { IconPlus } from "./nav-icons";

/** Below in-app modals (~200); shell content is z-index 1 - bar stays above page for the strip only. */
export const BOTTOM_BAR_Z_INDEX = 100;

/** Space for the fixed bar + the raised "+" + the safe area. */
export const SHELL_SCROLL_BOTTOM_PADDING =
  "calc(100px + env(safe-area-inset-bottom, 0px))";

/** The approved mobile reference: an 84px bar, five equal columns. */
const BAR_HEIGHT = 84;

/**
 * Mobile bottom navigation (<768), drawn from the approved mobile reference:
 * בית · שיחות · [+] · מסמכים · התראות, the active tab marked by a pill behind
 * its icon, and a raised 58px "+" in the middle that opens the quick actions.
 *
 * The tabs come from the single nav source (nav-destinations), so the list is
 * never duplicated with the rail or the sidebar.
 */
export function BottomBar() {
  const pathname = usePathname() || "/";
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const chromeHidden = useShellChromeHidden();
  const hasUnread = useUnreadNotifications(pathname);

  // A full-screen surface (e.g. a secretary sub-screen/modal) has requested the
  // shell chrome be hidden so its bottom CTA is not covered by the fixed bar.
  if (chromeHidden) return null;

  const tabs = PRIMARY_DESTINATIONS;

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
          boxSizing: "border-box",
          height: `calc(${BAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          alignItems: "center",
          padding: "0 8px calc(12px + env(safe-area-inset-bottom, 0px)) 8px",
          background: "#FFFDFA",
          borderTop: "1px solid #F0E3D3",
          fontFamily: "var(--font-rubik), 'Heebo', system-ui, sans-serif",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <BarLink dest={tabs[0]} active={isNavActive(pathname, tabs[0].href)} unread={hasUnread && tabs[0].key === "notifications"} />
        <BarLink dest={tabs[1]} active={isNavActive(pathname, tabs[1].href)} unread={hasUnread && tabs[1].key === "notifications"} />
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            aria-label="פעולה חדשה"
            aria-expanded={actionSheetOpen}
            onClick={() => setActionSheetOpen(true)}
            className="dz-bottom__new"
          >
            <IconPlus size={24} strokeWidth={2.2} />
          </button>
        </div>
        <BarLink dest={tabs[2]} active={isNavActive(pathname, tabs[2].href)} unread={hasUnread && tabs[2].key === "notifications"} />
        <BarLink dest={tabs[3]} active={isNavActive(pathname, tabs[3].href)} unread={hasUnread && tabs[3].key === "notifications"} />
      </nav>
      <ActionSheet open={actionSheetOpen} onClose={() => setActionSheetOpen(false)} />
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

function BarLink({ dest, active, unread }: { dest: NavDestination; active: boolean; unread: boolean }) {
  const Icon = dest.icon;
  return (
    <Link
      href={dest.href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className="dz-bottom__item"
      data-active={active ? "1" : undefined}
    >
      <span className="dz-bottom__icon">
        <Icon size={20} strokeWidth={active ? 2 : 1.8} />
        {unread ? <span className="dz-bottom__dot" aria-hidden /> : null}
      </span>
      {dest.label}
      {unread ? <span className="sr-only">יש התראות שלא נקראו</span> : null}
    </Link>
  );
}
