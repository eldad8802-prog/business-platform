/**
 * M7-A — the ONE canonical commerce order (docs/business-intake-m7-decision-v1.md §7).
 *
 * Every commerce provider adapter (WooCommerce, Wix — M7-B) does one thing: turn its provider's
 * payload into a {@link CommerceOrderV1}. From here on nothing knows the provider: the receipt, the
 * normalization, identity (M4), routing (R5 → the core commerce destination), the CommerceOrder,
 * the Secretary and the learning signals are the same code for every store.
 *
 *   store payload ──adapter──▶ CommerceOrderV1 ──▶ IntakeReceiptDraft (family COMMERCE)
 *        ──acceptIntake──▶ IntakeEvent ──processor──▶ normalizeCommerceOrder ──▶ M4 identity
 *        ──▶ routeToCommerce ──▶ CommerceOrder (+ lines, + append-only event, + sensors)
 *
 * An order is NEVER a Lead (R0 + R5), never booked money, never a stock movement, never a tax
 * document (D7). PERSONAL DATA (the buyer's contact) lives only in the receipt payload (purged when
 * processed) and as M4 contact hints; the order row holds a Customer pointer, not a person.
 *
 * Receipt identity: stores rarely give a stable per-delivery id (WooCommerce changes its delivery id
 * on every attempt), so the identity is the provider's event id when it has one, else a fingerprint
 * of (order id, provider modification time, status, event kind) — the same store change delivered
 * twice is one receipt; a real later change is a new one.
 */

import type { Prisma } from "@prisma/client";
import type { ClaimedIntakeEvent, IntakeReceiptDraft, NormalizeResult } from "@/lib/intake/core/contract";
import { deriveEventIdentity } from "@/lib/intake/core/event-identity";
import { sanitizeAttribution, sanitizeUrl } from "@/lib/intake/core/attribution";
import { normalizeContactHints } from "@/lib/intake/core/contact";

export const COMMERCE_SOURCE_KEYS = ["commerce.woocommerce", "commerce.wix"] as const;
export type CommerceSourceKey = (typeof COMMERCE_SOURCE_KEYS)[number];
export function isCommerceSourceKey(v: unknown): v is CommerceSourceKey {
  return typeof v === "string" && (COMMERCE_SOURCE_KEYS as readonly string[]).includes(v);
}

