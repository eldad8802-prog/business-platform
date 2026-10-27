/**
 * Web Push — the server side (VAPID, RFC 8030 / 8291 / 8292 via `web-push`, pinned). SERVER-ONLY.
 *
 * Configured only when all three variables are set in the deployment:
 *   VAPID_PUBLIC_KEY   — the application server key the browser subscribes with (also served to the client);
 *   VAPID_PRIVATE_KEY  — signs every push (never leaves the server, never logged);
 *   VAPID_SUBJECT      — "mailto:…" or "https://…", the contact the push services may use.
 * Without them push is off: nothing is sent and every caller degrades to the in-app notification.
 *
 * A push carries no secret and no money: the task title, the moment and an internal link. The push service sees
 * only ciphertext (aes128gcm). 404 / 410 from the push service means the subscription is gone for good.
 */
import webpush from "web-push";

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; url: string; tag: string; taskId?: number; kind?: "task" | "booking"; requestId?: number };
export type PushOutcome = { ok: true; status: number } | { ok: false; gone: boolean; status: number | null };

type Env = Record<string, string | undefined>;

export function vapidConfig(env: Env = process.env): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function pushConfigured(env: Env = process.env): boolean {
  return vapidConfig(env) !== null;
}

/** The only push hosts a subscription may point at (the browsers' push services). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
  /^push\.services\.mozilla\.com$/,
];

/** True when an endpoint is an https URL on a known browser push service (never an arbitrary host: no SSRF). */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export async function sendWebPush(target: PushTarget, payload: PushPayload, env: Env = process.env): Promise<PushOutcome> {
  const cfg = vapidConfig(env);
  if (!cfg || !isAllowedPushEndpoint(target.endpoint)) return { ok: false, gone: false, status: null };
  try {
    const res = await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
        // An explicit reminder is wanted now; one that waited a day is no longer a reminder.
        TTL: 24 * 60 * 60,
        urgency: "high",
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
        timeout: 10_000,
      },
    );
    return { ok: true, status: res.statusCode };
  } catch (e) {
    const status = typeof (e as { statusCode?: unknown }).statusCode === "number" ? (e as { statusCode: number }).statusCode : null;
    return { ok: false, gone: status === 404 || status === 410, status };
  }
}
