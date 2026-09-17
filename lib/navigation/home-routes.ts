/**
 * Home / All-Tools navigation map — the single source of truth for every
 * destination the home screen and the tools screen can send the owner to.
 *
 * WHY ONE FILE: the home screen's job is to point at work. A button that
 * points nowhere (`href="#"`, an empty `onClick`, a TODO) is worse than no
 * button, because it teaches the owner that the screen is decoration. Every
 * destination therefore lives here as data, and `home-routes.test.ts`
 * (`npm run verify:home-routes`) walks `app/` and fails the build if any one of
 * them stops resolving to a real route. A tool whose route disappears is
 * removed from this map — it is never left pointing at a 404.
 *
 * COLOURS: `color` is a key into the five coordinated tints that already exist
 * on main (`.c-teal / .c-sage / .c-amber / .c-clay / .c-slate`, declared in the
 * home stylesheet). No tool carries a hex value; a tool that had a tint keeps
 * exactly the tint it had, and a tool that is new to the map borrows one of the
 * same five (recorded in `colorSource` so the report can say where each came
 * from). No sixth hue is introduced here.
 */

/** The five existing tool tints. Not colours — names of existing CSS classes. */
export type ToolColor = "teal" | "sage" | "amber" | "clay" | "slate";

/** The Business Status domains (`lib/business-status/types.ts`). */
export type StatusDomain =
  | "inbox"
  | "documents"
  | "inventory"
  | "billing"
  | "supplier"
  | "leads";

export type ToolGroupKey = "money" | "customers" | "operations";

export type Tool = {
  key: string;
  label: string;
  href: string;
  color: ToolColor;
  group: ToolGroupKey;
  /**
   * Where this tool's tint came from. `carried` = the tile already had this
   * tint on main; `borrowed:<key>` = the tool had no tile, so it takes the
   * tint of the named existing tile. Reported, never invented.
   */
  colorSource: string;
};

export type ToolGroup = {
  key: ToolGroupKey;
  label: string;
  /** Anchor id on /tools — the home group tile scrolls straight to it. */
  anchorId: string;
  /** The domains whose exceptions this group's status label speaks for. */
  domains: StatusDomain[];
};

/**
 * Named single destinations. Anything with a query string keeps it here, so a
 * screen never assembles a URL by hand.
 */
export const HOME_ROUTES = {
  /** The exception engine — reachable from Home in every state. */
  attention: "/attention",
  /** The bell. */
  notifications: "/notifications",
  /** The owner's initial / "אני". */
  profile: "/settings/team",
  /** מרכז הגבייה. */
  collectionCenter: "/payments",
  /** The documents review queue (renders needs_review only). */
  documentsReview: "/documents/inbox",
  /** The Payment Secretary, and its "today" screen. */
  secretary: "/secretary",
  secretaryToday: "/secretary?today=1",
  /** All tools. */
  tools: "/tools",
  /** Home. */
  home: "/app",
} as const;

export type HomeRouteKey = keyof typeof HOME_ROUTES;

/** A single obligation, opened on the Secretary's detail screen. */
export function obligationHref(obligationId: number): string {
  return `/secretary?screen=detail&id=${obligationId}`;
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    key: "money",
    label: "כסף ומסמכים",
    anchorId: "group-money",
    domains: ["billing", "documents"],
  },
  {
    key: "customers",
    label: "לקוחות ושיחות",
    anchorId: "group-customers",
    domains: ["inbox", "leads"],
  },
  {
    key: "operations",
    label: "מלאי וספקים",
    anchorId: "group-operations",
    domains: ["inventory", "supplier"],
  },
];

/** The home group tile links to the group's anchor inside /tools. */
export function groupHref(group: ToolGroup): string {
  return `${HOME_ROUTES.tools}#${group.anchorId}`;
}

/**
 * Every tool shown on /tools, in group order.
 *
 * Deliberately absent — see the closing report:
 *  - "הוצאות" has no route on main. Expenses exist only as approved expense
 *    DOCUMENTS (`/documents`), never as their own surface, so a tile would
 *    have had to point somewhere it does not mean.
 *  - "יומן" is absent for the same reason: `Appointment` has no list route and
 *    no calendar screen, and the tile that carried that label on main pointed
 *    at `/secretary`, which is the payment secretary, not a diary.
 */
export const TOOLS: Tool[] = [
  // --- כסף ומסמכים ---------------------------------------------------------
  {
    key: "invoices",
    label: "חשבוניות",
    href: "/billing",
    color: "sage",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "collection",
    label: "גבייה",
    href: "/payments",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "payment-request",
    label: "בקשת תשלום",
    href: "/payments/new",
    color: "teal",
    group: "money",
    colorSource: "borrowed:collection",
  },
  {
    key: "documents",
    label: "מסמכים",
    href: "/documents",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "documents-email",
    label: "מסמכים מהמייל",
    href: "/documents/email",
    color: "teal",
    group: "money",
    colorSource: "borrowed:documents",
  },
  // --- לקוחות ושיחות -------------------------------------------------------
  {
    key: "customers",
    label: "לקוחות",
    href: "/customers",
    color: "slate",
    group: "customers",
    colorSource: "borrowed:leads",
  },
  {
    key: "leads",
    label: "לידים",
    href: "/leads",
    color: "slate",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "conversations",
    label: "שיחות",
    href: "/inbox",
    color: "sage",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "bots",
    label: "בוטים",
    href: "/business/bot",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "coupons",
    label: "קופונים",
    href: "/revenue?view=browse",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  // --- מלאי וספקים ---------------------------------------------------------
  {
    key: "inventory",
    label: "מלאי",
    href: "/inventory",
    color: "slate",
    group: "operations",
    colorSource: "carried",
  },
  {
    key: "suppliers",
    label: "ספקים",
    href: "/suppliers",
    color: "amber",
    group: "operations",
    colorSource: "carried",
  },
  {
    key: "secretary",
    label: "המזכירה",
    href: "/secretary",
    color: "amber",
    group: "operations",
    colorSource: "carried",
  },
  {
    key: "connections",
    label: "חיבורים",
    href: "/settings/connections",
    color: "amber",
    group: "operations",
    colorSource: "borrowed:suppliers",
  },
];

export function toolsInGroup(group: ToolGroupKey): Tool[] {
  return TOOLS.filter((t) => t.group === group);
}

/**
 * Every href this map can produce, as a flat list — the surface the route test
 * walks. Query strings and hashes are kept: the test strips them itself, so a
 * typo in a parameter still shows up in the list a human reads.
 */
export function allMappedHrefs(): string[] {
  return [
    ...Object.values(HOME_ROUTES),
    ...TOOL_GROUPS.map(groupHref),
    ...TOOLS.map((t) => t.href),
    obligationHref(1),
  ];
}
