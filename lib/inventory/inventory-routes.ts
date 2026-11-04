/**
 * The manual "mark handled" endpoint for one inventory alert.
 *
 * The handler lives at app/(shell)/inventory/alerts/[id]/resolve/route.ts. The
 * `(shell)` route group is not part of the URL, so it is served at
 * /inventory/alerts/:id/resolve — NOT under /api. The client used to call
 * /api/inventory/alerts/:id/resolve, which has no handler, so every "טופל"
 * failed (audit 2026-11-03, ב5). inventory-routes.test.ts pins this path to the
 * handler file so the two cannot drift apart again.
 */
export function inventoryAlertResolvePath(alertId: number): string {
  return `/inventory/alerts/${alertId}/resolve`;
}
