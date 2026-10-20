/**
 * Daily Tasks — TaskAgendaService: the agenda the task centre and the secretary's "היום שלי" both show (Daily
 * Tasks spec 5.2, 7, 8.6–8.7). SERVER-ONLY.
 *
 * READ-ONLY by construction (8.6, T-C6): it reads the owner's tasks and series, the stored display state, the
 * preferences and the sync bookkeeping, runs the source adapters, and computes. It writes no row, no event and no
 * occurrence — a series that lacks its open occurrence is computed and returned as `pendingRepair`, and only
 * POST /api/tasks/sync stores it. A static test pins that this module imports no write path.
 */
import type { Task, TaskSeries } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { addCalendarDays, jerusalemDayKey, jerusalemDayUtcHalfOpen, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { buildAgenda, type Agenda, type ManualTask, type PendingRepair, type StoredState } from "./agenda-core";
import { cadenceLabel, dayKeyToDbDate, dbDateToDayKey, firstOccurrenceOnOrAfter, nextOccurrenceAfterClose, ruleOfSeries } from "./task-core";
import { runAllAdapters } from "./sources";

export type SeriesSummary = { id: number; title: string; cadence: string; paused: boolean; version: number };

export type AgendaResponse = Agenda & {
  generatedAt: string;
  lastSyncAt: string | null;
  lastSyncFailedAt: string | null;
  syncVersion: number;
  series: SeriesSummary[];
  disabledSources: string[];
};

type LinkNames = Map<string, string>;

async function linkLabels(tx: Parameters<Parameters<typeof tenantTx>[1]>[0], businessId: number, tasks: Task[]): Promise<LinkNames> {
  const ids = (k: keyof Task) => [...new Set(tasks.map((t) => t[k]).filter((x): x is number => typeof x === "number"))];
  const names: LinkNames = new Map();
  const c = ids("customerId"), s = ids("supplierId"), l = ids("leadId"), d = ids("documentId");
  if (c.length) for (const r of await tx.customer.findMany({ where: { businessId, id: { in: c } }, select: { id: true, name: true } })) names.set(`customer:${r.id}`, r.name);
  if (s.length) for (const r of await tx.supplier.findMany({ where: { businessId, id: { in: s } }, select: { id: true, name: true } })) names.set(`supplier:${r.id}`, r.name);
  if (l.length) for (const r of await tx.lead.findMany({ where: { businessId, id: { in: l } }, select: { id: true, customerName: true } })) names.set(`lead:${r.id}`, r.customerName ?? "ליד");
  if (d.length) for (const r of await tx.document.findMany({ where: { businessId, id: { in: d } }, select: { id: true } })) names.set(`document:${r.id}`, `מסמך ${r.id}`);
  return names;
}

export function linkOf(t: Pick<Task, "customerId" | "supplierId" | "leadId" | "documentId">, names: LinkNames): ManualTask["link"] {
  if (t.customerId) return { kind: "customer", id: t.customerId, label: names.get(`customer:${t.customerId}`) ?? null };
  if (t.supplierId) return { kind: "supplier", id: t.supplierId, label: names.get(`supplier:${t.supplierId}`) ?? null };
  if (t.leadId) return { kind: "lead", id: t.leadId, label: names.get(`lead:${t.leadId}`) ?? null };
  if (t.documentId) return { kind: "document", id: t.documentId, label: names.get(`document:${t.documentId}`) ?? null };
  return null;
}

export function toManualTask(t: Task, seriesById: Map<number, TaskSeries>, names: LinkNames): ManualTask {
  const s = t.seriesId ? seriesById.get(t.seriesId) : undefined;
  return {
    id: t.id,
    title: t.title,
    note: t.description,
    dueOn: t.dueOn ? dbDateToDayKey(t.dueOn) : null,
    pinned: !!t.pinnedAt,
    version: t.version,
    seriesId: t.seriesId,
    sequence: t.sequence,
    cadence: s ? cadenceLabel(ruleOfSeries(s)) : null,
    link: linkOf(t, names),
    createdAt: t.createdAt.toISOString(),
  };
}

/** The occurrence an active series without an open one should have, computed from its rule (8.7). */
export function expectedOccurrence(series: TaskSeries, lastClosedDueOn: JerusalemDayKey | null, today: JerusalemDayKey): JerusalemDayKey {
  const rule = ruleOfSeries(series);
  const startOn = dbDateToDayKey(series.startOn);
  return lastClosedDueOn ? nextOccurrenceAfterClose(rule, startOn, lastClosedDueOn, today) : firstOccurrenceOnOrAfter(rule, startOn, today);
}

export async function getAgenda(businessId: number, now: Date = new Date()): Promise<AgendaResponse> {
  const today = jerusalemDayKey(now);
  const horizon = dayKeyToDbDate(addCalendarDays(today, 7));
  const { from, toExclusive } = jerusalemDayUtcHalfOpen(today);

  const stored = await tenantTx(businessId, async (tx) => {
    const tasks = await tx.task.findMany({
      where: { businessId, status: "OPEN", OR: [{ dueOn: null }, { dueOn: { lte: horizon } }] },
      orderBy: [{ dueOn: "asc" }, { id: "asc" }],
      take: 500,
    });
    const series = await tx.taskSeries.findMany({ where: { businessId, endedAt: null }, orderBy: { id: "asc" } });
    const openBySeries = new Set(
      (await tx.task.findMany({ where: { businessId, status: "OPEN", seriesId: { not: null } }, select: { seriesId: true } })).map((r) => r.seriesId),
    );
    const lastClosed = await tx.task.findMany({
      where: { businessId, seriesId: { in: series.map((s) => s.id) }, status: { not: "OPEN" } },
      orderBy: [{ sequence: "desc" }], select: { seriesId: true, dueOn: true },
    });
    const states = await tx.taskSourceState.findMany({ where: { businessId, closedObservedAt: null } });
    const prefs = await tx.taskPreferences.findUnique({ where: { businessId } });
    const doneToday = await tx.taskEvent.count({
      where: { businessId, actor: "OWNER_USER", eventType: { in: ["TASK_COMPLETED", "SOURCE_ITEM_ACKNOWLEDGED"] }, occurredAt: { gte: from, lt: toExclusive } },
    });
    const names = await linkLabels(tx, businessId, tasks);
    return { tasks, series, openBySeries, lastClosed, states, prefs, doneToday, names };
  });

  const seriesById = new Map(stored.series.map((s) => [s.id, s]));
  const lastClosedBySeries = new Map<number, JerusalemDayKey | null>();
  for (const r of stored.lastClosed) if (r.seriesId && !lastClosedBySeries.has(r.seriesId)) lastClosedBySeries.set(r.seriesId, r.dueOn ? dbDateToDayKey(r.dueOn) : null);
  const repairs: PendingRepair[] = stored.series
    .filter((s) => !s.pausedAt && !stored.openBySeries.has(s.id))
    .map((s) => ({ seriesId: s.id, title: s.title, dueOn: expectedOccurrence(s, lastClosedBySeries.get(s.id) ?? null, today), cadence: cadenceLabel(ruleOfSeries(s)) }));

  const disabled = new Set(stored.prefs?.disabledSources ?? []);
  const results = await runAllAdapters({ businessId, now, today }, disabled);
  const states: StoredState[] = stored.states.map((s) => ({
    dedupeKey: s.dedupeKey, cycleKey: s.cycleKey, evidenceVersion: s.evidenceVersion,
    acknowledgedOn: s.acknowledgedOn ? dbDateToDayKey(s.acknowledgedOn) : null, ackEvidenceVersion: s.ackEvidenceVersion,
    snoozedUntil: s.snoozedUntil?.toISOString() ?? null, pinnedAt: s.pinnedAt?.toISOString() ?? null, dismissedAt: s.dismissedAt?.toISOString() ?? null,
  }));
  const syncFailed = !!stored.prefs?.lastSyncFailedAt && (!stored.prefs.lastSyncAt || stored.prefs.lastSyncFailedAt > stored.prefs.lastSyncAt);

  const agenda = buildAgenda({
    today, now, repairs, results, states, doneToday: stored.doneToday, syncFailed,
    tasks: stored.tasks.map((t) => toManualTask(t, seriesById, stored.names)),
  });
  return {
    ...agenda,
    generatedAt: now.toISOString(),
    lastSyncAt: stored.prefs?.lastSyncAt?.toISOString() ?? null,
    lastSyncFailedAt: stored.prefs?.lastSyncFailedAt?.toISOString() ?? null,
    syncVersion: stored.prefs?.syncVersion ?? 0,
    series: stored.series.map((s) => ({ id: s.id, title: s.title, cadence: cadenceLabel(ruleOfSeries(s)), paused: !!s.pausedAt, version: s.version })),
    disabledSources: [...disabled],
  };
}
