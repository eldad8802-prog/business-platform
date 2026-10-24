"use client";

/**
 * Web Push — the browser side (owner-approved plan 2026-10-21). Permission is asked ONLY from a tap on "הפעלת
 * תזכורות לטלפון" (never on load), as browsers require and as the owner asked.
 *
 * Support, in the owner's words (shown by the card):
 *   - Android (Chrome / Edge / Samsung Internet), a computer (Chrome / Edge / Firefox): supported in the browser,
 *     and in the app installed from the browser;
 *   - iPhone / iPad: iOS 16.4 or later, and ONLY from Dubiz added to the home screen (Safari → Share → "הוסף למסך
 *     הבית"), opened from its icon. In a Safari tab there is no push on iPhone;
 *   - the native Dubiz app (Capacitor WebView): not in this phase.
 */
import { buildClientAuthHeaders } from "@/lib/client-session";

export type PushSupport =
  | { kind: "supported" }
  | { kind: "ios-needs-install" }
  | { kind: "ios-too-old" }
  | { kind: "unsupported" };

export type PushState = "on" | "off" | "denied" | "unavailable";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { kind: "unsupported" };
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos()) {
    const m = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    if (major && (major < 16 || (major === 16 && minor < 4))) return { kind: "ios-too-old" };
    if (!isStandalone()) return { kind: "ios-needs-install" };
  }
  return hasApis ? { kind: "supported" } : { kind: "unsupported" };
}

export function platformOf(): "android" | "ios" | "desktop" | "other" {
  if (typeof navigator === "undefined") return "other";
  if (isIos()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  if (/Windows|Macintosh|Linux|CrOS/i.test(navigator.userAgent)) return "desktop";
  return "other";
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function bytesToB64url(buf: ArrayBuffer | null): string {
  if (!buf) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

async function serverConfig(): Promise<{ configured: boolean; publicKey: string | null } | null> {
  const r = await fetch("/api/push/subscriptions", { cache: "no-store", headers: buildClientAuthHeaders() });
  if (!r.ok) return null;
  return (await r.json()) as { configured: boolean; publicKey: string | null };
}

/** The current state for this browser (no prompt). */
export async function pushState(): Promise<PushState> {
  if (pushSupport().kind !== "supported") return "unavailable";
  if (Notification.permission === "denied") return "denied";
  const cfg = await serverConfig().catch(() => null);
  if (!cfg?.configured) return "unavailable";
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

/** Ask permission (call from a tap), subscribe, and register the subscription with the server. */
export async function enablePush(): Promise<PushState> {
  if (pushSupport().kind !== "supported") return "unavailable";
  const cfg = await serverConfig();
  if (!cfg?.configured || !cfg.publicKey) return "unavailable";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.publicKey) as BufferSource });
  }
  const res = await fetch("/api/push/subscriptions", {
    method: "POST",
    cache: "no-store",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: { p256dh: bytesToB64url(sub.getKey("p256dh")), auth: bytesToB64url(sub.getKey("auth")) },
      platform: platformOf(),
    }),
  });
  return res.ok ? "on" : "off";
}

/** Stop push to this browser (server marks it revoked; the browser unsubscribes). */
export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/subscriptions/revoke", {
      method: "POST",
      cache: "no-store",
      headers: buildClientAuthHeaders(),
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return "off";
}
