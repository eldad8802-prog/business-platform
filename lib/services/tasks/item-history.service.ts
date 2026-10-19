/**
 * Daily Tasks — the handling history of ONE business item (details panel; spec 8.5, 11.1). SERVER-ONLY, read-only.
 *
 * Built only from what the task layer already records, per cycle of the item:
 *   - each cycle: when it first appeared and when it was observed closed (TaskSourceState);
 *   - the owner's display actions on it (handled for today, remind me, important) and the SYSTEM closure, from
 *     the journal by the item's key.
 * Actions routed to the domain (a lead's follow-up, a payment marked handled) are the domain's own record and are
 * not journaled twice (11.1); the panel shows their current facts from the item itself. No names, no amounts.
 */
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { SOURCE_KINDS, type SourceKind } from "./agenda-core";

export type ItemHistoryEntry = { kind: string; at: string; actor: "OWNER_USER" | "SYSTEM"; until?: string | null };

const OWNER_EVENTS = ["SOURCE_ITEM_ACKNOWLEDGED", "SOURCE_ITEM_SNOOZED", "SOURCE_ITEM_PINNED", "SOURCE_ITEM_UNPINNED", "SOURCE_CLOSED_OBSERVED"] as const;
const HISTORY_MAX = 12;

/** A well-formed reference to a source item — checked before any read (the route answers 400 otherwise). */
export function isItemRef(sourceKind: string, dedupeKey: string): boolean {
  return SOURCE_KINDS.includes(sourceKind as SourceKind) && /^[A-Za-z0-9:_.-]{1,200}$/.test(dedupeKey);
}

/** Null for a malformed reference; otherwise the entries, newest first. */
export async function getItemHistory(businessId: number, sourceKind: string, dedupeKey: string): Promise<ItemHistoryEntry[] | null> {
  if (!isItemRef(sourceKind, dedupeKey)) return null;
  return tenantTx(businessId, async (tx) => {
    const cycles = await tx.taskSourceState.findMany({
      where: { businessId, sourceKind, dedupeKey },
      orderBy: { firstSeenAt: "desc" },
      take: HISTORY_MAX,
      select: { firstSeenAt: true },
    });
    const events = await tx.taskEvent.findMany({
      where: { businessId, sourceKind, dedupeKey, eventType: { in: [...OWNER_EVENTS] } },
      orderBy: { id: "desc" },
      take: HISTORY_MAX,
      select: { eventType: true, actor: true, occurredAt: true, payload: true },
    });
    const entries: ItemHistoryEntry[] = [
      ...cycles.map((c) => ({ kind: "APPEARED", at: c.firstSeenAt.toISOString(), actor: "SYSTEM" as const })),
      ...events.map((e) => {
        const p = (e.payload ?? {}) as Record<string, unknown>;
        return {
          kind: e.eventType,
          at: e.occurredAt.toISOString(),
          actor: e.actor === "SYSTEM" ? ("SYSTEM" as const) : ("OWNER_USER" as const),
          ...(typeof p.until === "string" ? { until: p.until } : {}),
        };
      }),
    ];
    return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, HISTORY_MAX);
  });
}
