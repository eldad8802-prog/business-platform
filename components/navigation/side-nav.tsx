"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useMediaQuery } from "@/lib/ui/use-breakpoint";
import { ActionSheet } from "./action-sheet";
import {
  NAV_GROUPS,
  PRIMARY_DESTINATIONS,
  PROFILE_HREF,
  SEARCH_HREF,
  SETTINGS_DESTINATION,
  destinationsIn,
  isNavActive,
  type NavDestination,
} from "./nav-destinations";
import { IconPlus, IconSearch } from "./nav-icons";
import { AccessibilityGlyph, AccessibilityTrigger } from "@/components/ui/accessibility/accessibility-trigger";
import {
  useHasUnreadNotifications,
  useNavBadges,
  useSessionIdentity,
  type NavBadge,
} from "./nav-signals";

/**
 * Tablet rail (768–1279) and desktop sidebar (≥1280), drawn from the approved
 * tablet / desktop references. Both read the single nav source
 * (nav-destinations); the CSS in `ShellChrome` decides which one is visible,
 * and each only asks for its live signals while it is the visible one.
 *
 * Deliberately absent, because nothing in the product can back them yet:
 *   - "החלפת עסק" and its chevron on the business card — a user belongs to
 *     exactly one business (`User.businessId`); there is nothing to switch to.
 *     TODO(future): restore when memberships exist.
 *   - the "המזכירה פעילה" card — the Secretary has no on/off state of its own,
 *     and the bot's `enabled` flag is a different concept. TODO(future).
 */

const RAIL_QUERY = "(min-width: 768px) and (max-width: 1279.98px)";
const SIDEBAR_QUERY = "(min-width: 1280px)";

const RUBIK = "var(--font-rubik), 'Heebo', system-ui, sans-serif";

/* ------------------------------------------------------------------ rail -- */

