/**
 * Connections center (S1-B · M1) — the read model's shape and its PURE mappings.
 *
 * Each existing connection mechanism keeps its own state; this module only translates what the
 * server already read into one card per connection, grouped by what it means to the business.
 * Nothing here reads, connects, refreshes or changes anything — the reads live in
 * ./connections-center.service.ts, which calls these mappers.
 *
 * Every user-visible string is a MessageKey (translated in the client, account.settings.connections.center.*);
 * a provider's raw error text never reaches a card. `accountLabel` is the only free text — the
 * owner's own Gmail address / WhatsApp number / connection label, which the existing screens
 * already show.
 *
 * Attention rules (no new decision mechanism):
 *   kind "action"  ONLY where a working fix exists on a screen today — the card links to it.
 *   kind "info"    a fact the owner should know but cannot fix here today (paused by the owner,
 *                  a provider problem Dubiz retries itself, a reconnect that is not open yet).
 *
 * Availability is the gate each mechanism already uses: the source's platform feature
 * (enabledSources), the payment-provider catalogue, the inbound-email switch. A card that is not
 * available is "hidden" and never returned. "planned" is part of the type and unused in M1.
 *
 * Pure and client-safe: types and functions only, no server import.
 */
import type { MessageKey } from "@/lib/i18n/translate";
import { connectionHealthKey } from "./connection-health-copy";

export type ConnectionCategory = "invoices" | "pos" | "payments" | "messaging" | "leads" | "stores_calls" | "authority";
export type ConnectionAvailability = "available" | "planned" | "hidden";
export type ConnectionState = "connected" | "attention" | "paused" | "disconnected" | "unavailable";

/** The independent reads; one failing marks only its own cards unavailable. */
export type ConnectionSourceId = "acquisition" | "payments" | "authority" | "whatsapp" | "gmail" | "inbound_email";

export type ConnectionLink = { href: string; labelKey: MessageKey };

export type ConnectionCard = {
  /** Stable within a response (`<provider>` or `<provider>:<row id>`). */
  id: string;
  category: ConnectionCategory;
  provider: string;
  nameKey: MessageKey;
  /** The owner's own identifier for this connection (email / number / label), or null. */
  accountLabel: string | null;
  availability: ConnectionAvailability;
  state: ConnectionState;
  /** A real timestamp and what it means for this source ("עדכון אחרון התקבל", "אומת לאחרונה"…). */
  lastActivity: { at: string; labelKey: MessageKey } | null;
  errorKey: MessageKey | null;
  /** What this connection really gives the business (declared per provider below). */
  provides: MessageKey[];
  manage: ConnectionLink | null;
  attention: { kind: "action" | "info"; textKey: MessageKey; action?: ConnectionLink } | null;
};

export type ConnectionCategoryView = {
  category: ConnectionCategory;
  titleKey: MessageKey;
  cards: ConnectionCard[];
};

export type ConnectionsCenter = {
  categories: ConnectionCategoryView[];
  counts: { connected: number; needsAction: number };
  /** Sources that could not be read this time (their cards read "לא הצלחנו לבדוק כרגע"). */
  unavailableSources: ConnectionSourceId[];
};

const K = "account.settings.connections.center" as const;

export const CATEGORY_ORDER: readonly ConnectionCategory[] = ["invoices", "pos", "payments", "messaging", "leads", "stores_calls", "authority"];

export const CATEGORY_TITLE: Record<ConnectionCategory, MessageKey> = {
  invoices: `${K}.categories.invoices`,
  pos: `${K}.categories.pos`,
  payments: `${K}.categories.payments`,
  messaging: `${K}.categories.messaging`,
  leads: `${K}.categories.leads`,
  stores_calls: `${K}.categories.storesCalls`,
  authority: `${K}.categories.authority`,
};

/** In-page anchors of the existing management components (app/settings/connections/page.tsx). */
export const CONNECTIONS_ANCHOR = {
  payments: "connections-payments",
  authority: "connections-authority",
  leads: "connections-leads",
  stores: "connections-stores",
} as const;

const MANAGE: MessageKey = `${K}.manage`;
const UNAVAILABLE: MessageKey = `${K}.unavailable`;

