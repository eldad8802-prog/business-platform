/**
 * Producer: `connections.disconnected` — a connected account stopped working on the provider's side
 * (notifications track PR 5). SERVER-ONLY.
 *
 *   gmail     Google refused the stored refresh token with `invalid_grant` (revoked / expired). Detected in ONE
 *             place: lib/services/integrations/gmail/oauth-refresh.service.ts. Entity = the EmailConnection.
 *   whatsapp  Meta refused the business's token (401/403/190) and markRevokedByMeta flipped the row to
 *             REVOKED_BY_META. One WhatsApp connection per business, so the entity id is the business id.
 *
 * Resolved when the connection is restored: the Gmail OAuth callback (re)connecting that account, and a WhatsApp
 * (re)connect (manualSeedConnection, which Embedded Signup delegates to).
 *
 * Strictly a SIDE EFFECT. The domain call sites only SCHEDULE work with Next's `after()` — it runs once the
 * response is finished, so the domain's return value, its error, its timing and its transaction are untouched.
 * Inside the scheduled work:
 *   1. the engine gate (notifications_engine; fail closed) — OFF ⇒ nothing at all, not even a read of
 *      Notification;
 *   2. notify() in its own tenant transaction — dedupe per connection (`conn:<provider>:<id>`), the catalog's
 *      24 h cooldown (a reconnect loop that fails again within a day writes nothing new);
 *   3. when notify() owed a push: the after-response worker kick (trigger.ts) for this business only.
 * Every failure is swallowed (a log line with an error CLASS only). Outside a request scope `after()` throws and
 * nothing is scheduled — every real caller is a route handler.
 *
 * The stored title / summary are generic (no address, no phone number, no account name), and the push the worker
 * builds uses the catalog's lock-screen text anyway.
 */
import { after } from "next/server";

import type { CategoryKey } from "../catalog";
import { notificationsEngineEnabled } from "../engine/engine-gate";
import { notify, type NotifyEvent, type NotifyOutcome } from "../engine/notify";
import { kickPushWorkerAfterResponse } from "../engine/trigger";
import { tenantTx, type TenantTxClient } from "@/lib/tenant/tenant-tx";

export type ConnectionProvider = "gmail" | "whatsapp";

export type ConnectionRef = {
  businessId: number;
  provider: ConnectionProvider;
  /** gmail: EmailConnection.id; whatsapp: the business id (one connection per business). */
  connectionId: number;
};

export const CONNECTION_CATEGORY: CategoryKey = "connections.disconnected";
export const CONNECTIONS_HREF = "/settings/connections";

const ENTITY_TYPE: Record<ConnectionProvider, string> = {
  gmail: "gmail_connection",
  whatsapp: "whatsapp_connection",
};

const TEXT: Record<ConnectionProvider, { title: string; summary: string }> = {
  gmail: { title: "החיבור ל-Gmail התנתק", summary: "צריך לחבר מחדש את חשבון Gmail כדי להמשיך לייבא מסמכים." },
  whatsapp: { title: "החיבור ל-WhatsApp התנתק", summary: "צריך לחבר מחדש את WhatsApp כדי להמשיך לשלוח ולקבל הודעות." },
};

function validRef(ref: ConnectionRef): boolean {
  return (
    Number.isInteger(ref.businessId) && ref.businessId > 0 &&
    Number.isInteger(ref.connectionId) && ref.connectionId > 0 &&
    (ref.provider === "gmail" || ref.provider === "whatsapp")
  );
}

/** The fact's identity: one notification per connection. */
export function connectionDedupeKey(ref: Pick<ConnectionRef, "provider" | "connectionId">): string {
  return `conn:${ref.provider}:${ref.connectionId}`;
}

/** The notify() event for a disconnected connection (pure). */
export function connectionDisconnectedEvent(ref: ConnectionRef, now: Date): NotifyEvent {
  return {
    businessId: ref.businessId,
    category: CONNECTION_CATEGORY,
    entity: { type: ENTITY_TYPE[ref.provider], id: ref.connectionId },
    dedupeKey: connectionDedupeKey(ref),
    title: TEXT[ref.provider].title,
    summary: TEXT[ref.provider].summary,
    href: CONNECTIONS_HREF,
    userId: null,
    reason: `${ref.provider}_token_revoked`,
    now,
  };
}

