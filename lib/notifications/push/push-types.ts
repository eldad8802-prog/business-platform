/**
 * The unified push sender's vocabulary (notifications track spec, 2026-11-12). SERVER-ONLY.
 */
import type { Importance } from "../catalog";

export type PushProvider = "WEB_PUSH" | "FCM";

/** One device row (PushSubscription) as the sender needs it. An FCM device's endpoint is `fcm:<token>`. */
export type PushDevice = { id: number; provider: string; endpoint: string; p256dh: string; auth: string };

/** What a device is shown and told. Built by push-content.ts — already lock-screen safe and href-validated. */
export type PushMessage = {
  notificationId: number;
  category: string;
  importance: Importance;
  title: string;
  body: string;
  /** Internal path only (validated against the category's prefixes). */
  href: string;
  /** Android tag / web push topic. */
  collapseKey: string;
  /** Seconds the push service may hold the message for an offline device. */
  ttlSeconds: number;
};

/**
 * The outcome of one attempt, classified:
 *   sent            — accepted by the push service;
 *   gone            — the device / token is dead for good (web 404 / 410; FCM UNREGISTERED, an invalid token) →
 *                     the subscription is revoked;
 *   transient       — try again later (429, 5xx, network, timeout);
 *   permanent       — this message will never go to this device as it is (other 4xx, a refused endpoint);
 *   not_configured  — the provider has no configuration in this deployment: skipped, nothing recorded.
 * `code` is a short machine code (e.g. web_410, fcm_UNREGISTERED, timeout) — never a token, URL or secret.
 */
export type PushResult =
  | { kind: "sent"; code: string }
  | { kind: "gone"; code: string }
  | { kind: "transient"; code: string }
  | { kind: "permanent"; code: string }
  | { kind: "not_configured"; code: string };

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;