const anchor = (id: string): ConnectionLink => ({ href: `#${id}`, labelKey: MANAGE });
const page = (href: string): ConnectionLink => ({ href, labelKey: MANAGE });

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const activity = (d: Date | string | null | undefined, labelKey: MessageKey): ConnectionCard["lastActivity"] => {
  const at = iso(d);
  return at ? { at, labelKey } : null;
};

// ── acquisition: lead sources, stores & phone lines, Rivhit ─────────────────────────────────────

/** Mirrors gate.ts CONNECTION_SOURCE_KEYS (kept literal so this module stays client-safe). */
export type AcquisitionSourceKeyLike =
  | "web.form"
  | "google.lead_form"
  | "meta.lead_ads"
  | "commerce.woocommerce"
  | "commerce.wix"
  | "telephony.cloudtalk"
  | "telephony.voicenter"
  | "pos.rivhit";

type AcquisitionDecl = {
  category: ConnectionCategory;
  nameKey: MessageKey;
  provides: MessageKey[];
  /** null = read-only status (no management surface in M1). */
  manage: ConnectionLink | null;
};

export const ACQUISITION_SOURCES: Record<AcquisitionSourceKeyLike, AcquisitionDecl> = {
  "web.form": { category: "leads", nameKey: "account.settings.connections.leads.sources.webForm.title", provides: [`${K}.provides.webFormLeads`], manage: anchor(CONNECTIONS_ANCHOR.leads) },
  "google.lead_form": { category: "leads", nameKey: "account.settings.connections.leads.sources.google.title", provides: [`${K}.provides.googleLeads`], manage: anchor(CONNECTIONS_ANCHOR.leads) },
  "meta.lead_ads": { category: "leads", nameKey: "account.settings.connections.leads.sources.meta.title", provides: [`${K}.provides.metaLeads`], manage: anchor(CONNECTIONS_ANCHOR.leads) },
  "commerce.woocommerce": { category: "stores_calls", nameKey: "account.settings.connections.stores.sources.woocommerce.title", provides: [`${K}.provides.storeOrders`], manage: anchor(CONNECTIONS_ANCHOR.stores) },
  "commerce.wix": { category: "stores_calls", nameKey: "account.settings.connections.stores.sources.wix.title", provides: [`${K}.provides.storeOrders`], manage: anchor(CONNECTIONS_ANCHOR.stores) },
  "telephony.cloudtalk": { category: "stores_calls", nameKey: "account.settings.connections.stores.sources.cloudtalk.title", provides: [`${K}.provides.calls`], manage: anchor(CONNECTIONS_ANCHOR.stores) },
  "telephony.voicenter": { category: "stores_calls", nameKey: "account.settings.connections.stores.sources.voicenter.title", provides: [`${K}.provides.calls`], manage: anchor(CONNECTIONS_ANCHOR.stores) },
  // S1-A: read-only here — connecting Rivhit belongs to M2, so no manage link and no connect card.
  "pos.rivhit": { category: "invoices", nameKey: `${K}.providers.rivhit`, provides: [`${K}.provides.rivhitSales`], manage: null },
};

const ACQUISITION_ORDER = Object.keys(ACQUISITION_SOURCES) as AcquisitionSourceKeyLike[];

/**
 * Health codes Dubiz recovers from by itself (reconcile / retry): the owner is told, not asked.
 * Every other ERROR is "action" only where the panel offers a working fix (below).
 */
const OWNER_FIX_CODES: Partial<Record<string, AcquisitionSourceKeyLike>> = {
  // StoresAndCallsPanel: "חיבור מחדש" for WooCommerce while the source is available.
  WOO_KEYS_REVOKED: "commerce.woocommerce",
  // StoresAndCallsPanel: the Wix install link while the Wix app is configured.
  WIX_APP_UNINSTALLED: "commerce.wix",
};

export type AcquisitionConnectionRow = {
  id: number;
  sourceKey: string;
  status: string;
  label: string | null;
  lastEventAt: Date | string | null;
  lastErrorCode: string | null;
};

export type AcquisitionInput = {
  enabled: Partial<Record<AcquisitionSourceKeyLike, boolean>>;
  connections: AcquisitionConnectionRow[];
  /** Dubiz's Meta app is configured (the panel's meta.available). */
  metaAvailable: boolean;
  /** The Dubiz Wix app is configured and has an install link (the panel's wix.available). */
  wixAvailable: boolean;
};

