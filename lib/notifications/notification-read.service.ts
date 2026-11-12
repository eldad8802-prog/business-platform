/**
 * The read surface: what the owner sees, and what they have seen.
 *
 * Everything the notification API can ask of the database lives here, so the
 * list and the badge can never drift into two different ideas of "unread".
 * That is the whole reason this file exists rather than two routes each writing
 * their own `where`.
 *
 * THREE STATES THAT ARE NOT THE SAME THING
 *
 *   resolvedAt   — BUSINESS truth. The condition stopped being true. Written by
 *                  the inventory consumers, never by anything a person clicks.
 *   readAt       — CONSUMPTION state. The owner has seen it. Written only here.
 *   dismissedAt  — the owner asked not to see it. Written by nothing yet.
 *
 * Reading a notification must not resolve it, and a condition resolving itself
 * must not mark it read. Collapsing those would either hide problems the owner
 * never looked at, or nag about problems that no longer exist.
 *
 * NO WRITES OF BUSINESS MEANING
 *
 * Nothing here calls the policy, the writer or business-status, creates a
 * delivery row, or touches dedupeKey / lastNotifiedAt / cooldownHours. Marking
 * something read is a timestamp on a row the owner already owns; it cannot
 * change whether the underlying problem exists or when it may notify again.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";

import { rulesForCategory } from "./catalog";
import { effectiveSettings, hiddenInAppCategories } from "./preferences";
import { readUserPreferences } from "./preferences-store";

/**
 * WHO is reading (notification engine, migration 20261210090000). A notification with a userId is that user's
 * alone (a digest, a test push); NULL is the whole business's — every row written before the engine. Categories
 * the viewer switched off in-app (their own NotificationPreference rows) are hidden. With no viewer the old
 * business-wide predicate applies unchanged.
 */
export type Viewer = { userId: number };

type Where = Prisma.NotificationWhereInput;

/** The predicate a category's rows match (the catalog's declarative classification rules). */
function categoryWhere(key: string): Where[] {
  return rulesForCategory(key).map((r) => {
    const engineRule = r.semanticCategories?.length === 1 && r.semanticCategories[0] === key;
    return {
      domain: r.domain,
      ...(r.semanticCategories ? { semanticCategory: { in: [...r.semanticCategories] } } : {}),
      ...(r.severities ? { severity: { in: [...r.severities] } } : {}),
      ...(r.entityTypes ? { entityType: { in: [...r.entityTypes] } } : {}),
      // Legacy rows never carry a '.' in semanticCategory; the engine's always do.
      ...(engineRule ? {} : { NOT: { semanticCategory: { contains: "." } } }),
    };
  });
}

async function viewerWhere(tx: Prisma.TransactionClient, businessId: number, viewer: Viewer | undefined): Promise<Where[]> {
  if (!viewer) return [];
  const { settings, prefs } = await readUserPreferences(tx, businessId, viewer.userId);
  const hidden = hiddenInAppCategories(effectiveSettings(settings), prefs).flatMap(categoryWhere);
  return [
    { OR: [{ userId: null }, { userId: viewer.userId }] },
    ...(hidden.length > 0 ? [{ NOT: { OR: hidden } }] : []),
  ];
}

function withViewer(base: Where, extra: Where[]): Where {
  return extra.length === 0 ? base : { AND: [base, ...extra] };
}

/** Newest activity first. `id` breaks ties so paging is deterministic. */
const ORDER: Prisma.NotificationOrderByWithRelationInput[] = [
  { lastSurfacedAt: "desc" },
  { id: "desc" },
];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/**
 * Everything the owner may see. Dismissed notifications are excluded: the owner
 * asked for them to go away, and the writer brings them back on its own when
 * the fact becomes news again.
 *
 * Resolved notifications ARE included. A notification centre that forgets what
 * happened the moment it stops happening is a worse product than one that shows
 * "this was critical this morning and sorted itself out".
 */
function visible(businessId: number): Prisma.NotificationWhereInput {
  return { businessId, dismissedAt: null };
}

/**
 * What the badge counts: visible, never read, and STILL TRUE.
 *
 * Resolved-but-unread is deliberately excluded. A badge is a claim on the
 * owner's attention, and demanding attention for a problem that no longer
 * exists is how people learn to ignore badges. The item is still in the list,
 * marked resolved, if they want the history.
 *
 * This is a strict subset of `visible`, so every counted row is a row the list
 * would show. That is the consistency guarantee between the two endpoints.
 */
export function unreadWhere(businessId: number): Prisma.NotificationWhereInput {
  return { ...visible(businessId), readAt: null, resolvedAt: null };
}

