/**
 * M7-B — WooCommerce (source "commerce.woocommerce"). Official behaviour this module is built on
 * (WooCommerce source, class-wc-webhook.php / class-wc-auth.php; REST API v3 docs):
 *
 *   delivery    POST application/json, body = the REST v3 order resource (exactly GET /wc/v3/orders/<id>);
 *               X-WC-Webhook-Signature = base64(HMAC-SHA256(raw body, webhook secret)); X-WC-Webhook-Topic;
 *               X-WC-Webhook-Source = the store's home URL with a trailing slash.
 *   no retries  a failed delivery is LOST, and the webhook is disabled after consecutive failures — so a
 *               poller reconciles (orders modified_after, dates_are_gmt) and re-activates disabled webhooks.
 *   coalesced   one delivery per webhook + order every ~10 minutes, built at send time: several changes can
 *               arrive as one state.
 *   deleted     order.deleted (trash) carries only {id}: nothing is written (the order is kept as it was).
 *   ping        on webhook creation, a form body `webhook_id=<n>` that must get exactly 200.
 *   auth        REST: HTTP Basic with the consumer key / secret (HTTPS). Keys arrive by the store POSTing
 *               them to our callback after /wc-auth/v1/authorize (scope read_write: we create webhooks).
 *
 * The receipt identity is (order id, date_modified_gmt, status): a webhook delivery and the poller seeing
 * the same state are ONE receipt; a real later change is a new one.
 */
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { canonicalOrder, commerceReceipt, CommerceOrderInvalid, type OrderEventKind, type OrderStatus } from "./canonical";
import { toMinor } from "./money";

export const WOO_SOURCE = "commerce.woocommerce" as const;
export const WOO_TOPICS = ["order.created", "order.updated", "order.deleted", "order.restored"] as const;
/** Topics Dubiz subscribes a store to. order.deleted (trash) is subscribed so it is acknowledged, never acted on. */
export const WOO_SUBSCRIBED_TOPICS = ["order.created", "order.updated", "order.restored"] as const;

const gmt = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** WooCommerce status (filterable; plugins add more) → the canonical status. Unknown stays "placed". */
export function wooStatus(status: unknown, refundedMinor: number, totalMinor: number): OrderStatus | "ignore" {
  switch (status) {
    case "trash":
    case "auto-draft":
    case "checkout-draft":
      return "ignore";
    case "processing":
      return refundedMinor > 0 ? "partially_refunded" : "paid";
    case "completed":
      return refundedMinor > 0 && refundedMinor < totalMinor ? "partially_refunded" : "fulfilled";
    case "refunded":
      return "refunded";
    case "cancelled":
    case "failed":
      return "cancelled";
    default:
      return refundedMinor > 0 && refundedMinor < totalMinor ? "partially_refunded" : "placed";
  }
}

function eventKindOf(topic: string | null, status: OrderStatus): OrderEventKind {
  if (topic === "order.created") return "created";
  if (topic === "order.restored") return "restored";
  if (status === "paid") return "paid";
  if (status === "fulfilled") return "fulfilled";
  if (status === "cancelled") return "cancelled";
  if (status === "refunded" || status === "partially_refunded") return "refunded";
  return "updated";
}

const ATTR_PREFIX = "_wc_order_attribution_";

export type WooParse =
  | { ok: true; receipt: IntakeReceiptDraft; orderId: string; modifiedAt: string }
  | { ok: true; ignored: string }
  | { ok: false; code: string };