/** Can the owner start a NEW connection of this source today (the panel's own `available`)? */
function connectable(key: AcquisitionSourceKeyLike, input: AcquisitionInput): boolean {
  if (!input.enabled[key]) return false;
  if (key === "pos.rivhit") return false; // M2
  if (key === "meta.lead_ads") return input.metaAvailable;
  if (key === "commerce.wix") return input.wixAvailable;
  return true;
}

export function mapAcquisitionCards(input: AcquisitionInput): ConnectionCard[] {
  const out: ConnectionCard[] = [];
  for (const key of ACQUISITION_ORDER) {
    const decl = ACQUISITION_SOURCES[key];
    const enabled = !!input.enabled[key];
    const canConnect = connectable(key, input);
    const live = input.connections.filter((c) => c.sourceKey === key && c.status !== "REVOKED");

    // A source the business is not enabled for adds nothing here (its panel keeps showing it as
    // it does today). Rivhit is hidden unless pos_rivhit is allowed, connection or not.
    if (!enabled) continue;

    if (live.length === 0) {
      // Only a source the owner can actually connect gets a "not connected" card.
      if (canConnect) {
        out.push({
          id: key,
          category: decl.category,
          provider: key,
          nameKey: decl.nameKey,
          accountLabel: null,
          availability: "available",
          state: "disconnected",
          lastActivity: null,
          errorKey: null,
          provides: decl.provides,
          manage: decl.manage,
          attention: null,
        });
      }
      continue;
    }

    for (const c of live) {
      const base = {
        id: `${key}:${c.id}`,
        category: decl.category,
        provider: key,
        nameKey: decl.nameKey,
        accountLabel: c.label,
        availability: "available" as const,
        lastActivity: activity(c.lastEventAt, `${K}.activity.lastEvent`),
        provides: decl.provides,
        manage: decl.manage,
      };
      if (c.status === "ACTIVE") {
        out.push({ ...base, state: "connected", errorKey: null, attention: null });
      } else if (c.status === "PAUSED") {
        out.push({ ...base, state: "paused", errorKey: null, attention: { kind: "info", textKey: `${K}.attention.paused` } });
      } else {
        // ERROR (or any status this read model does not know): never "connected".
        const errorKey = connectionHealthKey(c.lastErrorCode);
        const fixFor = c.lastErrorCode ? OWNER_FIX_CODES[c.lastErrorCode] : undefined;
        const fixable = fixFor === key && canConnect && decl.manage !== null;
        out.push({
          ...base,
          state: "attention",
          errorKey,
          attention: fixable
            ? { kind: "action", textKey: errorKey, action: { href: decl.manage!.href, labelKey: `${K}.fix` } }
            : { kind: "info", textKey: errorKey },
        });
      }
    }
  }
  return out;
}

// ── payments ───────────────────────────────────────────────────────────────────────────────────

/** Declared per provider: only what a connection really provides in Dubiz today. */
const PAYMENT_DECL: Record<string, { nameKey: MessageKey; provides: MessageKey[] }> = {
  CARDCOM: { nameKey: `${K}.providers.cardcom`, provides: [`${K}.provides.cardcomPayments`] },
};

export type PaymentConnectionRow = { id: number; provider: string; isActive: boolean; updatedAt: Date | string };

/**
 * `enabledProviders` = the provider catalogue (listProviderDescriptors — the same list the payment
 * card offers). A disabled provider (PayPal, Tranzila, SUMIT, PayPlus) is hidden, even if a stored
 * row exists for it.
 */
export function mapPaymentCards(input: { enabledProviders: readonly string[]; connections: PaymentConnectionRow[] }): ConnectionCard[] {
  const out: ConnectionCard[] = [];
  for (const provider of input.enabledProviders) {
    const decl = PAYMENT_DECL[provider] ?? { nameKey: `${K}.providers.paymentGeneric` as MessageKey, provides: [] };
    const row = input.connections.find((c) => c.provider === provider) ?? null;
    out.push({
      id: row ? `payments:${provider}:${row.id}` : `payments:${provider}`,
      category: "payments",
      provider,
      nameKey: decl.nameKey,
      accountLabel: null,
      availability: "available",
      state: row?.isActive ? "connected" : "disconnected",
      // The payment connection records no provider activity; this is when its settings last changed.
      lastActivity: row?.isActive ? activity(row.updatedAt, `${K}.activity.settingsUpdated`) : null,
      errorKey: null,
      provides: decl.provides,
      manage: anchor(CONNECTIONS_ANCHOR.payments),
      attention: null,
    });
  }
  return out;
}

