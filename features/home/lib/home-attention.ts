/**
 * The Secretary's objects on Home — what needs the owner, as THINGS.
 *
 * THE DEFECT THIS FIXES: Home used to send every attention object to
 * `/attention`, the business-status exception list. An obligation is not in
 * that list — it lives with the Secretary — so the loudest thing on the screen
 * could open a page that did not contain it. Here every object carries the
 * href of its OWN owner:
 *
 *   obligation → /secretary?screen=detail&id=…   (the Secretary owns it)
 *   document   → the document review queue       (from business-status)
 *   lead       → that lead                       (from business-status)
 *   inventory  → that item                       (from business-status)
 *
 * Business-status items already know where they belong — `primaryAction.href`
 * is written by the loader that found the exception — so the fix is to USE it
 * rather than to overwrite it with a single generic destination.
 *
 * ORDER: obligations first, because a date that has arrived is the only thing
 * here that gets worse by itself; then exceptions by the priority the status
 * engine assigned them. The first object is the one the screen makes primary.
 */

import {
  buildTodayRows,
  DUE_BADGE_LABEL,
  formatAmount,
  type DueBadge,
} from "@/features/home/lib/home-model";
import type { BusinessStatusItem } from "@/lib/business-status/types";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import { obligationHref } from "@/lib/navigation/home-routes";

export type AttentionKind = "obligation" | "document" | "lead" | "inventory" | "other";

export type AttentionObject = {
  key: string;
  kind: AttentionKind;
  /** The drawn Dubiz entity, and therefore the semantic colour. */
  entity: string;
  /** What kind of thing this is, in a word. */
  kindWord: string;
  title: string;
  meta: string;
  /** Already formatted, or null when this kind of object has no amount. */
  amount: string | null;
  chip: { label: string; urgent: boolean } | null;
  /** The TRUE owner of this object. Never a generic destination. */
  href: string;
};

const KIND_OF_DOMAIN: Record<string, AttentionKind> = {
  documents: "document",
  billing: "document",
  leads: "lead",
  inbox: "lead",
  inventory: "inventory",
  supplier: "inventory",
};

const ENTITY_OF_KIND: Record<AttentionKind, { entity: string; word: string }> = {
  obligation: { entity: "payables", word: "לתשלום" },
  document: { entity: "documents", word: "מסמך" },
  lead: { entity: "leads", word: "ליד" },
  inventory: { entity: "inventory", word: "מלאי" },
  other: { entity: "documents", word: "לטיפול" },
};

/** Urgent is a STATE — it colours a chip, never the object's own identity. */
function isUrgentBadge(badge: DueBadge): boolean {
  return badge === "late" || badge === "today";
}

export function buildAttentionObjects(
  briefing: BriefingApi | null,
  statusItems: BusinessStatusItem[] | null,
  now: Date
): AttentionObject[] | null {
  // Both sources must have answered. One of them still loading is not an empty
  // day, and neither is one of them failing.
  if (!briefing || !statusItems) return null;

  const objects: AttentionObject[] = [];

  for (const row of buildTodayRows(briefing, now)) {
    const kind = ENTITY_OF_KIND.obligation;
    objects.push({
      key: `obligation-${row.obligationId}`,
      kind: "obligation",
      entity: kind.entity,
      kindWord: kind.word,
      title: row.title,
      meta: "תשלום שהעסק צריך לשלם",
      amount: formatAmount(row.amount, row.currency),
      chip: { label: DUE_BADGE_LABEL[row.badge], urgent: isUrgentBadge(row.badge) },
      href: obligationHref(row.obligationId),
    });
  }

  const byPriority = [...statusItems].sort((a, b) => b.priorityScore - a.priorityScore);
  for (const item of byPriority) {
    const kind = KIND_OF_DOMAIN[item.domain] ?? "other";
    const shape = ENTITY_OF_KIND[kind];
    const urgent = item.severity === "CRITICAL" || item.severity === "HIGH";
    objects.push({
      key: `status-${item.itemId}`,
      kind,
      entity: shape.entity,
      kindWord: shape.word,
      title: item.title,
      meta: item.summary ?? "",
      amount: null,
      chip: { label: urgent ? "דורש טיפול" : "לבדיקה", urgent },
      // The exception knows its own destination. Home does not override it.
      href: item.primaryAction.href,
    });
  }

  return objects;
}

/** How many obligations the Secretary is watching but that are not due yet. */
export function watchingCount(briefing: BriefingApi | null): number {
  return briefing?.counts.watching ?? 0;
}
