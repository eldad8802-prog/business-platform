/**
 * Server-side Meta Graph client for WhatsApp Embedded Signup (Ticket 4).
 *
 * The ONLY module that talks to graph.facebook.com for the connect flow.
 * It performs no DB writes. It never logs the `code`, the `access_token`,
 * or the App Secret.
 *
 * Env (server-side):
 *   - App ID:        META_APP_ID            (falls back to NEXT_PUBLIC_META_APP_ID — public value)
 *   - Graph version: WHATSAPP_GRAPH_VERSION (falls back to NEXT_PUBLIC_… or a default)
 *   - App Secret:    WHATSAPP_APP_SECRET    (server-only — NO public fallback, never leaves the server)
 */

const GRAPH_BASE = "https://graph.facebook.com";
const DEFAULT_GRAPH_VERSION = "v23.0";

function graphVersion(): string {
  return (
    process.env.WHATSAPP_GRAPH_VERSION?.trim() ||
    process.env.NEXT_PUBLIC_WHATSAPP_GRAPH_VERSION?.trim() ||
    DEFAULT_GRAPH_VERSION
  );
}

function appId(): string | null {
  return (
    process.env.META_APP_ID?.trim() ||
    process.env.NEXT_PUBLIC_META_APP_ID?.trim() ||
    null
  );
}

function appSecret(): string | null {
  // Server-only. No NEXT_PUBLIC fallback — it must never reach the client.
  return process.env.WHATSAPP_APP_SECRET?.trim() || null;
}

/** Extracts a short, safe error label from a Graph error body. Never includes secrets. */
function safeError(data: unknown, fallbackCode: string): { code: string; message: string } {
  const err = (data as { error?: { code?: unknown; message?: unknown; type?: unknown } })?.error;
  const code =
    err && (typeof err.code === "number" || typeof err.code === "string")
      ? `${fallbackCode}_${String(err.code)}`
      : fallbackCode;
  const message =
    err && typeof err.message === "string" ? err.message.slice(0, 200) : "Graph request failed";
  return { code: code.slice(0, 64), message };
}

export type ExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: string; message: string };

/**
 * Exchanges the Embedded Signup authorization `code` for an access token.
 * No `redirect_uri` — this is the JS SDK code flow. App Secret stays server-side.
 */
export async function exchangeCodeForToken(code: string): Promise<ExchangeResult> {
  const id = appId();
  const secret = appSecret();
  if (!id || !secret) {
    return { ok: false, code: "config_missing", message: "Missing Meta app credentials" };
  }

  const url = new URL(`${GRAPH_BASE}/${graphVersion()}/oauth/access_token`);
  url.searchParams.set("client_id", id);
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("code", code);

  try {
    // NOTE: the URL carries the App Secret — never log it.
    const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
    const data = (await res.json().catch(() => null)) as
      | { access_token?: unknown }
      | null;
    if (!res.ok || !data || typeof data.access_token !== "string" || !data.access_token) {
      return { ok: false, ...safeError(data, `exchange_${res.status}`) };
    }
    return { ok: true, accessToken: data.access_token };
  } catch {
    return { ok: false, code: "exchange_network", message: "Network error during token exchange" };
  }
}

export type SubscribeWabaResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Registers our Meta app on the WABA's webhook subscriptions so that inbound
 * events (messages, statuses) for this business start being delivered to our
 * webhook endpoint.
 *
 * `POST /{waba-id}/subscribed_apps` — the app is inferred from the bearer
 * token; no body is required. Uses the business access token from the code
 * exchange (it carries `whatsapp_business_management`). The token is sent in
 * the Authorization header and is never logged.
 *
 * Returns `ok: false` (with a safe, secret-free code/message) on any non-2xx
 * or when Graph does not confirm `success: true`. Callers MUST treat a
 * failure as a hard stop and NOT persist the connection.
 */
export async function subscribeWabaToApp(input: {
  wabaId: string;
  accessToken: string;
}): Promise<SubscribeWabaResult> {
  const wabaId = input.wabaId?.trim();
  if (!wabaId || !input.accessToken) {
    return { ok: false, code: "subscribe_config_missing", message: "Missing wabaId or access token" };
  }

  const url = new URL(`${GRAPH_BASE}/${graphVersion()}/${encodeURIComponent(wabaId)}/subscribed_apps`);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    const data = (await res.json().catch(() => null)) as { success?: unknown } | null;
    if (!res.ok || !data || data.success !== true) {
      return { ok: false, ...safeError(data, `subscribe_${res.status}`) };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "subscribe_network", message: "Network error subscribing WABA" };
  }
}

export type PhoneDisplayResult =
  | { ok: true; displayPhoneNumber: string; verifiedName: string | null }
  | { ok: false; code: string; message: string };

/**
 * Reads the phone number node for its display number. Used to show a real
 * "connected" number and to confirm the token can address the phone.
 */
export async function fetchPhoneNumberDisplay(
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneDisplayResult> {
  const url = new URL(`${GRAPH_BASE}/${graphVersion()}/${encodeURIComponent(phoneNumberId)}`);
  url.searchParams.set("fields", "display_phone_number,verified_name");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => null)) as
      | { display_phone_number?: unknown; verified_name?: unknown }
      | null;
    if (!res.ok || !data || typeof data.display_phone_number !== "string" || !data.display_phone_number) {
      return { ok: false, ...safeError(data, `display_${res.status}`) };
    }
    return {
      ok: true,
      displayPhoneNumber: data.display_phone_number,
      verifiedName: typeof data.verified_name === "string" ? data.verified_name : null,
    };
  } catch {
    return { ok: false, code: "display_network", message: "Network error fetching phone number" };
  }
}
