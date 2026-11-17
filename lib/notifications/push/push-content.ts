/**
 * What a push may SAY (notifications track spec, 2026-11-12). Pure.
 *
 * Default: lock-screen safe — the generic title ("דוביז") and the category's generic body; no customer name, no
 * amount, no document number, whatever the stored notification says. Only when the user turned lockScreenDetails
 * ON are the stored title / summary used (bounded). Categories whose stored text the engine writes from counts only
 * (the daily digest, the test push) may show it always.
 *
 * The deep link is the stored href only if it is an internal path under the category's allowed prefixes;
 * otherwise the category's first prefix. The device re-validates, and the page enforces auth / tenant on load.
 */
import { collapseKeyOf, safeHref, type CategoryDefinition } from "../catalog";

import type { PushMessage } from "./push-types";

export type StoredNotificationText = {
  id: number;
  title: string;
  summary: string | null;
  href: string;
  entityType: string;
  entityId: number;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildPushMessage(
  cat: CategoryDefinition,
  n: StoredNotificationText,
  opts: { lockScreenDetails: boolean; ttlSeconds: number },
): PushMessage {
  let title = cat.lockScreen.title;
  let body = cat.lockScreen.body;
  if (cat.storedTextLockScreenSafe) {
    if (n.summary && n.summary.trim()) body = clip(n.summary.trim(), 160);
  } else if (opts.lockScreenDetails) {
    if (n.title.trim()) title = clip(n.title.trim(), 80);
    if (n.summary && n.summary.trim()) body = clip(n.summary.trim(), 160);
  }
  return {
    notificationId: n.id,
    category: cat.key,
    importance: cat.importance,
    title,
    body,
    href: safeHref(n.href, cat.hrefPrefixes) ?? cat.hrefPrefixes[0],
    collapseKey: collapseKeyOf(cat, { type: n.entityType, id: n.entityId }),
    ttlSeconds: Math.max(0, Math.floor(opts.ttlSeconds)),
  };
}
