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
  /**
   * One short line on what the screen is for, taken from what the screen
   * actually does — never a promise it does not keep.
   */
  description: string;
  /** Which drawn Dubiz entity this tool is (`components/ui/entity/entity-icon`). */
  entity: string;
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
  /** The family name — on Home, on its own screen, and on /tools. */
  label: string;
  /**
   * Representative capabilities, as the owner would name them. EXAMPLES, never
   * the full list and never a count: it names exactly the entities in `icons`,
   * so the two must be edited together.
   */
  capabilityLine: string;
  /** The 2–3 entities whose icons stand for this family on Home. */
  icons: string[];
  /** URL segment of the family's own screen: /tools/<slug>. */
  slug: string;
  /** Anchor id of the family's section on /tools (old deep links keep working). */
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
  collectionCenter: "/collection",
  /** The documents review queue (renders needs_review only). */
  documentsReview: "/documents/inbox",
  /** The Payment Secretary, and its "today" screen. */
  secretary: "/secretary",
  secretaryToday: "/secretary?today=1",
  /** The tool directory, and the root of the three family screens. */
  tools: "/tools",
  /** Settings — reached from Home's gear, and the only owner of configuration. */
  settings: "/settings",
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
    label: "כסף וחשבוניות",
    capabilityLine: "חשבוניות · גבייה · התחייבויות",
    icons: ["invoice", "collection", "payables"],
    slug: "money",
    anchorId: "group-money",
    domains: ["billing", "documents"],
  },
  {
    key: "customers",
    label: "לקוחות ומכירות",
    capabilityLine: "לקוחות · לידים · שיחות",
    icons: ["customers", "leads", "conversations"],
    slug: "customers",
    anchorId: "group-customers",
    domains: ["inbox", "leads"],
  },
  {
    key: "operations",
    // Two, honestly. This family holds stock and the people who supply it;
    // pricing has no screen of its own and Connections is configuration. Three
    // would look tidier than the product is, and visual symmetry is not a
    // reason to invent product importance.
    label: "ניהול העסק",
    capabilityLine: "מלאי · ספקים",
    icons: ["inventory", "suppliers"],
    slug: "operations",
    anchorId: "group-operations",
    domains: ["inventory", "supplier"],
  },
];

/** The family's own screen — where the Home family row sends the owner. */
export function categoryHref(group: ToolGroup): string {
  return `${HOME_ROUTES.tools}/${group.slug}`;
}

/** The group's section inside /tools. Old links (/tools#group-money) keep working. */
export function groupHref(group: ToolGroup): string {
  return `${HOME_ROUTES.tools}#${group.anchorId}`;
}

export function groupBySlug(slug: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((g) => g.slug === slug);
}

/**
 * Every tool shown on /tools, in group order.
 *
 * WHAT BELONGS HERE: a capability the owner goes to and MANAGES. A way of
 * CREATING something belongs to the global "+" or to the screen that owns it,
 * and a setting belongs in Settings. That rule decides the three absences
 * below as much as the presences above.
 *
 * Deliberately absent:
 *  - "בקשת תשלום" (`/collection/new`) is a creation method, not a place. It is
 *    reached from "+" and from inside Collection, which is where the owner is
 *    when they decide to ask for money.
 *  - "חיבורים" (`/settings/connections`) is configuration — what is wired to
 *    what — not daily work. Settings owns it, and Home's gear reaches it in two
 *    taps. Listing it here a second time made it look like a daily tool.
 *  - "הוצאות" has no route on main. Expenses exist only as approved expense
 *    DOCUMENTS (`/documents`), never as their own surface, so a tile would
 *    have had to point somewhere it does not mean.
 *  - "יומן" is absent for the same reason: `Appointment` has no list route and
 *    no calendar screen, and the tile that carried that label on main pointed
 *    at `/secretary`, which is the payment secretary, not a diary.
 */
export const TOOLS: Tool[] = [
  // --- כסף וחשבוניות -------------------------------------------------------
  {
    key: "invoices",
    label: "חשבוניות",
    description: "חשבוניות, קבלות והצעות מחיר",
    entity: "invoice",
    href: "/billing",
    color: "sage",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "collection",
    label: "גבייה",
    description: "מי חייב לך, בקשות תשלום ומה שכבר נגבה",
    entity: "collection",
    href: "/collection",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "documents",
    label: "מסמכים",
    description: "המסמכים הפיננסיים שנקלטו לעסק",
    entity: "documents",
    href: "/documents",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "documents-email",
    label: "מסמכים מהמייל",
    description: "קליטת מסמכים מתיבת ה-Gmail",
    entity: "documents-email",
    href: "/documents/email",
    color: "teal",
    group: "money",
    colorSource: "borrowed:documents",
  },
  // Outbound money: the Secretary REMINDS about what the business owes, and
  // Payables is where the money paid against it is tracked. Both are money
  // leaving, so both belong with money — a navigation decision only, neither
  // product changes.
  {
    key: "payables",
    label: "התחייבויות",
    description: "מה העסק חייב, מתי, וכמה כבר שולם",
    entity: "payables",
    href: "/payables",
    color: "amber",
    group: "money",
    colorSource: "borrowed:secretary",
  },
  {
    key: "secretary",
    label: "המזכירה",
    description: "תזכורות לתשלומים שהעסק צריך לשלם",
    entity: "secretary",
    href: "/secretary",
    color: "amber",
    group: "money",
    colorSource: "carried",
  },
  // --- לקוחות ומכירות ------------------------------------------------------
  {
    key: "customers",
    label: "לקוחות",
    description: "כרטיסי הלקוחות של העסק",
    entity: "customers",
    href: "/customers",
    color: "slate",
    group: "customers",
    colorSource: "borrowed:leads",
  },
  {
    key: "leads",
    label: "לידים",
    description: "פניות של לקוחות פוטנציאליים",
    entity: "leads",
    href: "/leads",
    color: "slate",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "conversations",
    label: "שיחות",
    description: "השיחות עם הלקוחות במקום אחד",
    entity: "conversations",
    href: "/inbox",
    color: "sage",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "bots",
    label: "בוטים",
    description: "הבוט שעונה ללקוחות, והאופן שבו הוא עונה",
    entity: "bots",
    href: "/business/bot",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "coupons",
    label: "קופונים",
    description: "קופונים והטבות ללקוחות",
    entity: "coupons",
    href: "/revenue?view=browse",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "content",
    label: "תוכן ושיווק",
    description: "חומרי שיווק ותוכן לעסק",
    entity: "content",
    href: "/content",
    color: "clay",
    group: "customers",
    colorSource: "borrowed:coupons",
  },
  // --- ניהול העסק -----------------------------------------------------------
  {
    key: "inventory",
    label: "מלאי",
    description: "המוצרים והכמויות במלאי",
    entity: "inventory",
    href: "/inventory",
    color: "slate",
    group: "operations",
    colorSource: "carried",
  },
  {
    key: "suppliers",
    label: "ספקים",
    description: "ספקים, הזמנות ופרטי קשר",
    entity: "suppliers",
    href: "/suppliers",
    color: "amber",
    group: "operations",
    colorSource: "carried",
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
    ...TOOL_GROUPS.map(categoryHref),
    ...TOOLS.map((t) => t.href),
    obligationHref(1),
  ];
}
