/**
 * The unified push sender (notifications track spec, 2026-11-12). SERVER-ONLY.
 *
 * One entry point for every device a PushSubscription row describes:
 *   WEB_PUSH — lib/push/web-push-sender.ts, UNCHANGED (VAPID; its own endpoint allowlist, timeout and TTL);
 *   FCM      — ./fcm-client.ts (HTTP v1).
 * Each attempt comes back classified (sent / gone / transient / permanent / not_configured). Never throws.
 *
 * `deliverLegacyPush` is the loop the task reminders and the public booking reminders already ran, moved here
 * verbatim so both call the shared sender: the same rows in, the same web push payload out, the same delivery
 * rows and subscription bookkeeping written — behaviour unchanged.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  isAllowedPushEndpoint,
  pushConfigured,
  sendWebPush,
  type PushOutcome,
  type PushPayload,
  type PushTarget,
} from "@/lib/push/web-push-sender";

import { fcmConfigured, sendFcm } from "./fcm-client";
import type { Env, FetchLike, PushDevice, PushMessage, PushResult } from "./push-types";

export type SenderDeps = {
  env?: Env;
  fetch?: FetchLike;
  /** Test seam for the web push provider (defaults to the real sendWebPush). */
  webPush?: (target: PushTarget, payload: PushPayload, env?: Env) => Promise<PushOutcome>;
  nowMs?: number;
};

export function providerConfigured(provider: string, env: Env = process.env): boolean {
  if (provider === "WEB_PUSH") return pushConfigured(env);
  if (provider === "FCM") return fcmConfigured(env);
  return false;
}

/** The web push body the service worker reads (title / body / url / tag), plus the engine's identifiers. */
export function webPushPayloadOf(msg: PushMessage): PushPayload {
  return {
    title: msg.title,
    body: msg.body,
    url: msg.href,
    tag: msg.collapseKey,
    notificationId: msg.notificationId,
    category: msg.category,
  } as PushPayload;
}

/** Classify the web push sender's outcome. */
export function classifyWebPushOutcome(out: PushOutcome): PushResult {
  if (out.ok) return { kind: "sent", code: `web_${out.status}` };
  if (out.gone) return { kind: "gone", code: `web_${out.status ?? "gone"}` };
  if (out.status === null) return { kind: "transient", code: "web_network" };
  if (out.status === 429 || out.status >= 500) return { kind: "transient", code: `web_${out.status}` };
  return { kind: "permanent", code: `web_${out.status}` };
}

/** Send one message to one device. Never throws. */
export async function sendToDevice(device: PushDevice, msg: PushMessage, deps: SenderDeps = {}): Promise<PushResult> {
  const env = deps.env ?? process.env;
  try {
    if (device.provider === "FCM") {
      if (!device.endpoint.startsWith("fcm:")) return { kind: "permanent", code: "fcm_endpoint_shape" };
      return await sendFcm(device.endpoint.slice(4), msg, { env, fetch: deps.fetch, nowMs: deps.nowMs });
    }
    if (device.provider !== "WEB_PUSH") return { kind: "permanent", code: "provider_unknown" };
    if (!pushConfigured(env)) return { kind: "not_configured", code: "web_not_configured" };
    if (!isAllowedPushEndpoint(device.endpoint)) return { kind: "permanent", code: "web_endpoint_refused" };
    const send = deps.webPush ?? sendWebPush;
    return classifyWebPushOutcome(await send(device, webPushPayloadOf(msg), env));
  } catch {
    return { kind: "transient", code: "sender_error" };
  }
}

/* ─────────────────────────────────────────── the existing push loops, shared ── */

export type LegacySubscription = { id: number; endpoint: string; p256dh: string; auth: string };

/**
 * The task reminder / booking reminder push: send the given web push payload to each subscription, then record one
 * PUSH delivery per attempt (SENT, or FAILED with `push_<status>`) and the subscription's success / failure (404 /
 * 410 revokes it) — exactly what both loops did inline before. Returns how many were accepted.
 */
export async function deliverLegacyPush(
  businessId: number,
  notificationId: number,
  subscriptions: readonly LegacySubscription[],
  payload: PushPayload,
  now: Date,
  deps: { webPush?: SenderDeps["webPush"] } = {},
): Promise<{ pushed: number; failed: number }> {
  const send = deps.webPush ?? sendWebPush;
  const results = await Promise.all(subscriptions.map(async (s) => ({ s, out: await send(s, payload) })));
  await tenantTx(businessId, async (tx) => {
    for (const { s, out } of results) {
      await tx.notificationDelivery.create({
        data: {
          businessId, notificationId, channel: "PUSH",
          status: out.ok ? "SENT" : "FAILED", attemptedAt: now, createdAt: now,
          error: out.ok ? null : `push_${out.status ?? "error"}`,
        },
      });
      await tx.pushSubscription.updateMany({
        where: { id: s.id, businessId },
        data: out.ok
          ? { lastSuccessAt: now, failureCount: 0 }
          : { lastFailureAt: now, failureCount: { increment: 1 }, ...(out.gone ? { revokedAt: now } : {}) },
      });
    }
  });
  const pushed = results.filter((r) => r.out.ok).length;
  return { pushed, failed: results.length - pushed };
}