export function NavRail() {
  const pathname = usePathname() || "/";
  const visible = useMediaQuery(RAIL_QUERY);
  const hasUnread = useHasUnreadNotifications(pathname, visible);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <nav aria-label="ניווט ראשי" className="dz-rail" style={{ fontFamily: RUBIK }}>
        <Link href="/app" prefetch={false} aria-label="Dubiz — בית" className="dz-rail__logo">
          d
        </Link>
        <button
          type="button"
          aria-label="פעולה חדשה"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
          className="dz-rail__new"
        >
          <IconPlus size={24} strokeWidth={2.2} />
        </button>
        {PRIMARY_DESTINATIONS.map((d) => (
          <RailItem
            key={d.key}
            dest={d}
            active={isNavActive(pathname, d.href)}
            dot={hasUnread && d.key === "notifications"}
          />
        ))}
        <div style={{ flex: 1 }} />
        <AccessibilityTrigger className="dz-rail__item">
          <span className="dz-rail__icon">
            <AccessibilityGlyph size={21} />
          </span>
          נגישות
        </AccessibilityTrigger>
        <RailItem dest={SETTINGS_DESTINATION} active={isNavActive(pathname, SETTINGS_DESTINATION.href)} dot={false} />
      </nav>
      <ActionSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

function RailItem({ dest, active, dot }: { dest: NavDestination; active: boolean; dot: boolean }) {
  const Icon = dest.icon;
  return (
    <Link
      href={dest.href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className="dz-rail__item"
      data-active={active ? "1" : undefined}
    >
      <span className="dz-rail__icon">
        <Icon size={21} strokeWidth={active ? 2 : 1.8} />
        {dot ? <span className="dz-rail__dot" aria-hidden /> : null}
      </span>
      {dest.label}
      {dot ? <span className="sr-only">יש התראות שלא נקראו</span> : null}
    </Link>
  );
}

/* --------------------------------------------------------------- sidebar -- */

export function NavSidebar() {
  const pathname = usePathname() || "/";
  const visible = useMediaQuery(SIDEBAR_QUERY);
  const hasUnread = useHasUnreadNotifications(pathname, visible);
  const badges = useNavBadges(visible, pathname);
  const { businessName } = useSessionIdentity(visible);
  const [sheetOpen, setSheetOpen] = useState(false);

  const badgeFor = (key: string): NavBadge | undefined =>
    key === "notifications" ? (hasUnread ? { kind: "dot", tone: "alert" } : undefined) : badges[key];

  return (
    <>
      <nav aria-label="ניווט ראשי" className="dz-sidebar" style={{ fontFamily: RUBIK }}>
        <Link href="/app" prefetch={false} className="dz-sidebar__brand" aria-label="Dubiz — בית">
          <span className="dz-sidebar__mark" aria-hidden>
            d
          </span>
          <span dir="ltr" className="dz-sidebar__word" aria-hidden>
            dubiz
          </span>
        </Link>

        {businessName ? (
          <Link
            href={PROFILE_HREF}
            prefetch={false}
            className="dz-sidebar__business"
            aria-label={`פרופיל העסק — ${businessName}`}
            aria-current={isNavActive(pathname, PROFILE_HREF) ? "page" : undefined}
          >
            <span className="dz-sidebar__business-mark" aria-hidden>
              {businessName.trim().charAt(0)}
            </span>
            <span className="dz-sidebar__business-name">{businessName}</span>
          </Link>
        ) : null}

        <div className="dz-sidebar__actions">
          <button
            type="button"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
            className="dz-sidebar__new"
          >
            <IconPlus size={18} strokeWidth={2.2} />
            פעולה חדשה
          </button>
          <Link href={SEARCH_HREF} prefetch={false} aria-label="חיפוש" className="dz-sidebar__search">
            <IconSearch size={18} strokeWidth={2} />
          </Link>
        </div>

        <div className="dz-sidebar__group">
          {destinationsIn("main").map((d) => (
            <SidebarItem key={d.key} dest={d} active={isNavActive(pathname, d.href)} badge={badgeFor(d.key)} />
          ))}
        </div>

        {NAV_GROUPS.map((g) => (
          <div key={g.key} className="dz-sidebar__group" role="group" aria-label={g.label}>
            <div className="dz-sidebar__group-title" aria-hidden>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: g.dot }} />
              {g.label}
            </div>
            {destinationsIn(g.key).map((d) => (
              <SidebarItem key={d.key} dest={d} active={isNavActive(pathname, d.href)} badge={badgeFor(d.key)} />
            ))}
          </div>
        ))}

        <div style={{ flex: 1, minHeight: 12 }} />

        <AccessibilityTrigger className="dz-sidebar__item">
          <AccessibilityGlyph size={18} />
          <span style={{ flex: 1 }}>נגישות</span>
        </AccessibilityTrigger>

        <SidebarItem
          dest={SETTINGS_DESTINATION}
          active={isNavActive(pathname, SETTINGS_DESTINATION.href)}
          badge={undefined}
        />
      </nav>
      <ActionSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}

const BADGE_TONES = {
  brand: { color: "#FFFFFF", background: "#246966" },
  warn: { color: "#8A4F16", background: "#F6E0C2" },
  new: { color: "#1D5552", background: "#D3ECE8" },
  critical: { color: "#FFFFFF", background: "#C24A33" },
} as const;

function SidebarItem({
  dest,
  active,
  badge,
}: {
  dest: NavDestination;
  active: boolean;
  badge: NavBadge | undefined;
}) {
  const Icon = dest.icon;
  let trailing: ReactNode = null;
  let srText: string | null = null;
  if (badge?.kind === "count" || badge?.kind === "label") {
    trailing = (
      <span className="dz-sidebar__badge" style={BADGE_TONES[badge.tone]}>
        {badge.text}
      </span>
    );
    srText = badge.kind === "count" ? `${badge.text} ממתינים` : badge.text;
  } else if (badge?.kind === "dot") {
    trailing = (
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: badge.tone === "critical" ? "#C24A33" : "#D2553D",
        }}
      />
    );
    srText = dest.key === "notifications" ? "יש התראות שלא נקראו" : "יש משהו שדורש טיפול";
  }

  return (
    <Link
      href={dest.href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className="dz-sidebar__item"
      data-active={active ? "1" : undefined}
    >
      <Icon size={18} strokeWidth={active ? 2 : 1.8} />
      <span style={{ flex: 1 }}>{dest.label}</span>
      {trailing}
      {srText ? <span className="sr-only">{srText}</span> : null}
    </Link>
  );
}