// ── tax authority ──────────────────────────────────────────────────────────────────────────────

export type AuthorityUiStatus = "NOT_CONFIGURED" | "DISCONNECTED" | "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR";

/**
 * The authority card's connect and reconnect buttons are not open yet (inactive, "בקרוב"), so a
 * not-connected authority adds no card and a problem is "info", never "action".
 */
export function mapAuthorityCards(dto: { status: AuthorityUiStatus; connectedAt: string | null }): ConnectionCard[] {
  if (dto.status === "NOT_CONFIGURED" || dto.status === "DISCONNECTED") return [];
  const problem: Partial<Record<AuthorityUiStatus, MessageKey>> = {
    EXPIRED: `${K}.authority.expired`,
    REVOKED: `${K}.authority.revoked`,
    ERROR: `${K}.authority.error`,
  };
  const errorKey = problem[dto.status] ?? null;
  return [
    {
      id: "authority",
      category: "authority",
      provider: "tax_authority",
      nameKey: "account.settings.connections.authority.title",
      accountLabel: null,
      availability: "available",
      state: errorKey ? "attention" : "connected",
      lastActivity: dto.status === "CONNECTED" || dto.status === "EXPIRED" ? activity(dto.connectedAt, `${K}.activity.authorized`) : null,
      errorKey,
      provides: [`${K}.provides.allocationNumbers`],
      manage: anchor(CONNECTIONS_ANCHOR.authority),
      attention: errorKey ? { kind: "info", textKey: errorKey } : null,
    },
  ];
}

// ── WhatsApp ───────────────────────────────────────────────────────────────────────────────────

export type WhatsAppRow = { status: string; displayPhoneNumber: string | null; lastVerifiedAt: Date | string | null } | null;

/**
 * /settings/whatsapp owns the connection. Its reconnect is not open yet ("בקרוב"), so a
 * REVOKED_BY_META / ERROR row is "info" with a link to that screen, not "action".
 */
export function mapWhatsAppCards(row: WhatsAppRow): ConnectionCard[] {
  const status = row?.status ?? null;
  const attention = status === "REVOKED_BY_META" || status === "ERROR";
  const connected = status === "CONNECTED";
  return [
    {
      id: "whatsapp",
      category: "messaging",
      provider: "whatsapp",
      nameKey: "account.settings.connections.integrations.whatsappTitle",
      accountLabel: connected || attention ? row?.displayPhoneNumber ?? null : null,
      availability: "available",
      state: connected ? "connected" : attention ? "attention" : "disconnected",
      lastActivity: connected || attention ? activity(row?.lastVerifiedAt, `${K}.activity.verified`) : null,
      errorKey: attention ? `${K}.whatsapp.attention` : null,
      provides: [`${K}.provides.whatsappMessages`],
      manage: page("/settings/whatsapp"),
      attention: attention ? { kind: "info", textKey: `${K}.whatsapp.attention` } : null,
    },
  ];
}

// ── Gmail ──────────────────────────────────────────────────────────────────────────────────────

export type GmailRow = { id: number; emailAddress: string; status: string; lastSyncedAt: Date | string | null };

/** One card per connected / errored account; none of them → one "not connected" card. */
export function mapGmailCards(rows: GmailRow[]): ConnectionCard[] {
  const base = {
    category: "invoices" as const,
    provider: "gmail",
    nameKey: `${K}.providers.gmail` as MessageKey,
    availability: "available" as const,
    provides: [`${K}.provides.gmailDocuments`] as MessageKey[],
    manage: page("/documents/email"),
  };
  const live = rows.filter((r) => r.status === "connected" || r.status === "error");
  if (live.length === 0) {
    return [{ ...base, id: "gmail", accountLabel: null, state: "disconnected", lastActivity: null, errorKey: null, attention: null }];
  }
  return live.map((r) => {
    const error = r.status === "error";
    return {
      ...base,
      id: `gmail:${r.id}`,
      accountLabel: r.emailAddress,
      state: error ? "attention" : "connected",
      lastActivity: activity(r.lastSyncedAt, `${K}.activity.synced`),
      errorKey: error ? `${K}.gmail.error` : null,
      // /documents/email offers "חיבור Gmail" — a working reconnect.
      attention: error ? { kind: "action", textKey: `${K}.gmail.error`, action: { href: "/documents/email", labelKey: `${K}.fix` } } : null,
    };
  });
}

