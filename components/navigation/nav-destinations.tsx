import {
  IconBell,
  IconBox,
  IconCalendar,
  IconCash,
  IconChat,
  IconFile,
  IconHome,
  IconLeads,
  IconReceipt,
  IconSecretary,
  IconSettings,
  IconUsers,
  type IconComponent,
} from "./nav-icons";

/**
 * Single source of truth for the app's primary navigation.
 *
 * Every nav surface derives from THIS array — the mobile bottom bar (the
 * `primary` subset), the tablet rail (the same subset, plus settings at the
 * foot) and the desktop sidebar (everything, grouped). The list is declared
 * once, never duplicated. Every `href` is a real, existing route (verified
 * against the app tree); nothing is invented here.
 *
 * Groups and their order follow the approved desktop reference exactly:
 * ראשי · כסף · לקוחות ומכירות · ניהול העסק, with הגדרות at the sidebar's foot.
 * Search is not a destination in that reference — it is the square button next
 * to "פעולה חדשה" — so it lives on `SEARCH_HREF` instead of in this list.
 */

export type NavGroupKey = "main" | "money" | "customers" | "business" | "footer";

export type NavDestination = {
  key: string;
  label: string;
  href: string;
  icon: IconComponent;
  group: NavGroupKey;
  /** Shown in the mobile bottom bar and the tablet rail (the four primary tabs). */
  primary?: boolean;
};

export type NavGroup = {
  key: Exclude<NavGroupKey, "main" | "footer">;
  label: string;
  /** The group's square colour dot — the same family colours the Home tiles use. */
  dot: string;
};

export const NAV_GROUPS: NavGroup[] = [
  { key: "money", label: "כסף", dot: "#246966" },
  { key: "customers", label: "לקוחות ומכירות", dot: "#5B4FA8" },
  { key: "business", label: "ניהול העסק", dot: "#A0601F" },
];

/** The only search the product has: financial records by vendor / category. */
export const SEARCH_HREF = "/search";

/** The business profile — reached from the sidebar business card (and Settings). */
export const PROFILE_HREF = "/profile";

/** Active-route test — shared by every nav surface. The authenticated home is
 *  "/app"; "/" is also treated as home for the brief pre-redirect moment on
 *  non-primary hosts (on the primary domain "/" is the public site and never
 *  shows the app nav). */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const NAV_DESTINATIONS: NavDestination[] = [
  { key: "home", label: "בית", href: "/app", icon: IconHome, group: "main", primary: true },
  { key: "chats", label: "שיחות", href: "/inbox", icon: IconChat, group: "main", primary: true },
  { key: "docs", label: "מסמכים", href: "/documents", icon: IconFile, group: "main", primary: true },
  // Notifications take the fourth tab, because "what happened that mattered"
  // is something the owner comes back for many times a day.
  { key: "notifications", label: "התראות", href: "/notifications", icon: IconBell, group: "main", primary: true },
  { key: "payments", label: "גבייה", href: "/collection", icon: IconCash, group: "money" },
  { key: "billing", label: "חשבוניות", href: "/billing", icon: IconReceipt, group: "money" },
  { key: "payables", label: "התחייבויות", href: "/payables", icon: IconCalendar, group: "money" },
  { key: "customers", label: "לקוחות", href: "/customers", icon: IconUsers, group: "customers" },
  { key: "leads", label: "לידים", href: "/leads", icon: IconLeads, group: "customers" },
  { key: "inventory", label: "מלאי", href: "/inventory", icon: IconBox, group: "business" },
  { key: "secretary", label: "מזכירה", href: "/secretary", icon: IconSecretary, group: "business" },
  { key: "settings", label: "הגדרות", href: "/settings", icon: IconSettings, group: "footer" },
];

/** Primary destinations only — the mobile bottom-bar tabs and the tablet rail. */
export const PRIMARY_DESTINATIONS = NAV_DESTINATIONS.filter((d) => d.primary);

export const SETTINGS_DESTINATION = NAV_DESTINATIONS.find((d) => d.key === "settings")!;

export function destinationsIn(group: NavGroupKey): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => d.group === group);
}
