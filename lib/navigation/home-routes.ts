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

import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type MessageKey, type Translator } from "@/lib/i18n/translate";

/**
 * Names and blurbs are dictionary entries (lib/i18n/messages/areas/insights.ts → `insights.tools.*`).
 * `label` / `description` / `capabilityLine` hold the Hebrew text verbatim (what every existing caller
 * reads); the `*Key` fields let a surface render them in the interface language: `t(tool.labelKey)`.
 */
const HE_T: Translator = createTranslator(he);

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
  /** Dictionary key of `label`. */
  labelKey: MessageKey;
  /** Dictionary key of `description`. */
  descriptionKey: MessageKey;
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
  /** Shown but not open yet: the row stays visible, inactive, marked "בקרוב" (UI only). */
  comingSoon?: boolean;
  /** Listed only while this platform feature is ON for the business (fail-closed until known). */
  feature?: string;
};

export type ToolGroup = {
  key: ToolGroupKey;
  /** The family name — on Home and on its own screen. */
  label: string;
  /** Dictionary key of `label`. */
  labelKey: MessageKey;
  /** Dictionary key of `capabilityLine`. */
  capabilityLineKey: MessageKey;
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
  /** The owner's initial / "אני" — the business profile. */
  profile: "/profile",
  /** מרכז הגבייה. */
  collectionCenter: "/collection",
  /** The documents review queue (renders needs_review only). */
  documentsReview: "/documents/inbox",
  /** The Payment Secretary, and its "today" screen. */
  secretary: "/secretary",
  secretaryToday: "/secretary?today=1",
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
    label: HE_T("insights.tools.groups.money.label"),
    labelKey: "insights.tools.groups.money.label",
    capabilityLine: HE_T("insights.tools.groups.money.capability"),
    capabilityLineKey: "insights.tools.groups.money.capability",
    icons: ["invoice", "collection", "documents"],
    slug: "money",
    domains: ["billing", "documents"],
  },
  {
    key: "customers",
    label: HE_T("insights.tools.groups.customers.label"),
    labelKey: "insights.tools.groups.customers.label",
    capabilityLine: HE_T("insights.tools.groups.customers.capability"),
    capabilityLineKey: "insights.tools.groups.customers.capability",
    icons: ["customers", "leads", "conversations"],
    slug: "customers",
    domains: ["inbox", "leads"],
  },
  {
    key: "operations",
    // Running the business day to day: the secretary and the commitments she
    // reminds about (moved here from money — owner decision, Daily Tasks B),
    // the task centre when daily_tasks is ON, and stock with its suppliers.
    label: HE_T("insights.tools.groups.operations.label"),
    labelKey: "insights.tools.groups.operations.label",
    capabilityLine: HE_T("insights.tools.groups.operations.capability"),
    capabilityLineKey: "insights.tools.groups.operations.capability",
    icons: ["secretary", "payables", "inventory"],
    slug: "operations",
    domains: ["inventory", "supplier"],
  },
];

/**
 * The family screens live under /tools/<slug>. The /tools root catalogue was retired (it duplicated
 * the sidebar and Home's family tiles); next.config.ts sends a direct visit to Home.
 */
const FAMILY_BASE = "/tools";

/** The family's own screen — where the Home family tile sends the owner. */
export function categoryHref(group: ToolGroup): string {
  return `${FAMILY_BASE}/${group.slug}`;
}

export function groupBySlug(slug: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((g) => g.slug === slug);
}

