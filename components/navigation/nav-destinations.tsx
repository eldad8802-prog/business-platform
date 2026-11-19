import {
  IconBell,
  IconBox,
  IconCalendar,
  IconCalendarSimple,
  IconWrench,
  IconCash,
  IconChat,
  IconFile,
  IconGrid,
  IconHome,
  IconLeads,
  IconReceipt,
  IconSecretary,
  IconSettings,
  IconTasks,
  IconUsers,
  type IconComponent,
} from "./nav-icons";
import type { MessageKey } from "@/lib/i18n/translate";

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
  /** Hebrew label (the source text); surfaces render `labelKey` through the translator. */
  label: string;
  labelKey: MessageKey;
  href: string;
  icon: IconComponent;
  group: NavGroupKey;
  /** Shown in the mobile bottom bar and the tablet rail (the four primary tabs). */
  primary?: boolean;
  /** The short label the floating bottom bar uses, when it differs from `labelKey`. */
  barLabelKey?: MessageKey;
  /** Shown only while this platform feature is ON for the business (fail-closed until known). */
  feature?: string;
};

export type NavGroup = {
  key: Exclude<NavGroupKey, "main" | "footer">;
  label: string;
  labelKey: MessageKey;
  /** The group's square colour dot — the same family colours the Home tiles use. */
  dot: string;
};

export const NAV_GROUPS: NavGroup[] = [
  { key: "money", label: "כסף", labelKey: "nav.groups.money", dot: "#246966" },
  { key: "customers", label: "לקוחות ומכירות", labelKey: "nav.groups.customers", dot: "#5B4FA8" },
  { key: "business", label: "ניהול העסק", labelKey: "nav.groups.business", dot: "#A0601F" },
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
  // HOME v4 (owner-approved redesign): the bar is בית · יומן · [+] · עדכונים · כלים — the same five, in the same
  // order, for every business and plan. שיחות and מסמכים stay main destinations (sidebar) and live under כלים.
  { key: "home", label: "בית", labelKey: "nav.home", href: "/app", icon: IconHome, group: "main", primary: true },
  { key: "chats", label: "שיחות", labelKey: "nav.chats", href: "/inbox", icon: IconChat, group: "main" },
  { key: "docs", label: "מסמכים", labelKey: "nav.docs", href: "/documents", icon: IconFile, group: "main" },
  { key: "notifications", label: "התראות", labelKey: "nav.notifications", barLabelKey: "nav.bar.updates", href: "/notifications", icon: IconBell, group: "main", primary: true },
  { key: "tools", label: "כלים", labelKey: "nav.tools", barLabelKey: "nav.bar.tools", href: "/tools", icon: IconGrid, group: "main", primary: true },
  { key: "payments", label: "גבייה", labelKey: "nav.payments", href: "/collection", icon: IconCash, group: "money" },
  { key: "billing", label: "חשבוניות", labelKey: "nav.billing", href: "/billing", icon: IconReceipt, group: "money" },
  { key: "customers", label: "לקוחות", labelKey: "nav.customers", href: "/customers", icon: IconUsers, group: "customers" },
  { key: "leads", label: "לידים", labelKey: "nav.leads", href: "/leads", icon: IconLeads, group: "customers" },
  // ניהול העסק (Daily Tasks B, owner-approved): the task centre, the secretary and the commitments sit together —
  // a placement move only; every route, screen and permission is unchanged. Tasks appear only with daily_tasks ON.
  { key: "tasks", label: "משימות", labelKey: "nav.tasks", href: "/tasks", icon: IconTasks, group: "business", feature: "daily_tasks" },
  // Appointments milestone B (decision 12): the calendar sits in ניהול העסק, only while appointments is ON.
  // In the bottom bar / rail it is the fixed "יומן" tab (HOME v4); in the sidebar it stays gated by appointments.
  { key: "calendar", label: "יומן ותורים", labelKey: "nav.calendar", barLabelKey: "nav.bar.calendar", href: "/calendar", icon: IconCalendarSimple, group: "business", feature: "appointments", primary: true },
  // Service Desk UI 1.3a (decision ה4: entry via ניהול העסק): only while service_desk is ON for the business — off by default.
  { key: "service-desk", label: "שירות ואחריות", labelKey: "nav.serviceDesk", href: "/service-desk", icon: IconWrench, group: "business", feature: "service_desk" },
  { key: "secretary", label: "המזכירה שלי", labelKey: "nav.secretary", href: "/secretary", icon: IconSecretary, group: "business" },
  { key: "payables", label: "התחייבויות", labelKey: "nav.payables", href: "/payables", icon: IconCalendar, group: "business" },
  { key: "inventory", label: "מלאי", labelKey: "nav.inventory", href: "/inventory", icon: IconBox, group: "business" },
  { key: "settings", label: "הגדרות", labelKey: "nav.settings", href: "/settings", icon: IconSettings, group: "footer" },
];

/** Primary destinations only — the mobile bottom-bar tabs and the tablet rail. */
const PRIMARY_ORDER = ["home", "calendar", "notifications", "tools"];
/** In bar order (RTL: first = rightmost): בית · יומן · [+] · עדכונים · כלים. */
export const PRIMARY_DESTINATIONS = PRIMARY_ORDER.map((k) => NAV_DESTINATIONS.find((d) => d.key === k && d.primary)!);

export const SETTINGS_DESTINATION = NAV_DESTINATIONS.find((d) => d.key === "settings")!;

export function destinationsIn(group: NavGroupKey): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => d.group === group);
}
