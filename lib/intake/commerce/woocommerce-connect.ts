/**
 * M7-B — connecting a WooCommerce store, with nothing typed but the store's address:
 *
 *   1. start     the owner (signed in) gives the store URL → Dubiz returns the store's own approval page
 *                (/wc-auth/v1/authorize, scope read_write) with a SEALED state as `user_id` (business + store +
 *                Dubiz origin, 30 minutes) and our HTTPS callback.
 *   2. approve   the owner approves on THEIR store (WooCommerce checks manage_woocommerce).
 *   3. callback  the store POSTs {consumer_key, consumer_secret, user_id} to Dubiz (no owner session — the sealed
 *                state is the only thing naming the business). Dubiz binds the store (keys + its own webhook
 *                signing secret, ENCRYPTED, AAD-bound), then creates the store's order webhooks with that secret.
 *                WooCommerce deletes the keys unless we answer exactly 200.
 *   4. return    the owner's browser comes back to Dubiz (success=1).
 *
 * Re-connecting the same store revokes the business's previous binding first; a store live on ANOTHER business
 * is refused (one live mapping per store host).
 */
import { Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { logIntake } from "@/lib/intake/core/observability";
import { sourceGate } from "@/lib/intake/acquisition/gate";
import { openState, sealState } from "@/lib/intake/acquisition/sealed-state";
import {
  createSignedConnection, readConnectionSecrets, revokeConnection, setConnectionHealth, updateConnectionSecrets,
} from "@/lib/intake/acquisition/connection.service";
import { createWooWebhook, deleteWooWebhook, normalizeStoreUrl, storeHostOf, WOO_SOURCE, WOO_SUBSCRIBED_TOPICS, type WooCredentials } from "./woocommerce";

export function wooDeliveryUrl(origin: string, publicId: string): string {
  return `${origin}/api/intake/commerce/woocommerce/${publicId}`;
}

export function startWooConnect(businessId: number, origin: string, storeUrlInput: string): { authorizeUrl: string } | { error: "invalid_store_url" } {
  const storeUrl = normalizeStoreUrl(storeUrlInput);
  if (!storeUrl) return { error: "invalid_store_url" };
  const state = sealState("woocommerce.connect", businessId, { storeUrl, origin });
  const q = new URLSearchParams({
    app_name: "Dubiz",
    scope: "read_write",
    user_id: state,
    return_url: `${origin}/settings/connections?store=woocommerce`,
    callback_url: `${origin}/api/integrations/commerce/woocommerce/callback`,
  });
  return { authorizeUrl: `${storeUrl}/wc-auth/v1/authorize?${q.toString()}` };
}

/** Create (or re-create) the store's order webhooks; their ids live in the encrypted bundle. */
export async function ensureWooWebhooks(businessId: number, connectionId: number, publicId: string, origin: string): Promise<"ok" | "failed"> {
  const s = await readConnectionSecrets(businessId, connectionId, { anyLiveStatus: true });
  if (!s?.siteUrl || !s.consumerKey || !s.consumerSecret) return "failed";
  const creds: WooCredentials = { siteUrl: s.siteUrl, consumerKey: s.consumerKey, consumerSecret: s.consumerSecret };
  const ids: string[] = [];
  try {
    for (const topic of WOO_SUBSCRIBED_TOPICS) ids.push(await createWooWebhook(creds, topic, wooDeliveryUrl(origin, publicId), s.signingSecret));
  } catch {
    for (const id of ids) await deleteWooWebhook(creds, id);
    await setConnectionHealth(connectionId, "WOO_WEBHOOK_SETUP_FAILED");
    return "failed";
  }
  await updateConnectionSecrets(businessId, connectionId, { webhookIds: ids.join(","), origin });
  await setConnectionHealth(connectionId, null);
  return "ok";
}

/** Revoke a store binding; its Dubiz webhooks are removed from the store first (best-effort — the store may be gone). */
export async function disconnectWooStore(businessId: number, connectionId: number) {
  const s = await readConnectionSecrets(businessId, connectionId, { anyLiveStatus: true }).catch(() => null);
  if (s?.siteUrl && s.consumerKey && s.consumerSecret && s.webhookIds) {
    const creds: WooCredentials = { siteUrl: s.siteUrl, consumerKey: s.consumerKey, consumerSecret: s.consumerSecret };
    for (const id of s.webhookIds.split(",").filter(Boolean)) await deleteWooWebhook(creds, id).catch(() => undefined);
  }
  return revokeConnection(connectionId);
}

export type WooCallbackResult = { status: 200 | 400 | 403 | 409 | 503; body: Record<string, unknown> };

export async function completeWooConnect(body: unknown): Promise<WooCallbackResult> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const opened = openState("woocommerce.connect", b.user_id);
  if (!opened) return { status: 403, body: { error: "state_invalid" } };
  const { businessId } = opened;
  const storeUrl = opened.payload.storeUrl;
  const origin = opened.payload.origin;
  const consumerKey = typeof b.consumer_key === "string" ? b.consumer_key : "";
  const consumerSecret = typeof b.consumer_secret === "string" ? b.consumer_secret : "";
  if (!/^ck_[A-Za-z0-9]{20,64}$/.test(consumerKey) || !/^cs_[A-Za-z0-9]{20,64}$/.test(consumerSecret)) return { status: 400, body: { error: "keys_malformed" } };
  if (typeof b.key_permissions === "string" && b.key_permissions !== "read_write") return { status: 403, body: { error: "read_write_required" } };
  const host = storeHostOf(storeUrl);
  if (!host || !origin) return { status: 400, body: { error: "state_invalid" } };

  return runWithTenantContext({ businessId }, async () => {
    const gate = await sourceGate(businessId, WOO_SOURCE);
    if (!gate.ok) return { status: 403 as const, body: { error: "source_not_enabled" } };
    // Re-connecting this store replaces this business's previous binding (its webhooks are removed).
    const previous = await withTenantTransaction((tx) =>
      tx.acquisitionConnection.findMany({ where: { sourceKey: WOO_SOURCE, externalResourceId: host, status: { not: "REVOKED" } }, select: { id: true } })
    );
    // Polling resumes where the previous binding stopped: orders changed while the owner was reconnecting are recovered.
    let cursor = new Date().toISOString();
    for (const p of previous) {
      const prev = await readConnectionSecrets(businessId, p.id, { anyLiveStatus: true }).catch(() => null);
      if (prev?.cursor && prev.cursor < cursor) cursor = prev.cursor;
      await disconnectWooStore(businessId, p.id);
    }
    let created;
    try {
      created = await createSignedConnection({
        businessId,
        userId: null,
        sourceKey: WOO_SOURCE,
        label: host,
        externalResourceId: host,
        extraSecrets: { siteUrl: storeUrl, consumerKey, consumerSecret, cursor },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { status: 409 as const, body: { error: "store_connected_to_another_business" } };
      throw e;
    }
    const hooks = await ensureWooWebhooks(businessId, created.connection.id, created.connection.publicId, origin);
    logIntake("accepted", { businessId, sourceKey: WOO_SOURCE, count: 0, outcome: hooks === "ok" ? "connected" : "connected_without_webhooks" });
    // 200 either way: the keys are stored (the reconciler retries the webhooks); a non-200 makes the store delete them.
    return { status: 200 as const, body: { ok: true } };
  });
}
