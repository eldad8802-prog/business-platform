/**
 * HOME v4 — the "+" sheet's actions. Pure: no I/O, no React.
 *
 * Its own module on purpose: the navigation shell (action-sheet.tsx) is on every page, so whatever it imports ships
 * with every page (i18n en-chunk proof: Hebrew client JS budget). It needs only this — never the whole Home model.
 * home-v4-model.ts re-exports it, so the Home and its tests are unchanged.
 */
import { allows, packsOf, type BusinessKind, type HomeAccess, type Requirement } from "./home-access";

export type CreateAction = {
  key: string;
  labelKey: "task" | "appointment" | "invoice" | "paymentRequest" | "lead" | "customer" | "upload" | "commitment" | "product" | "serviceCase";
  href: string;
  icon: "task" | "calendar" | "invoice" | "payments" | "lead" | "customer" | "upload" | "secretary" | "inventory" | "service";
  req: Requirement;
  /** Offered only once the owner chose activity packs (accounts that never chose keep exactly today's sheet). */
  packOnly?: boolean;
};

/**
 * "+" owns creation: each entry STARTS something (a deep link that opens the real create flow). Listed only when
 * the module is ON and the person holds the scope; "coming soon" entries are not creation and are not listed.
 */
export const CREATE_ACTIONS: CreateAction[] = [
  { key: "task", labelKey: "task", href: "/tasks?new=1", icon: "task", req: { modules: ["daily_tasks"], scope: "operations" } },
  { key: "appointment", labelKey: "appointment", href: "/calendar?new=1", icon: "calendar", req: { modules: ["appointments"], scope: "operations" } },
  { key: "invoice", labelKey: "invoice", href: "/billing?create=1", icon: "invoice", req: { modules: ["billing"], scope: "money" } },
  { key: "payment-request", labelKey: "paymentRequest", href: "/collection/new", icon: "payments", req: { modules: ["billing"], scope: "money" } },
  { key: "lead", labelKey: "lead", href: "/leads?new=1", icon: "lead", req: { scope: "customers" } },
  { key: "customer", labelKey: "customer", href: "/customers?new=1", icon: "customer", req: { scope: "customers" } },
  { key: "upload", labelKey: "upload", href: "/documents/upload", icon: "upload", req: { modules: ["documents"], scope: "documents" } },
  { key: "commitment", labelKey: "commitment", href: "/secretary?screen=bank", icon: "secretary", req: { scope: "money" } },
  { key: "product", labelKey: "product", href: "/inventory/items/create", icon: "inventory", req: { modules: ["inventory"], scope: "operations" } },
  // Phase 2: opens the Service Desk's existing new-case screen — only while service_desk is ON (never turned on here).
  { key: "service-case", labelKey: "serviceCase", href: "/service-desk/new", icon: "service", req: { modules: ["service_desk"], scope: "operations" }, packOnly: true },
];

/**
 * FREE_LIMITED (owner decision 4): only these creations stay in "+" (a customer added by hand, a simple personal task —
 * the approved FREE_LIMITED table); everything else is simply not listed, never shown locked. The sheet adds one line
 * that says what returns with an active plan (`createLimitedNote`).
 */
const FREE_LIMITED_CREATE: ReadonlySet<string> = new Set(["customer", "task"]);

/** Business kind decides only the ORDER of the permitted actions (what this business creates most comes first). */
const CREATE_FIRST: Record<BusinessKind, string[]> = {
  service: ["task", "invoice", "payment-request", "customer"],
  booking: ["appointment", "invoice", "payment-request", "customer"],
  sales: ["lead", "invoice", "payment-request", "customer"],
  general: ["invoice", "payment-request", "upload", "lead"],
};

function permittedActions(access: HomeAccess): CreateAction[] {
  const permitted = CREATE_ACTIONS.filter((a) => allows(access, a.req));
  // Pack-only actions exist only once the owner chose packs (accounts that never chose keep today's sheet).
  return packsOf(access).activity !== null ? permitted : permitted.filter((a) => !a.packOnly);
}

export function createActionsFor(access: HomeAccess): CreateAction[] {
  const { activity, engine } = packsOf(access);
  let permitted = permittedActions(access);
  if (access.subscription === "FREE_LIMITED") permitted = permitted.filter((a) => FREE_LIMITED_CREATE.has(a.key));
  // Activity packs reorder only what is permitted: the primary pack's actions, then one per additional pack.
  if (activity && engine) return engine.orderKeys(activity, permitted, (a) => a.key, "create");
  const first = CREATE_FIRST[access.kind];
  const rank = (a: CreateAction) => {
    const i = first.indexOf(a.key);
    return i === -1 ? first.length + CREATE_ACTIONS.indexOf(a) : i;
  };
  return [...permitted].sort((a, b) => rank(a) - rank(b));
}

/** FREE_LIMITED and something permitted was left out of "+": the sheet shows its one explanatory line. */
export function createLimitedNote(access: HomeAccess): boolean {
  return access.subscription === "FREE_LIMITED" && permittedActions(access).some((a) => !FREE_LIMITED_CREATE.has(a.key));
}