// ── inbound email address ──────────────────────────────────────────────────────────────────────

export type InboundAddressRow = { status: string; lastReceivedAt: Date | string | null };

/** Only while the inbound-email switch is on (the page itself is notFound() otherwise). */
export function mapInboundEmailCards(input: { enabled: boolean; addresses: InboundAddressRow[] }): ConnectionCard[] {
  if (!input.enabled) return [];
  const active = input.addresses.find((a) => a.status === "ACTIVE") ?? null;
  const lastReceived = input.addresses
    .map((a) => iso(a.lastReceivedAt))
    .filter((x): x is string => !!x)
    .sort()
    .pop();
  return [
    {
      id: "inbound_email",
      category: "invoices",
      provider: "inbound_email",
      nameKey: `${K}.providers.inboundEmail`,
      accountLabel: null,
      availability: "available",
      state: active ? "connected" : "disconnected",
      lastActivity: active ? activity(lastReceived ?? null, `${K}.activity.mailReceived`) : null,
      errorKey: null,
      provides: [`${K}.provides.inboundDocuments`],
      manage: page("/settings/inbound-email"),
      attention: null,
    },
  ];
}

// ── a source that could not be read ────────────────────────────────────────────────────────────

/** The placeholder cards a failed read shows instead — in its own categories only. */
export const UNAVAILABLE_CARDS: Record<ConnectionSourceId, Array<Pick<ConnectionCard, "category" | "provider" | "nameKey" | "manage">>> = {
  acquisition: [
    { category: "leads", provider: "lead_sources", nameKey: "account.settings.connections.leads.title", manage: anchor(CONNECTIONS_ANCHOR.leads) },
    { category: "stores_calls", provider: "stores_calls", nameKey: "account.settings.connections.stores.title", manage: anchor(CONNECTIONS_ANCHOR.stores) },
  ],
  payments: [{ category: "payments", provider: "payments", nameKey: `${K}.categories.payments`, manage: anchor(CONNECTIONS_ANCHOR.payments) }],
  authority: [{ category: "authority", provider: "tax_authority", nameKey: "account.settings.connections.authority.title", manage: anchor(CONNECTIONS_ANCHOR.authority) }],
  whatsapp: [{ category: "messaging", provider: "whatsapp", nameKey: "account.settings.connections.integrations.whatsappTitle", manage: page("/settings/whatsapp") }],
  gmail: [{ category: "invoices", provider: "gmail", nameKey: `${K}.providers.gmail`, manage: page("/documents/email") }],
  inbound_email: [{ category: "invoices", provider: "inbound_email", nameKey: `${K}.providers.inboundEmail`, manage: page("/settings/inbound-email") }],
};

export function unavailableCards(source: ConnectionSourceId): ConnectionCard[] {
  return UNAVAILABLE_CARDS[source].map((c) => ({
    ...c,
    id: `${c.provider}:unavailable`,
    accountLabel: null,
    availability: "available",
    state: "unavailable",
    lastActivity: null,
    errorKey: UNAVAILABLE,
    provides: [],
    attention: null,
  }));
}

// ── assembly ───────────────────────────────────────────────────────────────────────────────────

export function assembleConnectionsCenter(cards: ConnectionCard[], unavailableSources: ConnectionSourceId[]): ConnectionsCenter {
  const visible = cards.filter((c) => c.availability !== "hidden");
  const categories = CATEGORY_ORDER.map((category) => ({
    category,
    titleKey: CATEGORY_TITLE[category],
    cards: visible.filter((c) => c.category === category),
  })).filter((g) => g.cards.length > 0);
  return {
    categories,
    counts: {
      connected: visible.filter((c) => c.state === "connected").length,
      needsAction: visible.filter((c) => c.attention?.kind === "action").length,
    },
    unavailableSources,
  };
}
