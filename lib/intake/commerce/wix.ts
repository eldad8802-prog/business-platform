/**
 * M7-B — Wix eCommerce (source "commerce.wix"), a Dubiz Wix app. Official behaviour this module is built on
 * (dev.wix.com: about-webhooks, handle-events-without-the-SDK, order object, OAuth client credentials):
 *
 *   delivery   the body is a JWT signed by Wix, verified with the app's PUBLIC KEY (app dashboard → Webhooks →
 *              Get Public Key). Its `data` claim is a JSON string {eventType, instanceId, data: <JSON string>};
 *              the inner data is {id (event id — dedupe), entityFqdn "wix.ecom.v1.order", slug, entityId,
 *              entityEventSequence, createdEvent.entity | updatedEvent.currentEntity | actionEvent.body.order}.
 *   retries    up to 12 more attempts over ~47 h; a 1250 ms response limit — so Dubiz stores the receipt and
 *              answers, processing after the response. Out of order is possible: entityEventSequence orders.
 *   tenant     instanceId = one installation of the Dubiz app on one Wix site = AcquisitionConnection
 *              .externalResourceId (one live mapping per instance).
 *   auth       POST https://www.wixapis.com/oauth2/token {grant_type: client_credentials, client_id, client_secret,
 *              instance_id} → a 4-hour access token, sent as `Authorization: <token>` (no refresh tokens).
 *
 * The app credentials are Dubiz's (one Wix app): WIX_APP_ID, WIX_APP_SECRET, WIX_APP_PUBLIC_KEY (PEM) in Vercel
 * Production. No per-store secret exists — the JWT is the authentication.
 *
 * UNVERIFIED (recorded, enforced conservatively): the JWT algorithm (RS256 assumed; anything else refused);
 * eventType strings other than the slug (the slug + entityFqdn are what this module reads).
 */
import { createPublicKey, createVerify } from "node:crypto";
import type { IntakeReceiptDraft } from "@/lib/intake/core/contract";
import { canonicalOrder, commerceReceipt, CommerceOrderInvalid, type OrderEventKind, type OrderStatus } from "./canonical";
import { toMinor } from "./money";

export const WIX_SOURCE = "commerce.wix" as const;
export const WIX_ORDER_FQDN = "wix.ecom.v1.order";

export function wixAppConfig(): { appId: string; appSecret: string; publicKey: string } | null {
  const appId = process.env.WIX_APP_ID?.trim();
  const appSecret = process.env.WIX_APP_SECRET?.trim();
  const publicKey = process.env.WIX_APP_PUBLIC_KEY?.trim().replace(/\\n/g, "\n");
  return appId && appSecret && publicKey ? { appId, appSecret, publicKey } : null;
}

export type WixEnvelope = { instanceId: string; eventId: string; slug: string; entityFqdn: string; sequence: number | null; order: unknown };

/**
 * RS256 only (anything else is refused): the signature over "<header>.<payload>" with the app's public key;
 * `exp` / `nbf` honoured when present (60 s skew). Returns the claims, or null.
 */
