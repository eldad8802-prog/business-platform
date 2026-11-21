"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ActionSheet } from "./action-sheet";
import { useShellChromeHidden } from "./shell-chrome-visibility";
import { isNavActive, type NavDestination } from "./nav-destinations";
import { usePrimaryDestinations } from "./use-primary-destinations";
import { IconPlus } from "./nav-icons";
import { isResolvedActive, useLocationSearch, useNavHref } from "./use-nav-href";
import { useI18n } from "@/components/i18n/I18nProvider";

/** Below in-app modals (~200); shell content is z-index 1 - bar stays above page for the strip only. */
export const BOTTOM_BAR_Z_INDEX = 100;

/** Space for the floating bar (64 + 10 gap) + breathing room + the safe area. */
export const SHELL_SCROLL_BOTTOM_PADDING =
  "calc(100px + env(safe-area-inset-bottom, 0px))";

/** HOME v4 reference: a 64px floating bar, 12px from the sides, 10px above the safe area. */
const BAR_HEIGHT = 64;

/**
 * Mobile bottom navigation (<768) — HOME v4 (owner-approved reference): a FLOATING bar (light, very round, soft
 * shadow, inset from the screen edges) that stays visible while scrolling in either direction:
 * בית · יומן · [+] · עדכונים · כלים — the same five for every business and plan. The "+" sits exactly in the
 * centre of the bar, horizontally and vertically, and never rises above the other items. The content area
 * reserves the bar height + the safe area (shell-chrome), so nothing at the end of a screen hides under it.
 *
 * The tabs come from the single nav source (nav-destinations), so the list is
 * never duplicated with the rail or the sidebar.
 */
export function BottomBar() {
  const pathname = usePathname() || "/";
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const chromeHidden = useShellChromeHidden();
  const hasUnread = useUnreadNotifications(pathname);
  const { t } = useI18n();
  // Phase 2: the second slot follows the primary activity pack (יומן without packs — today's bar).
  const tabs = usePrimaryDestinations();

  // A full-screen surface (e.g. a secretary sub-screen/modal) has requested the
  // shell chrome be hidden so its bottom CTA is not covered by the fixed bar.
  if (chromeHidden) return null;

  return (
    <>
      <nav
        data-component="shell-bottom-bar"
        aria-label={t("nav.a11y.bottomNav")}
        className="dz-bottom"
        style={{
          position: "fixed",
          left: "max(12px, env(safe-area-inset-left, 0px))",
          right: "max(12px, env(safe-area-inset-right, 0px))",
          bottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
          zIndex: BOTTOM_BAR_Z_INDEX,
          boxSizing: "border-box",
          height: BAR_HEIGHT,
          maxWidth: 560,
          marginInline: "auto",
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          alignItems: "center",
          padding: "0 6px",
          borderRadius: 32,
          background: "rgba(255, 253, 248, 0.97)",
          border: "1px solid rgba(227, 229, 221, 0.9)",
          boxShadow: "0 10px 30px -12px rgba(35, 48, 43, 0.28), 0 2px 6px rgba(35, 48, 43, 0.05)",
          fontFamily: "var(--font-rubik), 'Heebo', system-ui, sans-serif",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <BarLink dest={tabs[0]} active={isNavActive(pathname, tabs[0].href)} unread={hasUnread && tabs[0].key === "notifications"} />
        <BarLink dest={tabs[1]} active={isNavActive(pathname, tabs[1].href)} unread={hasUnread && tabs[1].key === "notifications"} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
          <button
            type="button"
            aria-label={t("nav.a11y.newAction")}
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

function BarLink({ dest, unread }: { dest: NavDestination; active?: boolean; unread: boolean }) {
  const Icon = dest.icon;
  const { t } = useI18n();
  const pathname = usePathname() || "/";
  const search = useLocationSearch();
  const href = useNavHref(dest);
  const active = isResolvedActive(pathname, search, href, isNavActive);
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className="dz-bottom__item"
      data-active={active ? "1" : undefined}
    >
      <span className="dz-bottom__icon">
        <Icon size={20} strokeWidth={active ? 2 : 1.8} />
        {unread ? <span className="dz-bottom__dot" aria-hidden /> : null}
      </span>
      <span className="dz-bottom__label">{t(dest.barLabelKey ?? dest.labelKey)}</span>
      {unread ? <span className="sr-only">{t("nav.a11y.unreadNotifications")}</span> : null}
    </Link>
  );
}