export const ORDER_STATUSES = ["placed", "paid", "fulfilled", "cancelled", "refunded", "partially_refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_EVENT_KINDS = ["created", "updated", "paid", "fulfilled", "cancelled", "refunded", "restored"] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

export const MAX_ORDER_LINES = 500;
/** Integer minor units, bounded by the column type (an order above ~₪21M is refused, not truncated). */
export const MAX_MINOR = 2_000_000_000;

export type CommerceOrderLineV1 = {
  lineKey: string;
  externalProductId?: string;
  sku?: string;
  title?: string;
  quantity: number;
  unitMinor: number;
  totalMinor: number;
};

export type CommerceOrderV1 = {
  v: 1;
  kind: "commerce_order";
  /** The store's own order id. */
  providerOrderId: string;
  /** The provider's id for THIS change, when it has a stable one (Wix envelope id). */
  providerEventId?: string;
  orderNumber?: string;
  eventKind: OrderEventKind;
  status: OrderStatus;
  currency: string;
  totalMinor: number;
  refundedMinor: number;
  placedAt: string;
  /** The provider's modification time of the order for this change (ordering + stale detection). */
  providerUpdatedAt: string;
  /** A per-order sequence when the provider has one (Wix entityEventSequence). */
  providerSequence?: number;
  /** PERSONAL — the buyer as the store reports them. Only ever M4 contact hints. */
  buyer: { phone?: string; email?: string; name?: string; providerCustomerId?: string };
  /** Absent = this change did not carry lines (the order's lines stay as they are). */
  lines?: CommerceOrderLineV1[];
  attribution?: { landingUrl?: string; referrerUrl?: string; clickId?: string; source?: string; medium?: string; campaign?: string };
};

export class CommerceOrderInvalid extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CommerceOrderInvalid";
  }
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};
/** An id of the store's OWN object: short, opaque, safe charset — never truncated into another id. */
const idOf = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  return s.length >= 1 && s.length <= max && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : undefined;
};
const minor = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_MINOR ? v : undefined;
const isoOf = (v: unknown): string | undefined => {
  const s = str(v, 40);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Bound and validate a provider's parts into the canonical order (adapters call this). Throws {@link CommerceOrderInvalid}. */
export function canonicalOrder(input: {
  providerOrderId: unknown;
  providerEventId?: unknown;
  orderNumber?: unknown;
  eventKind: unknown;
  status: unknown;
  currency: unknown;
  totalMinor: unknown;
  refundedMinor?: unknown;
  placedAt: unknown;
  providerUpdatedAt: unknown;
  providerSequence?: unknown;
  buyer?: { phone?: unknown; email?: unknown; name?: unknown; providerCustomerId?: unknown } | null;
  lines?: Array<{ lineKey?: unknown; externalProductId?: unknown; sku?: unknown; title?: unknown; quantity?: unknown; unitMinor?: unknown; totalMinor?: unknown }> | null;
  attribution?: Partial<Record<"landingUrl" | "referrerUrl" | "clickId" | "source" | "medium" | "campaign", unknown>> | null;
}): CommerceOrderV1 {
  const providerOrderId = idOf(input.providerOrderId, 128);
  if (!providerOrderId) throw new CommerceOrderInvalid("order_id");
  if (!(ORDER_EVENT_KINDS as readonly unknown[]).includes(input.eventKind)) throw new CommerceOrderInvalid("event_kind");
  if (!(ORDER_STATUSES as readonly unknown[]).includes(input.status)) throw new CommerceOrderInvalid("status");
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) throw new CommerceOrderInvalid("currency");
  const totalMinor = minor(input.totalMinor);
  if (totalMinor === undefined) throw new CommerceOrderInvalid("total");
  const refundedMinor = input.refundedMinor === undefined || input.refundedMinor === null ? 0 : minor(input.refundedMinor);
  if (refundedMinor === undefined || refundedMinor > totalMinor) throw new CommerceOrderInvalid("refunded");
  const placedAt = isoOf(input.placedAt);
  const providerUpdatedAt = isoOf(input.providerUpdatedAt) ?? placedAt;
  if (!placedAt || !providerUpdatedAt) throw new CommerceOrderInvalid("time");

  let lines: CommerceOrderLineV1[] | undefined;
  if (Array.isArray(input.lines)) {
    if (input.lines.length > MAX_ORDER_LINES) throw new CommerceOrderInvalid("too_many_lines");
    const seen = new Set<string>();
    lines = input.lines.map((l, i) => {
      const lineKey = idOf(l.lineKey, 64) ?? `l${i + 1}`;
      if (seen.has(lineKey)) throw new CommerceOrderInvalid("duplicate_line");
      seen.add(lineKey);
      const quantity = typeof l.quantity === "number" && Number.isInteger(l.quantity) && l.quantity >= 1 && l.quantity <= 100_000 ? l.quantity : undefined;
      const unitMinor = minor(l.unitMinor);
      const lineTotal = minor(l.totalMinor);
      if (quantity === undefined || unitMinor === undefined || lineTotal === undefined) throw new CommerceOrderInvalid("line");
      return {
        lineKey,
        ...(idOf(l.externalProductId, 64) ? { externalProductId: idOf(l.externalProductId, 64) } : {}),
        ...(str(l.sku, 64) ? { sku: str(l.sku, 64) } : {}),
        ...(str(l.title, 200) ? { title: str(l.title, 200) } : {}),
        quantity,
        unitMinor,
        totalMinor: lineTotal,
      };
    });
  }

  const b = input.buyer ?? {};
  const buyer: CommerceOrderV1["buyer"] = {};
  for (const k of ["phone", "email", "name"] as const) {
    const v = str(b[k], 120);
    if (v) buyer[k] = v;
  }
  const pc = idOf(b.providerCustomerId, 64);
  if (pc && pc !== "0") buyer.providerCustomerId = pc; // WooCommerce: 0 = guest checkout

  const a = input.attribution ?? {};
  const attribution: NonNullable<CommerceOrderV1["attribution"]> = {};
  for (const k of ["landingUrl", "referrerUrl"] as const) {
    const v = str(a[k], 2048);
    if (v) attribution[k] = v;
  }
  for (const k of ["clickId", "source", "medium", "campaign"] as const) {
    const v = str(a[k], 100);
    if (v) attribution[k] = v;
  }
  const seq = input.providerSequence;
  return {
    v: 1,
    kind: "commerce_order",
    providerOrderId,
    ...(idOf(input.providerEventId, 128) ? { providerEventId: idOf(input.providerEventId, 128) } : {}),
    ...(str(input.orderNumber, 64) ? { orderNumber: str(input.orderNumber, 64) } : {}),
    eventKind: input.eventKind as OrderEventKind,
    status: input.status as OrderStatus,
    currency,
    totalMinor,
    refundedMinor,
    placedAt,
    providerUpdatedAt,
    ...(typeof seq === "number" && Number.isInteger(seq) && seq >= 0 && seq <= MAX_MINOR ? { providerSequence: seq } : {}),
    buyer,
    ...(lines ? { lines } : {}),
    ...(Object.keys(attribution).length ? { attribution } : {}),
  };
}

