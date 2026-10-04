/**
 * M6 — Meta Lead Ads configuration (server side).
 *
 * Dubiz has ONE Meta app (META_APP_ID / NEXT_PUBLIC_META_APP_ID), whose secret is already held as
 * WHATSAPP_APP_SECRET. Lead Ads uses the same app, so its secret is that one unless a separate app
 * is configured (META_LEAD_ADS_APP_SECRET). The webhook verify token is Dubiz's own random value,
 * entered once in the app's Webhooks settings for the "page" object. The Facebook Login for Business
 * configuration that requests the lead permissions is public (NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID).
 * Page tokens are encrypted with ACQUISITION_CREDENTIAL_ENCRYPTION_KEY.
 *
 * Meta is offered to an owner only when ALL of these exist — otherwise the source is shown as not
 * yet available, never as a connect button that cannot work.
 */
import { isCredentialKeyConfigured } from "./credential-crypto";

const DEFAULT_GRAPH_VERSION = "v25.0";

export function metaAppId(): string | null {
  return process.env.META_APP_ID?.trim() || process.env.NEXT_PUBLIC_META_APP_ID?.trim() || null;
}

/** Server-only. Never a NEXT_PUBLIC value. */
export function metaAppSecret(): string | null {
  return process.env.META_LEAD_ADS_APP_SECRET?.trim() || process.env.WHATSAPP_APP_SECRET?.trim() || null;
}

export function metaVerifyToken(): string | null {
  return process.env.META_LEAD_ADS_VERIFY_TOKEN?.trim() || null;
}

export function metaGraphVersion(): string {
  return process.env.META_LEAD_ADS_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
}

/** Public values the browser needs for FB.login (not secrets). */
export function metaLoginConfig(): { appId: string; configId: string; graphVersion: string } | null {
  const appId = metaAppId();
  const configId = process.env.NEXT_PUBLIC_META_LEAD_ADS_CONFIG_ID?.trim();
  return appId && configId ? { appId, configId, graphVersion: metaGraphVersion() } : null;
}

export function isMetaLeadAdsConfigured(): boolean {
  return !!(metaLoginConfig() && metaAppSecret() && metaVerifyToken() && isCredentialKeyConfigured());
}
