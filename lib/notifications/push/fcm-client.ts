/**
 * Firebase Cloud Messaging — HTTP v1, server side, without an SDK (notifications track spec, 2026-11-12).
 * SERVER-ONLY.
 *
 *   1. A service-account JWT (RS256, node:crypto) is exchanged at https://oauth2.googleapis.com/token for an access
 *      token (scope firebase.messaging), cached until shortly before it expires.
 *   2. POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send with the device token.
 *
 * Configuration from the environment ONLY: FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY (PEM; `\n` escapes
 * accepted). Any of them missing or malformed ⇒ `not_configured` — skipped, never thrown. Every request has a
 * timeout. Nothing here logs: the caller logs the classified result (class + code), never a token or a secret.
 *
 * The Android notification is PRIVATE (a secure lock screen shows the system's redacted public version); its
 * channel is dubiz_urgent (critical / high) or dubiz_default; the data carries exactly
 * { notificationId, href, category } — the app re-validates the href before opening it.
 */
import { createSign } from "node:crypto";

import { androidChannelOf } from "../catalog";

import type { Env, FetchLike, PushMessage, PushResult } from "./push-types";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_:.-]{20,4096}$/;
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh a cached access token this long before Google says it expires. */
const TOKEN_EARLY_REFRESH_MS = 5 * 60_000;

export type FcmConfig = { projectId: string; clientEmail: string; privateKey: string };

export function fcmConfig(env: Env = process.env): FcmConfig | null {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const clientEmail = env.FCM_CLIENT_EMAIL?.trim();
  const rawKey = env.FCM_PRIVATE_KEY?.trim();
  if (!projectId || !clientEmail || !rawKey) return null;
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(projectId)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) return null;
  const privateKey = rawKey.replace(/\\n/g, "\n");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKey)) return null;
  return { projectId, clientEmail, privateKey };
}

export function fcmConfigured(env: Env = process.env): boolean {
  return fcmConfig(env) !== null;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** The signed service-account assertion (exported for the test, which verifies it with the public key). */
export function buildAssertion(cfg: FcmConfig, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: FCM_SCOPE, aud: OAUTH_TOKEN_URL, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(cfg.privateKey).toString("base64url")}`;
}

type CachedToken = { key: string; accessToken: string; expiresAtMs: number };
let cached: CachedToken | null = null;

/** Test hook: forget the cached access token. */
export function resetFcmTokenCache(): void {
  cached = null;
}

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function networkCode(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "network";
}

type TokenOutcome = { ok: true; accessToken: string } | { ok: false; result: PushResult };

async function accessToken(cfg: FcmConfig, fetchImpl: FetchLike, nowMs: number): Promise<TokenOutcome> {
  const key = `${cfg.projectId}|${cfg.clientEmail}`;
  if (cached && cached.key === key && cached.expiresAtMs - TOKEN_EARLY_REFRESH_MS > nowMs) {
    return { ok: true, accessToken: cached.accessToken };
  }
  let assertion: string;
  try {
    assertion = buildAssertion(cfg, nowMs);
  } catch {
    return { ok: false, result: { kind: "permanent", code: "fcm_key_invalid" } };
  }
  try {
    const res = await timed((signal) =>
      fetchImpl(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal,
      }),
    );
    if (res.status === 429 || res.status >= 500) return { ok: false, result: { kind: "transient", code: `oauth_${res.status}` } };
    if (res.status !== 200) return { ok: false, result: { kind: "permanent", code: `oauth_${res.status}` } };
    const body = JSON.parse(await res.text()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      return { ok: false, result: { kind: "transient", code: "oauth_malformed" } };
    }
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    cached = { key, accessToken: body.access_token, expiresAtMs: nowMs + ttl * 1000 };
    return { ok: true, accessToken: body.access_token };
  } catch (e) {
    return { ok: false, result: { kind: "transient", code: `oauth_${networkCode(e)}` } };
  }
}

/** The messages:send body (exported for the payload-privacy test). */
export function fcmMessageBody(token: string, msg: PushMessage) {
  const urgent = msg.importance === "critical" || msg.importance === "high";
  return {
    message: {
      token,
      notification: { title: msg.title, body: msg.body },
      data: { notificationId: String(msg.notificationId), href: msg.href, category: msg.category },
      android: {
        priority: urgent ? "HIGH" : "NORMAL",
        ttl: `${Math.max(0, Math.floor(msg.ttlSeconds))}s`,
        collapse_key: msg.collapseKey,
        notification: {
          channel_id: androidChannelOf(msg.importance),
          tag: msg.collapseKey,
          visibility: "PRIVATE",
          notification_priority: urgent ? "PRIORITY_HIGH" : "PRIORITY_DEFAULT",
        },
      },
    },
  };
}

type FcmErrorBody = { error?: { status?: string; message?: string; details?: { errorCode?: string }[] } };

/** Classify an FCM v1 error response. Exported for the test. */
export function classifyFcmError(status: number, rawBody: string): PushResult {
  let parsed: FcmErrorBody = {};
  try {
    parsed = JSON.parse(rawBody) as FcmErrorBody;
  } catch {
    /* not JSON */
  }
  const errorCode = parsed.error?.details?.find((d) => typeof d?.errorCode === "string")?.errorCode ?? parsed.error?.status ?? "";
  const code = `fcm_${errorCode || status}`.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
  if (errorCode === "UNREGISTERED" || status === 404) return { kind: "gone", code };
  if (errorCode === "SENDER_ID_MISMATCH") return { kind: "gone", code };
  if (errorCode === "INVALID_ARGUMENT" || status === 400) {
    // Only a refused TOKEN is the device's fault; a refused payload is ours (permanent, keep the device).
    return /registration token/i.test(parsed.error?.message ?? "") ? { kind: "gone", code } : { kind: "permanent", code };
  }
  if (status === 429 || status >= 500 || errorCode === "QUOTA_EXCEEDED" || errorCode === "UNAVAILABLE" || errorCode === "INTERNAL") {
    return { kind: "transient", code };
  }
  if (status === 401) return { kind: "transient", code };
  return { kind: "permanent", code };
}

/** Send one message to one FCM registration token. Never throws. */
export async function sendFcm(
  token: string,
  msg: PushMessage,
  deps: { env?: Env; fetch?: FetchLike; nowMs?: number } = {},
): Promise<PushResult> {
  const cfg = fcmConfig(deps.env ?? process.env);
  if (!cfg) return { kind: "not_configured", code: "fcm_not_configured" };
  if (!FCM_TOKEN_PATTERN.test(token)) return { kind: "gone", code: "fcm_token_shape" };
  const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const nowMs = deps.nowMs ?? Date.now();
  const auth = await accessToken(cfg, fetchImpl, nowMs);
  if (!auth.ok) return auth.result;
  try {
    const res = await timed((signal) =>
      fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth.accessToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(fcmMessageBody(token, msg)),
        signal,
      }),
    );
    if (res.status === 200) return { kind: "sent", code: "fcm_200" };
    // A rejected access token: drop it so the next attempt mints a new one.
    if (res.status === 401) cached = null;
    return classifyFcmError(res.status, await res.text().catch(() => ""));
  } catch (e) {
    return { kind: "transient", code: `fcm_${networkCode(e)}` };
  }
}
