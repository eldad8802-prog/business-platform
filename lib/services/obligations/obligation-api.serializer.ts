/**
 * API serializers for the obligations domain. Dates -> ISO strings; the amount
 * is already a string. The store never exposes another tenant's data, so these
 * shapes are safe to return directly.
 */

import type {
  Briefing,
  BriefingItem,
  ObligationRecord,
  OrientationRecord,
} from "./obligations.types";

export function toObligationApi(o: ObligationRecord) {
  return {
    id: o.id,
    obligeeName: o.obligeeName,
    amount: o.amount,
    currency: o.currency,
    dueAt: o.dueAt.toISOString(),
    state: o.state,
    source: o.source,
    recurrence: o.recurrence,
    recurrenceSeriesId: o.recurrenceSeriesId,
    note: o.note,
    followUpAt: o.followUpAt ? o.followUpAt.toISOString() : null,
    settlementAssertedBy: o.settlementAssertedBy,
    metAt: o.metAt ? o.metAt.toISOString() : null,
    releasedAt: o.releasedAt ? o.releasedAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

function toBriefingItemApi(item: BriefingItem) {
  return {
    obligation: toObligationApi(item.obligation),
    reason: item.reason,
  };
}

export function toBriefingApi(b: Briefing) {
  return {
    state: b.state,
    oriented: b.oriented,
    attention: b.attention.map(toBriefingItemApi),
    watching: b.watching.map(toObligationApi),
    counts: b.counts,
    generatedAt: b.generatedAt,
  };
}

export function toOrientationApi(o: OrientationRecord) {
  return {
    businessId: o.businessId,
    oriented: o.oriented,
    orientedAt: o.orientedAt ? o.orientedAt.toISOString() : null,
  };
}
