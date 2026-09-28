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

/**
 * Upper bound for each Graph call of the connect flow (exchange, phone lookup,
 * WABA subscription). A hanging Graph request must end in a named failure, not
 * hold the owner's "מחברים…" screen open; three bounded calls keep the whole
 * connect well inside the client's own submit timeout.
 */
export const GRAPH_CONNECT_TIMEOUT_MS = 15_000;

function connectSignal(): AbortSignal {
  return AbortSignal.timeout(GRAPH_CONNECT_TIMEOUT_MS);
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
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
    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      signal: connectSignal(),
    });
    const data = (await res.json().catch(() => null)) as
      | { access_token?: unknown }
      | null;
    if (!res.ok || !data || typeof data.access_token !== "string" || !data.access_token) {
      return { ok: false, ...safeError(data, `exchange_${res.status}`) };
    }
    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, code: "exchange_timeout", message: "Token exchange timed out" };
    }
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
      signal: connectSignal(),
    });
    const data = (await res.json().catch(() => null)) as { success?: unknown } | null;
    if (!res.ok || !data || data.success !== true) {
      return { ok: false, ...safeError(data, `subscribe_${res.status}`) };
    }
    return { ok: true };
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, code: "subscribe_timeout", message: "WABA subscription timed out" };
    }
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
      signal: connectSignal(),
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
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, code: "display_timeout", message: "Phone number lookup timed out" };
    }
    return { ok: false, code: "display_network", message: "Network error fetching phone number" };
  }
}

export type WabaPhoneResult =
  | { ok: true; phoneNumberId: string; displayPhoneNumber: string }
  | { ok: false; code: string; message: string };

/**
 * Resolves the business phone number of a WABA — used for coexistence
 * onboarding, whose Embedded Signup finish event reports only `waba_id`.
 *
 * `GET /{waba-id}/phone_numbers` with the token from the code exchange, so it
 * can only see numbers of the WABA the owner just authorized. Exactly one
 * number is required: none or several is a named failure, never a guess.
 */
export async function fetchWabaPhoneNumber(
  wabaId: string,
  accessToken: string
): Promise<WabaPhoneResult> {
  const url = new URL(`${GRAPH_BASE}/${graphVersion()}/${encodeURIComponent(wabaId)}/phone_numbers`);
  url.searchParams.set("fields", "id,display_phone_number");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: connectSignal(),
    });
    const data = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!res.ok || !data || !Array.isArray(data.data)) {
      return { ok: false, ...safeError(data, `phones_${res.status}`) };
    }
    const numbers = (data.data as Array<{ id?: unknown; display_phone_number?: unknown }>).filter(
      (n) => typeof n?.id === "string" && n.id && typeof n.display_phone_number === "string" && n.display_phone_number
    );
    if (numbers.length === 0) {
      return { ok: false, code: "phones_none", message: "The WhatsApp Business account has no phone number" };
    }
    if (numbers.length > 1) {
      return { ok: false, code: "phones_multiple", message: "The WhatsApp Business account has several phone numbers" };
    }
    return {
      ok: true,
      phoneNumberId: numbers[0].id as string,
      displayPhoneNumber: numbers[0].display_phone_number as string,
    };
  } catch (err) {
    if (isTimeout(err)) {
      return { ok: false, code: "phones_timeout", message: "Phone number lookup timed out" };
    }
    return { ok: false, code: "phones_network", message: "Network error listing phone numbers" };
  }
}

export type SendTextResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; kind: "auth" | "window" | "other"; code: string; message: string };

/**
 * Sends a plain text WhatsApp message (Outbound MVP — Stage 1, text only).
 *
 * `POST /{phone-number-id}/messages` with the business access token. Returns the
 * provider message id (wamid) on success. On failure it classifies the error so
 * the caller can react:
 *   - `auth`   → 401/403 or OAuth code 190 (token revoked/expired) → caller wipes
 *                the connection via `markRevokedByMeta`.
 *   - `window` → code 131047: more than 24h since the customer last replied, so a
 *                free-form text is not allowed (a template would be required).
 *   - `other`  → anything else.
 *
 * The access token, request body, and provider id are never logged.
 */
export async function sendWhatsAppText(input: {
  phoneNumberId: string;
  accessToken: string;
  toPhone: string;
  text: string;
}): Promise<SendTextResult> {
  const to = input.toPhone.replace(/\D/g, "");
  const body = input.text;
  if (!input.phoneNumberId || !input.accessToken || !to || !body) {
    return { ok: false, kind: "other", code: "send_config_missing", message: "Missing send inputs" };
  }

  const url = new URL(
    `${GRAPH_BASE}/${graphVersion()}/${encodeURIComponent(input.phoneNumberId)}/messages`
  );

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });

    const data = (await res.json().catch(() => null)) as
      | {
          messages?: Array<{ id?: unknown }>;
          error?: { code?: unknown; message?: unknown };
        }
      | null;

    const providerId = data?.messages?.[0]?.id;
    if (res.ok && typeof providerId === "string" && providerId.length > 0) {
      return { ok: true, providerMessageId: providerId };
    }

    const rawCode = data?.error?.code;
    const errCode =
      typeof rawCode === "number"
        ? rawCode
        : typeof rawCode === "string"
          ? Number(rawCode)
          : NaN;
    const safe = safeError(data, `send_${res.status}`);

    if (res.status === 401 || res.status === 403 || errCode === 190) {
      return { ok: false, kind: "auth", ...safe };
    }
    if (errCode === 131047) {
      return { ok: false, kind: "window", ...safe };
    }
    return { ok: false, kind: "other", ...safe };
  } catch {
    return { ok: false, kind: "other", code: "send_network", message: "Network error sending message" };
  }
}