/**
 * Every tool in the three family screens (/tools/<slug>), in group order.
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
    label: HE_T("insights.tools.items.invoices.label"),
    labelKey: "insights.tools.items.invoices.label",
    description: HE_T("insights.tools.items.invoices.description"),
    descriptionKey: "insights.tools.items.invoices.description",
    entity: "invoice",
    href: "/billing",
    color: "sage",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "collection",
    label: HE_T("insights.tools.items.collection.label"),
    labelKey: "insights.tools.items.collection.label",
    description: HE_T("insights.tools.items.collection.description"),
    descriptionKey: "insights.tools.items.collection.description",
    entity: "collection",
    href: "/collection",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "documents",
    label: HE_T("insights.tools.items.documents.label"),
    labelKey: "insights.tools.items.documents.label",
    description: HE_T("insights.tools.items.documents.description"),
    descriptionKey: "insights.tools.items.documents.description",
    entity: "documents",
    href: "/documents",
    color: "teal",
    group: "money",
    colorSource: "carried",
  },
  {
    key: "documents-email",
    label: HE_T("insights.tools.items.documentsEmail.label"),
    labelKey: "insights.tools.items.documentsEmail.label",
    description: HE_T("insights.tools.items.documentsEmail.description"),
    descriptionKey: "insights.tools.items.documentsEmail.description",
    entity: "documents-email",
    href: "/documents/email",
    color: "teal",
    group: "money",
    colorSource: "borrowed:documents",
  },
  // --- לקוחות ומכירות ------------------------------------------------------
  {
    key: "customers",
    label: HE_T("insights.tools.items.customers.label"),
    labelKey: "insights.tools.items.customers.label",
    description: HE_T("insights.tools.items.customers.description"),
    descriptionKey: "insights.tools.items.customers.description",
    entity: "customers",
    href: "/customers",
    color: "slate",
    group: "customers",
    colorSource: "borrowed:leads",
  },
  {
    key: "leads",
    label: HE_T("insights.tools.items.leads.label"),
    labelKey: "insights.tools.items.leads.label",
    description: HE_T("insights.tools.items.leads.description"),
    descriptionKey: "insights.tools.items.leads.description",
    entity: "leads",
    href: "/leads",
    color: "slate",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "conversations",
    label: HE_T("insights.tools.items.conversations.label"),
    labelKey: "insights.tools.items.conversations.label",
    description: HE_T("insights.tools.items.conversations.description"),
    descriptionKey: "insights.tools.items.conversations.description",
    entity: "conversations",
    href: "/inbox",
    color: "sage",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "bots",
    label: HE_T("insights.tools.items.bots.label"),
    labelKey: "insights.tools.items.bots.label",
    description: HE_T("insights.tools.items.bots.description"),
    descriptionKey: "insights.tools.items.bots.description",
    entity: "bots",
    href: "/business/bot",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "coupons",
    label: HE_T("insights.tools.items.coupons.label"),
    labelKey: "insights.tools.items.coupons.label",
    description: HE_T("insights.tools.items.coupons.description"),
    descriptionKey: "insights.tools.items.coupons.description",
    entity: "coupons",
    href: "/revenue?view=browse",
    color: "clay",
    group: "customers",
    colorSource: "carried",
  },
  {
    key: "content",
    label: HE_T("insights.tools.items.content.label"),
    labelKey: "insights.tools.items.content.label",
    description: HE_T("insights.tools.items.content.description"),
    descriptionKey: "insights.tools.items.content.description",
    entity: "content",
    href: "/content",
    color: "clay",
    group: "customers",
    colorSource: "borrowed:coupons",
    comingSoon: true,
  },
  // --- ניהול העסק -----------------------------------------------------------
  // The Secretary first: tasks and commitments are its management stations
  // (owner, 25.10.2026), so they are not listed here a second time. A listing
  // decision only — /tasks and /payables, their routes, the sidebar entries and
  // every other way in are unchanged.

  {
    key: "secretary",
    label: HE_T("insights.tools.items.secretary.label"),
    labelKey: "insights.tools.items.secretary.label",
    description: HE_T("insights.tools.items.secretary.description"),
    descriptionKey: "insights.tools.items.secretary.description",
    entity: "secretary",
    href: "/secretary",
    color: "amber",
    group: "operations",
    colorSource: "carried",
  },

  // Appointments milestone B (decision 12): listed only while appointments is ON.
  {
    key: "calendar",
    label: HE_T("insights.tools.items.calendar.label"),
    labelKey: "insights.tools.items.calendar.label",
    description: HE_T("insights.tools.items.calendar.description"),
    descriptionKey: "insights.tools.items.calendar.description",
    entity: "calendar",
    href: "/calendar",
    color: "amber",
    group: "operations",
    colorSource: "borrowed:secretary",
    feature: "appointments",
  },

  {
    key: "inventory",
    label: HE_T("insights.tools.items.inventory.label"),
    labelKey: "insights.tools.items.inventory.label",
    description: HE_T("insights.tools.items.inventory.description"),
    descriptionKey: "insights.tools.items.inventory.description",
    entity: "inventory",
    href: "/inventory",
    color: "slate",
    group: "operations",
    colorSource: "carried",
  },
  {
    key: "suppliers",
    label: HE_T("insights.tools.items.suppliers.label"),
    labelKey: "insights.tools.items.suppliers.label",
    description: HE_T("insights.tools.items.suppliers.description"),
    descriptionKey: "insights.tools.items.suppliers.description",
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
    ...TOOL_GROUPS.map(categoryHref),
    ...TOOLS.map((t) => t.href),
    obligationHref(1),
  ];
}