/* ───────────────────────────────────────────────────── the scheduled work ── */

export type ProducerDeps = {
  engineOn: (businessId: number) => Promise<boolean>;
  tenantTx: <T>(businessId: number, fn: (tx: TenantTxClient) => Promise<T>) => Promise<T>;
  notify: (tx: TenantTxClient, event: NotifyEvent) => Promise<NotifyOutcome>;
  kick: (businessId: number) => void;
};

const REAL_DEPS: ProducerDeps = {
  engineOn: notificationsEngineEnabled,
  tenantTx: (businessId, fn) => tenantTx(businessId, fn),
  notify,
  kick: kickPushWorkerAfterResponse,
};

export type ProducerOutcome = "invalid" | "engine_off" | "notified" | "cooldown" | "resolved" | "nothing_open" | "error";

function logFailure(what: string, e: unknown): void {
  console.warn("[notifications] producer failed", JSON.stringify({ what, error: e instanceof Error ? e.name : "unknown" }));
}

/** Record a disconnected connection (gated, deduped, cooldown) and kick the worker when a push is owed. Never throws. */
export async function recordConnectionDisconnected(ref: ConnectionRef, now: Date, deps: ProducerDeps = REAL_DEPS): Promise<ProducerOutcome> {
  if (!validRef(ref)) return "invalid";
  try {
    if (!(await deps.engineOn(ref.businessId))) return "engine_off";
    const out = await deps.tenantTx(ref.businessId, (tx) => deps.notify(tx, connectionDisconnectedEvent(ref, now)));
    if (!out.notified) return "cooldown";
    if (out.owedDeliveryId !== null) deps.kick(ref.businessId);
    return "notified";
  } catch (e) {
    logFailure("connections.disconnected", e);
    return "error";
  }
}

/** The connection works again: close its open notification (gated). Never throws. */
export async function resolveConnectionDisconnected(ref: ConnectionRef, now: Date, deps: ProducerDeps = REAL_DEPS): Promise<ProducerOutcome> {
  if (!validRef(ref)) return "invalid";
  try {
    if (!(await deps.engineOn(ref.businessId))) return "engine_off";
    const count = await deps.tenantTx(ref.businessId, async (tx) => {
      const res = await tx.notification.updateMany({
        where: { businessId: ref.businessId, dedupeKey: connectionDedupeKey(ref), resolvedAt: null },
        data: { resolvedAt: now, updatedAt: now },
      });
      return res.count;
    });
    return count > 0 ? "resolved" : "nothing_open";
  } catch (e) {
    logFailure("connections.restored", e);
    return "error";
  }
}

/* ─────────────────────────────────────────────── what the call sites use ── */

export type Scheduler = (task: () => Promise<unknown>) => void;

/** `after()` or nothing: outside a request scope there is no response to wait for, and the domain must not wait. */
const afterResponse: Scheduler = (task) => {
  try {
    after(async () => {
      await task();
    });
  } catch {
    /* not inside a request: nothing is scheduled */
  }
};

/**
 * Called by the domain right after its own work. Returns synchronously and never throws; the work runs after the
 * response. `now` is taken at detection time.
 */
export function scheduleConnectionDisconnected(ref: ConnectionRef, schedule: Scheduler = afterResponse): void {
  try {
    if (!validRef(ref)) return;
    const now = new Date();
    schedule(() => recordConnectionDisconnected(ref, now));
  } catch {
    /* never affects the domain */
  }
}

/** Called by the domain right after a (re)connect committed. Same contract as scheduleConnectionDisconnected. */
export function scheduleConnectionRestored(ref: ConnectionRef, schedule: Scheduler = afterResponse): void {
  try {
    if (!validRef(ref)) return;
    const now = new Date();
    schedule(() => resolveConnectionDisconnected(ref, now));
  } catch {
    /* never affects the domain */
  }
}
