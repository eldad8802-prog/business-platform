import type { ReactNode } from "react";

/**
 * Single source of truth for the app's primary navigation.
 *
 * Both the mobile `BottomBar` (the `primary` subset) and the tablet/desktop
 * `SideNav` (the full list) derive from THIS array — the nav list is declared
 * once, never duplicated. Every `href` is a real, existing route (verified
 * against the app tree); nothing is invented here.
 *
 * Icons live here too so the same glyph is used across every nav surface. They
 * follow one line-weight family (stroke, 22px viewport, thicker when active),
 * matching the existing bottom-bar icons (moved here verbatim for home / chats /
 * documents / inventory).
 */

export type NavDestination = {
  key: string;
  label: string;
  href: string;
  icon: (props: { active: boolean }) => ReactNode;
  /** Shown in the mobile bottom bar (the four primary tabs). */
  primary?: boolean;
};

/** Active-route test — shared by every nav surface. Mirrors the bottom bar:
 *  home ("/") is also active on the authenticated home route ("/app"). */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const NAV_DESTINATIONS: NavDestination[] = [
  { key: "home", label: "בית", href: "/", icon: IconHome, primary: true },
  { key: "chats", label: "שיחות", href: "/inbox", icon: IconChat, primary: true },
  { key: "docs", label: "מסמכים", href: "/documents", icon: IconDocs, primary: true },
  { key: "inventory", label: "מלאי", href: "/inventory", icon: IconInventory, primary: true },
  { key: "customers", label: "לקוחות", href: "/customers", icon: IconCustomers },
  { key: "payments", label: "גבייה", href: "/payments", icon: IconPayments },
  { key: "billing", label: "חשבוניות", href: "/billing", icon: IconInvoice },
  { key: "secretary", label: "מזכירה", href: "/secretary", icon: IconSecretary },
  { key: "settings", label: "הגדרות", href: "/settings", icon: IconSettings },
];

/** Primary destinations only — the mobile bottom-bar tabs. */
export const PRIMARY_DESTINATIONS = NAV_DESTINATIONS.filter((d) => d.primary);

/* ------------------------------------------------------------------ icons -- */
/* home / chats / docs / inventory: moved verbatim from bottom-bar.tsx so the
   mobile bar stays pixel-identical. The rest match the same style. */

function IconHome({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5z" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" />
    </svg>
  );
}

function IconChat({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" />
    </svg>
  );
}

function IconDocs({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" />
      <path d="M14 2v6h6M9 13h6M9 17h6" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}

function IconInventory({ active }: { active: boolean }) {
  const w = active ? 2.25 : 2;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function IconCustomers({ active }: { active: boolean }) {
  const w = active ? 2.05 : 1.8;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth={w} />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.9M17.5 19a5.5 5.5 0 0 0-2.7-4.7" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}

function IconPayments({ active }: { active: boolean }) {
  const w = active ? 2.05 : 1.8;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="currentColor" strokeWidth={w} />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth={w} />
      <path d="M6 9.5v5M18 9.5v5" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}

function IconInvoice({ active }: { active: boolean }) {
  const w = active ? 2.05 : 1.8;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21V3z" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" />
      <path d="M8.5 8h7M8.5 12h7" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}

function IconSecretary({ active }: { active: boolean }) {
  const w = active ? 2.05 : 1.8;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-8z" stroke="currentColor" strokeWidth={w} strokeLinejoin="round" />
      <path d="M12 6.4l.9 1.9 2.1.3-1.5 1.5.35 2.1-1.85-1-1.85 1 .35-2.1-1.5-1.5 2.1-.3.9-1.9z" fill="currentColor" />
    </svg>
  );
}

function IconSettings({ active }: { active: boolean }) {
  const w = active ? 2.05 : 1.8;
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth={w} />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  );
}
