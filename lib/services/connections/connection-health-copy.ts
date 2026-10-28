/**
 * A connection's provider-side health code (AcquisitionConnection.lastErrorCode, written only by
 * setConnectionHealth / markConnectionError as a bounded A–Z0–9_ code) → what the owner reads.
 *
 * One map for every surface that shows that code: the "חנויות ושיחות" panel and the Connections
 * center (lib/services/connections/connections-center.model.ts). A provider's raw error text is
 * never shown — only these keys, and an unknown code reads as the caller's generic fallback.
 *
 * Pure and client-safe: no server import.
 */
import type { MessageKey } from "@/lib/i18n/translate";

export const CONNECTION_HEALTH: Readonly<Record<string, MessageKey>> = {
  // M7-B — stores (moved verbatim from StoresAndCallsPanel's HEALTH map).
  WOO_KEYS_REVOKED: "account.settings.connections.stores.health.wooKeysRevoked",
  WOO_STORE_UNREACHABLE: "account.settings.connections.stores.health.wooUnreachable",
  WOO_STORE_ERROR: "account.settings.connections.stores.health.wooError",
  WOO_WEBHOOK_SETUP_FAILED: "account.settings.connections.stores.health.wooWebhookSetupFailed",
  WOO_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
  WIX_APP_UNINSTALLED: "account.settings.connections.stores.health.wixUninstalled",
  WIX_RECONCILE_FAILED: "account.settings.connections.stores.health.reconcileFailed",
  // Leads L1 · G-06 — CloudTalk credentials (lib/intake/acquisition/providers/cloudtalk.ts). Shown on an ACTIVE
  // connection too: it keeps receiving, the owner must fix the key.
  CLOUDTALK_API_KEY_MISSING: "account.settings.connections.stores.health.cloudTalkKeyMissing",
  CLOUDTALK_API_KEY_INVALID: "account.settings.connections.stores.health.cloudTalkKeyInvalid",
  // M6 — Meta Lead Ads (lib/intake/acquisition/providers/meta-lead-ads.ts).
  META_TOKEN_INVALID: "account.settings.connections.center.health.metaTokenInvalid",
  META_PERMISSION_MISSING: "account.settings.connections.center.health.metaPermissionMissing",
  // S1-A — Rivhit (lib/revenue-sources/rivhit/sync.ts).
  RIVHIT_TOKEN_REJECTED: "account.settings.connections.center.health.rivhitTokenRejected",
};

/** The generic fallback the Connections center uses for a code it does not know. */
export const CONNECTION_HEALTH_GENERIC: MessageKey = "account.settings.connections.center.health.generic";

export function connectionHealthKey(code: string | null | undefined, fallback: MessageKey = CONNECTION_HEALTH_GENERIC): MessageKey {
  return code && Object.prototype.hasOwnProperty.call(CONNECTION_HEALTH, code) ? CONNECTION_HEALTH[code] : fallback;
}