export function verifyRs256(jwt: string, publicKeyPem: string, nowSec: number): Record<string, unknown> | null {
  const [h, p, sig] = jwt.split(".");
  try {
    const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "RS256") return null;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    if (!v.verify(createPublicKey(publicKeyPem), Buffer.from(sig, "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof claims.exp === "number" && claims.exp + 60 < nowSec) return null;
    if (typeof claims.nbf === "number" && claims.nbf - 60 > nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Verify the JWT body with the app's public key and unwrap the two JSON layers. */
export async function verifyWixWebhook(raw: string, publicKeyPem: string): Promise<WixEnvelope | null> {
  const jwt = raw.trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt) || jwt.length > 1_000_000) return null;
  const claims = verifyRs256(jwt, publicKeyPem, Math.floor(Date.now() / 1000));
  if (!claims) return null;
  try {
    const event = JSON.parse(String(claims.data)) as { instanceId?: unknown; data?: unknown };
    const inner = JSON.parse(String(event.data)) as Record<string, unknown>;
    const instanceId = typeof event.instanceId === "string" ? event.instanceId : "";
    const eventId = typeof inner.id === "string" ? inner.id : "";
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(instanceId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(eventId)) return null;
    const seq = Number(inner.entityEventSequence);
    const created = (inner.createdEvent as { entity?: unknown } | undefined)?.entity;
    const updated = (inner.updatedEvent as { currentEntity?: unknown } | undefined)?.currentEntity;
    const action = ((inner.actionEvent as { body?: { order?: unknown } } | undefined)?.body)?.order;
    return {
      instanceId,
      eventId,
      slug: typeof inner.slug === "string" ? inner.slug : "",
      entityFqdn: typeof inner.entityFqdn === "string" ? inner.entityFqdn : "",
      sequence: Number.isSafeInteger(seq) && seq >= 0 ? seq : null,
      order: created ?? updated ?? action ?? null,
    };
  } catch {
    return null;
  }
}

/** Wix order (status × paymentStatus × fulfillmentStatus) → the canonical status. */
export function wixStatus(o: Record<string, unknown>): OrderStatus {
  const status = o.status;
  const pay = o.paymentStatus;
  if (status === "CANCELED" || status === "REJECTED") return "cancelled";
  if (pay === "FULLY_REFUNDED") return "refunded";
  if (pay === "PARTIALLY_REFUNDED") return "partially_refunded";
  if (o.fulfillmentStatus === "FULFILLED") return "fulfilled";
  if (pay === "PAID") return "paid";
  return "placed";
}

function eventKindOf(slug: string, status: OrderStatus): OrderEventKind {
  if (slug === "created") return "created";
  if (status === "cancelled") return "cancelled";
  if (status === "refunded" || status === "partially_refunded") return "refunded";
  if (status === "fulfilled") return "fulfilled";
  if (status === "paid") return "paid";
  return "updated";
}

const amount = (v: unknown) => (v && typeof v === "object" ? (v as { amount?: unknown }).amount : undefined);

export type WixParse = { ok: true; receipt: IntakeReceiptDraft } | { ok: true; ignored: string } | { ok: false; code: string };

/** A Wix Order entity → one canonical receipt (`eventId` when it came from a webhook; the poller has none). */
export function parseWixOrder(order: unknown, ctx: { slug: string; eventId?: string; sequence: number | null }, accountScope: string): WixParse {
  if (!order || typeof order !== "object" || Array.isArray(order)) return { ok: true, ignored: "no_order_entity" };
  const o = order as Record<string, unknown>;
  if (o.status === "INITIALIZED") return { ok: true, ignored: "not_yet_an_order" };
  const currency = typeof o.currency === "string" ? o.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, code: "currency" };
  const totalMinor = toMinor(amount((o.priceSummary as Record<string, unknown> | undefined)?.total), currency);
  if (totalMinor === null) return { ok: false, code: "total" };
  const refunded = toMinor(amount((o.balanceSummary as Record<string, unknown> | undefined)?.refunded), currency) ?? 0;
  const status = wixStatus(o);
  const billing = ((o.billingInfo as Record<string, unknown> | undefined)?.contactDetails ?? {}) as Record<string, unknown>;
  const buyer = (o.buyerInfo ?? {}) as Record<string, unknown>;
  const name = [billing.firstName, billing.lastName].filter((v) => typeof v === "string" && v.trim()).join(" ");
  const lines = Array.isArray(o.lineItems) ? o.lineItems.slice(0, 500) : [];
  const updatedAt = typeof o.updatedDate === "string" ? o.updatedDate : typeof o.createdDate === "string" ? o.createdDate : undefined;
  try {
    const canonical = canonicalOrder({
      providerOrderId: o.id,
      ...(ctx.eventId ? { providerEventId: ctx.eventId } : {}),
      orderNumber: o.number,
      eventKind: eventKindOf(ctx.slug, status),
      status,
      currency,
      totalMinor,
      refundedMinor: Math.min(refunded, totalMinor),
      placedAt: o.createdDate,
      providerUpdatedAt: updatedAt,
      ...(ctx.sequence !== null ? { providerSequence: ctx.sequence } : {}),
      buyer: {
        phone: billing.phone,
        email: buyer.email,
        name: name || undefined,
        providerCustomerId: buyer.contactId,
      },
      lines: lines.map((l) => {
        const li = l as Record<string, unknown>;
        const quantity = typeof li.quantity === "number" ? li.quantity : Number(li.quantity);
        const lineTotal = toMinor(amount(li.totalPriceAfterTax) ?? amount(li.totalPriceBeforeTax), currency);
        const unit = toMinor(amount(li.price), currency);
        const qtyOk = Number.isInteger(quantity) && quantity > 0;
        return {
          lineKey: li.id,
          externalProductId: (li.catalogReference as { catalogItemId?: unknown } | undefined)?.catalogItemId,
          sku: (li.physicalProperties as { sku?: unknown } | undefined)?.sku,
          title: (li.productName as { original?: unknown } | undefined)?.original,
          quantity,
          unitMinor: unit ?? (lineTotal !== null && qtyOk ? Math.round(lineTotal / quantity) : undefined),
          // A line without its total (older orders) is its unit price × quantity — exact integer math.
          totalMinor: lineTotal ?? (unit !== null && qtyOk ? unit * quantity : undefined),
        };
      }),
      attribution: o.attributionSource === "FACEBOOK_ADS" ? { source: "facebook_ads" } : undefined,
    });
    // Without a webhook event id (the poller), the canonical fingerprint is (order, updatedDate, status, kind).
    return { ok: true, receipt: commerceReceipt(canonical, accountScope) };
  } catch (e) {
    return { ok: false, code: e instanceof CommerceOrderInvalid ? e.code : "malformed" };
  }
}

// ── REST (Dubiz app → Wix, per installation) ──────────────────────────────────────────────────────

type WixFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;
const realFetch: WixFetch = async (url, init) => {
  const r = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};
let wixFetch: WixFetch = realFetch;
export function setWixFetchForTests(fn: WixFetch | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  wixFetch = fn ?? realFetch;
}

export class WixApiError extends Error {
  constructor(readonly code: "not_installed" | "unauthorized" | "wix_error" | "unreachable" | "not_configured") {
    super(code);
  }
}

/** An access token for ONE installation (4 h). Fails when the instance is not an installation of our app. */
export async function mintWixToken(instanceId: string): Promise<string> {
  const cfg = wixAppConfig();
  if (!cfg) throw new WixApiError("not_configured");
  let res;
  try {
    res = await wixFetch("https://www.wixapis.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: cfg.appId, client_secret: cfg.appSecret, instance_id: instanceId }),
    });
  } catch {
    throw new WixApiError("unreachable");
  }
  const token = (res.json as { access_token?: unknown } | null)?.access_token;
  if (res.status === 400 || res.status === 404) throw new WixApiError("not_installed");
  if (res.status === 401 || res.status === 403) throw new WixApiError("unauthorized");
  if (res.status !== 200 || typeof token !== "string" || !token) throw new WixApiError("wix_error");
  return token;
}

/** The installation's own view of itself — proves the instance is ours before Dubiz binds it. */
export async function getWixInstance(token: string): Promise<{ instanceId: string; siteName: string | null }> {
  const res = await wixFetch("https://www.wixapis.com/apps/v1/instance", { method: "GET", headers: { authorization: token } });
  if (res.status === 401 || res.status === 403) throw new WixApiError("unauthorized");
  if (res.status !== 200) throw new WixApiError("wix_error");
  const j = res.json as { instance?: { instanceId?: unknown }; site?: { siteDisplayName?: unknown } } | null;
  const instanceId = typeof j?.instance?.instanceId === "string" ? j.instance.instanceId : "";
  if (!instanceId) throw new WixApiError("wix_error");
  return { instanceId, siteName: typeof j?.site?.siteDisplayName === "string" ? j.site.siteDisplayName.slice(0, 120) : null };
}

/** Orders updated after `afterIso`, oldest first, one page (cursor). */
export async function searchWixOrdersUpdatedAfter(token: string, afterIso: string, cursor?: string): Promise<{ orders: unknown[]; next: string | null }> {
  const body = {
    search: {
      filter: { updatedDate: { $gt: afterIso } },
      sort: [{ fieldName: "updatedDate", order: "ASC" }],
      cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) },
    },
  };
  const res = await wixFetch("https://www.wixapis.com/ecom/v1/orders/search", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new WixApiError(res.status === 401 || res.status === 403 ? "unauthorized" : "wix_error");
  const j = res.json as { orders?: unknown[]; metadata?: { cursors?: { next?: unknown }; hasNext?: unknown }; pagingMetadata?: { cursors?: { next?: unknown }; hasNext?: unknown } } | null;
  const meta = j?.metadata ?? j?.pagingMetadata;
  const next = meta?.hasNext && typeof meta.cursors?.next === "string" ? meta.cursors.next : null;
  return { orders: Array.isArray(j?.orders) ? j.orders : [], next };
}