/** The receipt for one order change. Metadata is non-personal by construction. */
export function commerceReceipt(order: CommerceOrderV1, accountScope: string): IntakeReceiptDraft {
  const identity = order.providerEventId
    ? deriveEventIdentity({ providerEventId: order.providerEventId, accountScope })
    : deriveEventIdentity({
        fingerprint: [order.providerOrderId, order.providerUpdatedAt, order.status, order.eventKind, order.providerSequence ?? null],
        accountScope,
      });
  return {
    family: "COMMERCE",
    eventType: `order.${order.eventKind}`,
    externalEventId: identity.externalEventId,
    dedupeBasis: identity.dedupeBasis,
    providerAccountRef: null,
    occurredAt: new Date(order.providerUpdatedAt),
    payload: order as unknown as Prisma.InputJsonValue,
    metadata: {
      v: 1,
      eventKind: order.eventKind,
      status: order.status,
      currency: order.currency,
      lineCount: order.lines?.length ?? null,
      buyerFacts: {
        phone: order.buyer.phone ? "supplied" : "not_supplied",
        email: order.buyer.email ? "supplied" : "not_supplied",
        providerCustomer: order.buyer.providerCustomerId ? "supplied" : "not_supplied",
      },
    } as Prisma.InputJsonValue,
  };
}

/** Structural check of a stored payload (the processor hands back JSON). */
export function isCommerceOrder(v: unknown): v is CommerceOrderV1 {
  const o = v as Partial<CommerceOrderV1> | null;
  return !!o && o.v === 1 && o.kind === "commerce_order" && typeof o.providerOrderId === "string" &&
    typeof o.status === "string" && typeof o.eventKind === "string" && typeof o.currency === "string" &&
    typeof o.totalMinor === "number" && typeof o.placedAt === "string" && typeof o.providerUpdatedAt === "string" &&
    !!o.buyer && typeof o.buyer === "object";
}

/** The sanitized attribution an order keeps (M8): origin + path only, utm lifted, never a query string. */
export function orderAttribution(order: CommerceOrderV1) {
  const a = order.attribution ?? {};
  const landing = sanitizeUrl(a.landingUrl);
  return sanitizeAttribution({
    channel: "store",
    provider: "commerce",
    source: a.source ?? landing.utm?.source,
    clickId: a.clickId,
    landingPage: a.landingUrl,
    referralSourceUrl: a.referrerUrl,
    utm: { ...(landing.utm ?? {}), ...(a.medium ? { medium: a.medium } : {}), ...(a.campaign ? { campaign: a.campaign } : {}) },
    firstTouchAt: order.placedAt,
  });
}

/** The ONE commerce normalizer: buyer → M4 contact hints; target commerce (never lead). */
export function normalizeCommerceOrder(event: ClaimedIntakeEvent): NormalizeResult {
  const order = event.payload;
  if (!isCommerceOrder(order)) return { ok: false, code: "malformed_payload" };
  const contact = normalizeContactHints({
    phone: order.buyer.phone,
    email: order.buyer.email,
    providerUserId: order.buyer.providerCustomerId,
    displayName: order.buyer.name,
  });
  return {
    ok: true,
    normalized: {
      occurredAt: event.occurredAt,
      contactHints: contact.hints,
      signals: contact.signals,
      identity: contact.hints ? "unresolved" : "none",
      attribution: orderAttribution(order),
      target: "commerce",
    },
  };
}