/**
 * The fields the UI actually needs. Deliberately omitted: `dedupeKey` and
 * `reason` (internal identity and internal explanation), `cooldownHours` and
 * `lastNotifiedAt` (scheduling internals), `intendedChannels` and the delivery
 * rows (transport bookkeeping, not business truth), and `businessId` itself,
 * which the caller already is.
 */
const LIST_SELECT = {
  id: true,
  domain: true,
  semanticCategory: true,
  severity: true,
  entityType: true,
  entityId: true,
  title: true,
  summary: true,
  href: true,
  firstSurfacedAt: true,
  lastSurfacedAt: true,
  readAt: true,
  resolvedAt: true,
} satisfies Prisma.NotificationSelect;

export type NotificationListItem = Prisma.NotificationGetPayload<{ select: typeof LIST_SELECT }>;

export type NotificationListPage = {
  notifications: NotificationListItem[];
  unreadCount: number;
  nextCursor: number | null;
};

export function clampLimit(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/**
 * One page, plus the badge number in the same round trip — a phone opening the
 * notification centre should not need two requests to render its header.
 *
 * `unreadOnly` exists because the mobile centre has an obvious "only what needs
 * me" filter and it costs one extra clause. Every other filter was left out.
 */
export async function listNotifications(
  businessId: number,
  opts: { limit: number; cursor: number | null; unreadOnly: boolean; viewer?: Viewer },
): Promise<NotificationListPage> {
  // One tenant transaction, and therefore sequential: a transaction client is a
  // single connection, so these two cannot run concurrently on it.
  const { rows, unreadCount } = await tenantTx(businessId, async (tx) => {
    const extra = await viewerWhere(tx, businessId, opts.viewer);
    const where = withViewer(opts.unreadOnly ? unreadWhere(businessId) : visible(businessId), extra);
    return {
    rows: await tx.notification.findMany({
      where,
      select: LIST_SELECT,
      orderBy: ORDER,
      // One extra row is the cheapest way to know whether another page exists
      // without a second count over the same predicate.
      take: opts.limit + 1,
      ...(opts.cursor !== null ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    }),
    unreadCount: await tx.notification.count({ where: withViewer(unreadWhere(businessId), extra) }),
    };
  });

  const hasMore = rows.length > opts.limit;
  const notifications = hasMore ? rows.slice(0, opts.limit) : rows;

  return {
    notifications,
    unreadCount,
    nextCursor: hasMore ? notifications[notifications.length - 1]!.id : null,
  };
}

export async function countUnread(businessId: number, viewer?: Viewer): Promise<number> {
  return tenantTx(businessId, async (tx) =>
    tx.notification.count({ where: withViewer(unreadWhere(businessId), await viewerWhere(tx, businessId, viewer)) })
  );
}

export type MarkReadResult = { found: boolean; changed: boolean };

/**
 * Mark one notification read.
 *
 * `businessId` is in the predicate, not checked afterwards, so an id belonging
 * to another tenant updates nothing rather than something. `updateMany` rather
 * than `update` on purpose: `update` throws when its where-clause matches
 * nothing, which would turn a cross-tenant probe into an exception that reads
 * like a bug, and would also leak the difference between "not yours" and
 * "does not exist" through the error path.
 *
 * `readAt: null` in the predicate makes a repeat a no-op instead of moving the
 * timestamp forward, so repeated calls are idempotent in value and not just in
 * status code.
 */
export async function markNotificationRead(
  businessId: number,
  notificationId: number,
  now: Date,
  viewer?: Viewer,
): Promise<MarkReadResult> {
  return tenantTx(businessId, async (tx) => {
    // Another user's own notification is "not found" for this viewer, exactly like another tenant's.
    const mine: Where = viewer ? { OR: [{ userId: null }, { userId: viewer.userId }] } : {};
    const res = await tx.notification.updateMany({
      where: { id: notificationId, businessId, readAt: null, ...mine },
      data: { readAt: now, updatedAt: now },
    });

    if (res.count === 1) return { found: true, changed: true };

    // Nothing changed: either it was already read, or it is not this tenant's.
    // Only this path pays for the second query.
    const exists = await tx.notification.count({
      where: { id: notificationId, businessId, ...mine },
    });

    return { found: exists === 1, changed: false };
  });
}

/**
 * Mark everything the badge is currently counting as read.
 *
 * Uses `unreadWhere` verbatim, so "clear the badge" is exactly "read everything
 * the badge counted" — it cannot silently touch resolved history or a dismissed
 * item, and it cannot drift from the number the owner was looking at.
 */
export async function markAllNotificationsRead(
  businessId: number,
  now: Date,
  viewer?: Viewer,
): Promise<number> {
  const res = await tenantTx(businessId, async (tx) =>
    tx.notification.updateMany({
      where: withViewer(unreadWhere(businessId), await viewerWhere(tx, businessId, viewer)),
      data: { readAt: now, updatedAt: now },
    })
  );
  return res.count;
}