/** One REST v3 order resource (from a webhook or the poller) → one canonical receipt. */
export function parseWooOrder(order: unknown, topic: string | null, accountScope: string): WooParse {
  if (!order || typeof order !== "object" || Array.isArray(order)) return { ok: false, code: "malformed" };
  const o = order as Record<string, unknown>;
  const id = o.id;
  if ((typeof id !== "number" && typeof id !== "string") || !String(id).match(/^[0-9]{1,20}$/)) return { ok: false, code: "order_id" };
  if (topic === "order.deleted") return { ok: true, ignored: "trashed" };
  const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, code: "currency" };
  const totalMinor = toMinor(o.total, currency);
  if (totalMinor === null) return { ok: false, code: "total" };
  const refunds = Array.isArray(o.refunds) ? o.refunds : [];
  let refundedMinor = 0;
  for (const r of refunds.slice(0, 200)) {
    const m = toMinor((r as { total?: unknown })?.total, currency);
    if (m !== null) refundedMinor += m;
  }
  refundedMinor = Math.min(refundedMinor, totalMinor);
  const status = wooStatus(o.status, refundedMinor, totalMinor);
  if (status === "ignore") return { ok: true, ignored: "not_an_order_state" };
  const modifiedAt = gmt(o.date_modified_gmt) ?? gmt(o.date_created_gmt);
  const placedAt = gmt(o.date_created_gmt);
  if (!modifiedAt || !placedAt) return { ok: false, code: "time" };

  const billing = (o.billing && typeof o.billing === "object" ? o.billing : {}) as Record<string, unknown>;
  const name = [billing.first_name, billing.last_name].filter((v) => typeof v === "string" && v.trim()).join(" ");
  const lineItems = Array.isArray(o.line_items) ? o.line_items.slice(0, 500) : [];
  const meta = Array.isArray(o.meta_data) ? o.meta_data : [];
  const attr: Record<string, string> = {};
  for (const m of meta.slice(0, 300)) {
    const k = (m as { key?: unknown })?.key;
    const v = (m as { value?: unknown })?.value;
    if (typeof k === "string" && k.startsWith(ATTR_PREFIX) && typeof v === "string") attr[k.slice(ATTR_PREFIX.length)] = v;
  }

  try {
    const canonical = canonicalOrder({
      providerOrderId: String(id),
      // One state of one order: the webhook and the poller derive the same id for the same state.
      providerEventId: `${id}:${modifiedAt}:${String(o.status)}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128),
      orderNumber: o.number,
      eventKind: eventKindOf(topic, status),
      status,
      currency,
      totalMinor,
      refundedMinor,
      placedAt,
      providerUpdatedAt: modifiedAt,
      buyer: {
        phone: billing.phone,
        email: billing.email,
        name: name || undefined,
        providerCustomerId: typeof o.customer_id === "number" && o.customer_id > 0 ? String(o.customer_id) : undefined,
      },
      lines: lineItems.map((l) => {
        const li = l as Record<string, unknown>;
        const quantity = typeof li.quantity === "number" ? li.quantity : Number(li.quantity);
        const lineTotal = toMinor(li.total, currency);
        return {
          lineKey: li.id,
          externalProductId: li.variation_id && li.variation_id !== 0 ? `${li.product_id}:${li.variation_id}` : li.product_id,
          sku: li.sku,
          title: li.name,
          quantity,
          // The unit price as charged: the line total over its quantity (Woo's `price` may be a long float).
          unitMinor: lineTotal !== null && Number.isInteger(quantity) && quantity > 0 ? Math.round(lineTotal / quantity) : undefined,
          totalMinor: lineTotal ?? undefined,
        };
      }),
      attribution: {
        landingUrl: attr.session_entry,
        referrerUrl: attr.referrer,
        source: attr.utm_source ?? attr.source_type,
        medium: attr.utm_medium,
        campaign: attr.utm_campaign,
      },
    });
    return { ok: true, receipt: commerceReceipt(canonical, accountScope), orderId: String(id), modifiedAt };
  } catch (e) {
    return { ok: false, code: e instanceof CommerceOrderInvalid ? e.code : "malformed" };
  }
}

/** WooCommerce's creation ping: a form body `webhook_id=<n>` (must be answered exactly 200). */
export function isWooPing(raw: string): boolean {
  return /^webhook_id=[0-9]{1,20}$/.test(raw.trim());
}

/** The store's site URL → the host Dubiz binds (one live mapping per store host). */
export function storeHostOf(siteUrl: string): string | null {
  try {
    const u = new URL(siteUrl);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const host = u.host.toLowerCase();
    return /^[a-z0-9.-]{1,64}(:[0-9]{1,5})?$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** A store URL the owner typed → its canonical https origin + path (no query, no fragment). */
export function normalizeStoreUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    if (!storeHostOf(u.origin)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

// ── REST client (server → store, HTTP Basic over HTTPS) ───────────────────────────────────────────

type WooFetch = (url: string, init: { method: string; auth: string; body?: string }) => Promise<{ status: number; json: unknown; headers: Record<string, string> }>;
const realFetch: WooFetch = async (url, init) => {
  const r = await fetch(url, {
    method: init.method,
    headers: { authorization: `Basic ${init.auth}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: r.status, json, headers };
};
let wooFetch: WooFetch = realFetch;
/** Lab only: a stand-in for the store. Refused in production. */
export function setWooFetchForTests(fn: WooFetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  wooFetch = fn ?? realFetch;
}

export class WooApiError extends Error {
  constructor(readonly code: "unauthorized" | "not_found" | "store_error" | "unreachable") {
    super(code);
  }
}

export type WooCredentials = { siteUrl: string; consumerKey: string; consumerSecret: string };

async function call(c: WooCredentials, method: string, path: string, body?: unknown) {
  const auth = Buffer.from(`${c.consumerKey}:${c.consumerSecret}`, "utf8").toString("base64");
  let res;
  try {
    res = await wooFetch(`${c.siteUrl}/wp-json/wc/v3${path}`, { method, auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new WooApiError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new WooApiError("unauthorized");
  if (res.status === 404) throw new WooApiError("not_found");
  if (res.status < 200 || res.status >= 300) throw new WooApiError("store_error");
  return res;
}

export async function createWooWebhook(c: WooCredentials, topic: string, deliveryUrl: string, secret: string): Promise<string> {
  const res = await call(c, "POST", "/webhooks", { name: `Dubiz ${topic}`, topic, delivery_url: deliveryUrl, secret });
  const id = (res.json as { id?: unknown } | null)?.id;
  if (typeof id !== "number" && typeof id !== "string") throw new WooApiError("store_error");
  return String(id);
}

export async function getWooWebhookStatus(c: WooCredentials, id: string): Promise<string> {
  const res = await call(c, "GET", `/webhooks/${encodeURIComponent(id)}`);
  const status = (res.json as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : "unknown";
}

export async function reactivateWooWebhook(c: WooCredentials, id: string): Promise<void> {
  await call(c, "PUT", `/webhooks/${encodeURIComponent(id)}`, { status: "active" });
}

export async function deleteWooWebhook(c: WooCredentials, id: string): Promise<void> {
  await call(c, "DELETE", `/webhooks/${encodeURIComponent(id)}?force=true`).catch(() => undefined);
}

/** One page of orders modified after `afterGmt` (oldest first). */
export async function listWooOrdersModifiedAfter(c: WooCredentials, afterGmt: string, page: number): Promise<{ orders: unknown[]; totalPages: number }> {
  const q = new URLSearchParams({ modified_after: afterGmt.replace(/\.\d{3}Z$/, ""), dates_are_gmt: "true", orderby: "modified", order: "asc", per_page: "100", page: String(page) });
  const res = await call(c, "GET", `/orders?${q.toString()}`);
  const orders = Array.isArray(res.json) ? res.json : [];
  const totalPages = Number(res.headers["x-wp-totalpages"] ?? "1") || 1;
  return { orders, totalPages };
}
