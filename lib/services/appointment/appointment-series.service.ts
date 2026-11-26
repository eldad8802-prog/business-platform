/**
 * Recurring appointments (G5) — the owner's weekly / bi-weekly series. SERVER-ONLY.
 *
 * Builds on appointment-schedule.service and never bypasses it: every write runs inside ownerWrite (the per-business
 * advisory lock, the Idempotency-Key ledger, the journal), occupancy is checked with the same lane rule
 * (laneOccupants: the business's lane and the staff lanes exclude each other both ways), and the database's
 * Appointment_no_overlap is the last word — an occurrence it refuses is rolled back to its own SAVEPOINT and reported,
 * never forced and never failing the rest.
 *
 *   create   the series row and ALL its occurrences at once (a series is bounded: ≤ 104 occurrences, ≤ 730 days —
 *            owner decision: no open-ended series), each a normal timed appointment with (seriesId, seriesIndex).
 *            An occurrence whose time is taken, or whose day is closed for its lane, is SKIPPED and reported (its
 *            index stays unused). Nothing bookable at all ⇒ SLOT_CONFLICT and nothing is written.
 *            Journal: APPOINTMENT_CREATED per occurrence, SERIES_CREATED (the request's ledger entry) on the first.
 *   preview  the same plan, read-only, so the form shows the taken / closed days BEFORE saving.
 *   change   "רק התור הזה" (scope one) or "התור הזה והבאים" (scope following): cancel, or move. Following-moves keep
 *            each occurrence's weekly place, shifted by the same days and set to the new time; occurrences that would
 *            land on taken time or a closed day keep their old time and are reported. A move of the following part of
 *            a series that has earlier occurrences SPLITS it: the earlier part ends the day before, the following part
 *            becomes a new series (its occurrences re-pointed and re-indexed from 0). The series version goes up on
 *            every change; journal SERIES_CHANGED (the ledger entry) on the occurrence the owner acted on.
 * Per-occurrence edits through the existing routes (reschedule, status, details) keep working unchanged.
 */
import type { Appointment, AppointmentCancelReason, AppointmentKind, AppointmentLocationKind, AppointmentSeries, Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { recordOfferingDemand } from "@/lib/services/offering/offering-demand";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { addCalendarDays, daysBetweenDayKeys, jerusalemClock, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { isTerminal } from "./appointment.lifecycle";
import { sensorWho, transitionWithinTx } from "./appointment.service";
import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError, invalid } from "./appointment-errors";
import { appendAppointmentEvent, instantToken } from "./appointment-journal";
import { isOverlapViolation, lockBusinessAppointments, ownerWrite, type OwnerRequest, type WriteContext } from "./appointment-request";
import {
  activeService,
  activeStaff,
  bufferPolicy,
  laneAvailability,
  laneOccupants,
  loadOwn,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  outsideAvailability,
  ownerActor,
  parseInstant,
  staffServiceDuration,
} from "./appointment-schedule.service";
import {
  endBefore,
  parseSeriesEnd,
  planOccurrences,
  SERIES_FREQUENCIES,
  seriesWeekday,
  type PlannedOccurrence,
  type SeriesEnd,
  type SeriesFrequency,
  type SkippedOccurrence,
} from "./appointment-series.core";
import { instantOf, occupiedRange, overlaps, windowsForDay, type DayException, type WeeklyRule } from "./availability.core";

type Tx = Prisma.TransactionClient;
const MINUTE = 60_000;
const ACTIVE: Appointment["status"][] = ["PROPOSED", "CONFIRMED"];
const KINDS: AppointmentKind[] = ["CUSTOMER", "INTERNAL", "BLOCK"];
const LOCATIONS: AppointmentLocationKind[] = ["IN_PERSON", "PHONE", "ONLINE"];
const OWNER_CANCEL_REASONS: AppointmentCancelReason[] = ["OWNER_CANCELED", "CUSTOMER_CANCELED", "OTHER"];
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const dayDate = (key: JerusalemDayKey) => new Date(`${key}T00:00:00.000Z`);
const dayKeyOfDate = (d: Date) => d.toISOString().slice(0, 10);

function optionalId(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!isPositiveInt(value)) throw invalid(field);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw invalid(field);
  return value.trim() || null;
}

const minuteOf = (instant: Date): number => {
  const c = jerusalemClock(instant);
  return c.hours * 60 + c.minutes;
};

// ── The request ─────────────────────────────────────────────────────────────────────────────────

export type SeriesRequestInput = {
  kind?: unknown;
  status?: unknown;
  startsAt?: unknown;
  durationMinutes?: unknown;
  staffMemberId?: unknown;
  businessServiceId?: unknown;
  customerId?: unknown;
  leadId?: unknown;
  title?: unknown;
  notes?: unknown;
  locationKind?: unknown;
  locationDetail?: unknown;
  frequency?: unknown;
  occurrenceCount?: unknown;
  endsOn?: unknown;
};

export type ParsedSeries = {
  kind: AppointmentKind;
  status: "CONFIRMED" | "PROPOSED";
  startsAt: Date;
  startsOn: JerusalemDayKey;
  startMinute: number;
  durationIn: number | null;
  staffMemberId: number | null;
  businessServiceId: number | null;
  customerId: number | null;
  leadId: number | null;
  title: string | null;
  notes: string | null;
  locationKind: AppointmentLocationKind | null;
  locationDetail: string | null;
  frequency: SeriesFrequency;
  end: SeriesEnd;
};

/** Parses and bounds a series request (shared by preview and create, and by the tests). */
export function parseSeriesRequest(input: SeriesRequestInput): ParsedSeries {
  const kind = (input.kind ?? "CUSTOMER") as AppointmentKind;
  if (!KINDS.includes(kind)) throw invalid("kind");
  const status = (input.status ?? "CONFIRMED") as "CONFIRMED" | "PROPOSED";
  if (status !== "CONFIRMED" && status !== "PROPOSED") throw invalid("status");
  if (kind === "BLOCK" && status !== "CONFIRMED") throw invalid("status");
  const startsAt = parseInstant(input.startsAt, "startsAt");
  if (startsAt.getTime() % MINUTE !== 0) throw invalid("startsAt");
  const durationIn = input.durationMinutes === undefined || input.durationMinutes === null ? null : input.durationMinutes;
  if (durationIn !== null && (!isPositiveInt(durationIn) || durationIn < MIN_DURATION_MINUTES || durationIn > MAX_DURATION_MINUTES)) throw invalid("durationMinutes");
  const frequency = input.frequency as SeriesFrequency;
  if (!SERIES_FREQUENCIES.includes(frequency)) throw invalid("frequency");
  const startsOn = jerusalemDayKey(startsAt);
  const end = parseSeriesEnd(startsOn, input.occurrenceCount, input.endsOn);
  const staffMemberId = optionalId(input.staffMemberId, "staffMemberId");
  const businessServiceId = optionalId(input.businessServiceId, "businessServiceId");
  const customerId = optionalId(input.customerId, "customerId");
  const leadId = optionalId(input.leadId, "leadId");
  if (kind !== "CUSTOMER" && (customerId !== null || leadId !== null || businessServiceId !== null)) throw invalid("kind");
  const locationKind = input.locationKind === undefined || input.locationKind === null ? null : (input.locationKind as AppointmentLocationKind);
  if (locationKind !== null && !LOCATIONS.includes(locationKind)) throw invalid("locationKind");
  return {
    kind, status, startsAt, startsOn, startMinute: minuteOf(startsAt), durationIn, staffMemberId, businessServiceId, customerId, leadId,
    title: optionalText(input.title, "title", 200), notes: optionalText(input.notes, "notes", 4000),
    locationKind, locationDetail: optionalText(input.locationDetail, "locationDetail", 300), frequency, end,
  };
}

/** The canonical body the request digest is computed over (dates as ISO strings). */
function digestBody(p: ParsedSeries) {
  return { ...p, startsAt: p.startsAt.toISOString(), end: p.end.occurrenceCount ?? p.end.endsOn };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

export type PlannedVerdict = PlannedOccurrence & { ok: boolean; reason?: "CONFLICT" | "CLOSED"; conflictingAppointmentIds?: number[]; outside: boolean };
export type SeriesPlan = {
  durationMinutes: number;
  service: { id: number; name: string } | null;
  buffers: { bufferBeforeMinutes: number; bufferAfterMinutes: number };
  occurrences: PlannedVerdict[];
};

type LaneHours = { rules: WeeklyRule[]; exceptions: DayException[]; hasRules: boolean };

/** Closed = the lane has hours (or an exception that day) and no open window on the day. No hours at all ⇒ never. */
function closedOn(day: JerusalemDayKey, hours: LaneHours): boolean {
  const todays = hours.exceptions.filter((e) => e.dayKey === day);
  if (!hours.hasRules && todays.length === 0) return false;
  return windowsForDay(day, hours.rules, hours.exceptions).length === 0;
}

function outsideOn(o: { dayKey: JerusalemDayKey; startsAt: Date; endsAt: Date }, hours: LaneHours): boolean {
  if (!hours.hasRules && !hours.exceptions.some((e) => e.dayKey === o.dayKey)) return false;
  const windows = windowsForDay(o.dayKey, hours.rules, hours.exceptions);
  return !windows.some((w) => instantOf(o.dayKey, w.startMinute).getTime() <= o.startsAt.getTime() && o.endsAt.getTime() <= instantOf(o.dayKey, w.endMinute).getTime());
}

async function planWithinTx(tx: Tx, businessId: number, p: ParsedSeries): Promise<SeriesPlan> {
  if (p.staffMemberId !== null) await activeStaff(tx, businessId, p.staffMemberId);
  const service = p.businessServiceId !== null ? await activeService(tx, businessId, p.businessServiceId) : null;
  const staffDuration = service ? await staffServiceDuration(tx, businessId, service.id, p.staffMemberId) : null;
  if (p.customerId !== null && !(await tx.customer.findFirst({ where: { id: p.customerId, businessId }, select: { id: true } }))) {
    throw new AppointmentServiceError("CUSTOMER_NOT_FOUND");
  }
  if (p.leadId !== null && !(await tx.lead.findFirst({ where: { id: p.leadId, businessId }, select: { id: true } }))) {
    throw new AppointmentServiceError("LEAD_NOT_FOUND");
  }
  const durationMinutes = p.durationIn ?? staffDuration ?? service?.durationMinutes ?? null;
  if (durationMinutes === null || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) throw invalid("durationMinutes");
  const buffers = p.kind === "CUSTOMER" ? await bufferPolicy(tx, businessId, service?.id ?? null) : { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };

  const planned = planOccurrences({ frequency: p.frequency, startsOn: p.startsOn, startMinute: p.startMinute, durationMinutes, end: p.end });
  const first = planned[0];
  const last = planned[planned.length - 1];
  const hours = await laneAvailability(tx, businessId, p.staffMemberId, first.dayKey, last.dayKey);
  const occupants = await laneOccupants(tx, businessId, p.staffMemberId, { start: first.startsAt, end: last.endsAt });
  const busy = occupants.map((o) => ({ id: o.id, range: occupiedRange(o.startsAt, o.endsAt, o.bufferBeforeMinutes, o.bufferAfterMinutes) }));

  const occurrences = planned.map((o): PlannedVerdict => {
    const outside = p.kind !== "BLOCK" && outsideOn(o, hours);
    if (closedOn(o.dayKey, hours)) return { ...o, ok: false, reason: "CLOSED", outside };
    const want = occupiedRange(o.startsAt, o.endsAt, buffers.bufferBeforeMinutes, buffers.bufferAfterMinutes);
    const clash = busy.filter((b) => overlaps(want, b.range)).map((b) => b.id);
    if (clash.length) return { ...o, ok: false, reason: "CONFLICT", conflictingAppointmentIds: clash.slice(0, 10), outside };
    return { ...o, ok: true, outside };
  });
  return { durationMinutes, service: service ? { id: service.id, name: service.name } : null, buffers, occurrences };
}

export type SeriesPreview = {
  durationMinutes: number;
  occurrences: Array<{ index: number; dayKey: string; startsAt: string; endsAt: string; ok: boolean; reason: "CONFLICT" | "CLOSED" | null; outside: boolean }>;
  bookable: number;
  skipped: number;
};

/** Read-only: what a series request would book and skip — the form shows it before saving. */
export async function previewSeries(principal: AppointmentPrincipal, input: SeriesRequestInput): Promise<SeriesPreview> {
  authorizeAppointmentAction(principal, "appointment.create");
  const p = parseSeriesRequest(input);
  return tenantTx(principal.businessId, async (tx) => {
    const plan = await planWithinTx(tx, principal.businessId, p);
    const occurrences = plan.occurrences.map((o) => ({
      index: o.index, dayKey: o.dayKey, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), ok: o.ok, reason: o.reason ?? null, outside: o.outside,
    }));
    const bookable = occurrences.filter((o) => o.ok).length;
    return { durationMinutes: plan.durationMinutes, occurrences, bookable, skipped: occurrences.length - bookable };
  });
}

// ── SAVEPOINT: one occurrence refused by the database never fails the rest ──────────────────────

async function guarded<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (e) {
    if (!isOverlapViolation(e)) throw e;
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    return { ok: false };
  }
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

export type SeriesSummary = {
  series: AppointmentSeries;
  occurrences: Array<Pick<Appointment, "id" | "seriesIndex" | "status" | "startsAt" | "endsAt" | "version">>;
  skipped: SkippedOccurrence[];
};
export type SeriesWriteResult = SeriesSummary & { firstAppointmentId: number; replayed: boolean; warnings: string[] };

export async function createSeries(principal: AppointmentPrincipal, req: OwnerRequest, input: SeriesRequestInput): Promise<SeriesWriteResult> {
  authorizeAppointmentAction(principal, "appointment.create");
  const p = parseSeriesRequest(input);
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments/series", digestBody(p), async (ctx: WriteContext) => {
    const { tx, businessId } = ctx;
    const plan = await planWithinTx(tx, businessId, p);
    if (!plan.occurrences.some((o) => o.ok)) {
      throw new AppointmentServiceError("SLOT_CONFLICT", { skipped: plan.occurrences.map((o) => ({ index: o.index, dayKey: o.dayKey, reason: o.reason })) });
    }
    const series = await tx.appointmentSeries.create({
      data: {
        businessId, frequency: p.frequency, interval: 1, weekday: seriesWeekday(p.startsOn), startMinute: p.startMinute,
        durationMinutes: plan.durationMinutes, staffMemberId: p.staffMemberId, businessServiceId: plan.service?.id ?? null,
        customerId: p.customerId, kind: p.kind, title: p.title, startsOn: dayDate(p.startsOn),
        endsOn: p.end.endsOn ? dayDate(p.end.endsOn) : null, occurrenceCount: p.end.occurrenceCount ?? null,
        createdByUserId: actor.userId,
      },
    });

    const created: number[] = [];
    const skipped: SkippedOccurrence[] = [];
    let outside = false;
    for (const o of plan.occurrences) {
      if (!o.ok) {
        skipped.push({ index: o.index, dayKey: o.dayKey, reason: o.reason!, ...(o.conflictingAppointmentIds ? { conflictingAppointmentIds: o.conflictingAppointmentIds } : {}) });
        continue;
      }
      const r = await guarded(tx, "apc_occurrence", async () => {
        // Re-entrant (ownerWrite holds it already): a runtime no-op that keeps the lock visible inside the arrow (W1b).
        await lockBusinessAppointments(tx, businessId);
        const row = await tx.appointment.create({
          data: {
            businessId, status: p.status, kind: p.kind, startsAt: o.startsAt, endsAt: o.endsAt, durationMinutes: plan.durationMinutes,
            title: p.title ?? plan.service?.name ?? null, notes: p.notes,
            createdByActor: actor.actor, sourceChannel: actor.sourceChannel, createdByUserId: actor.userId,
            customerId: p.customerId, leadId: p.leadId, businessServiceId: plan.service?.id ?? null, staffMemberId: p.staffMemberId,
            locationKind: p.kind === "BLOCK" ? null : p.locationKind, locationDetail: p.kind === "BLOCK" ? null : p.locationDetail,
            ...plan.buffers, seriesId: series.id, seriesIndex: o.index,
          },
        });
        if (plan.service) {
          const signal = await recordOfferingDemand(tx, {
            businessId, kind: "SERVICE", offeringId: plan.service.id, signalType: "BOOKING", source: "APPOINTMENT",
            appointmentId: row.id, idempotencyKey: `booking:appointment:${row.id}`,
          });
          if (!signal) throw new Error("booking evidence was not written");
        }
        await appendAppointmentEvent(tx, {
          businessId, appointmentId: row.id, eventType: "APPOINTMENT_CREATED", ctx: actor,
          payload: {
            kind: p.kind, status: p.status, timed: true, startsAt: instantToken(o.startsAt), endsAt: instantToken(o.endsAt),
            staffMemberId: p.staffMemberId, businessServiceId: plan.service?.id ?? null, seriesId: series.id, seriesIndex: o.index,
          },
        });
        return row.id;
      });
      if (r.ok) {
        created.push(r.value);
        if (o.outside) outside = true;
      } else {
        skipped.push({ index: o.index, dayKey: o.dayKey, reason: "CONFLICT" });
      }
    }
    if (created.length === 0) throw new AppointmentServiceError("SLOT_CONFLICT", { skipped });

    await appendAppointmentEvent(tx, {
      businessId, appointmentId: created[0], eventType: "SERIES_CREATED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: {
        seriesId: series.id, frequency: p.frequency, planned: plan.occurrences.length, created: created.length,
        skippedIndexes: skipped.map((x) => x.index), skippedDays: skipped.map((x) => x.dayKey), skippedReasons: skipped.map((x) => x.reason),
      },
    });
    return { appointmentId: created[0], warnings: outside ? ["OUTSIDE_AVAILABILITY"] : [] };
  });

  const summary = await tenantTx(principal.businessId, async (tx) => {
    const first = await loadOwn(tx, principal.businessId, out.appointmentId);
    if (first.seriesId === null) throw new AppointmentServiceError("NOT_FOUND");
    return summaryWithinTx(tx, principal.businessId, first.seriesId);
  });
  return { ...summary, firstAppointmentId: out.appointmentId, replayed: out.replayed, warnings: out.warnings };
}

// ── Read ────────────────────────────────────────────────────────────────────────────────────────

async function loadSeries(tx: Tx, businessId: number, seriesId: number): Promise<AppointmentSeries> {
  const s = await tx.appointmentSeries.findFirst({ where: { id: seriesId, businessId } });
  if (!s) throw new AppointmentServiceError("NOT_FOUND");
  return s;
}

async function summaryWithinTx(tx: Tx, businessId: number, seriesId: number): Promise<SeriesSummary> {
  const series = await loadSeries(tx, businessId, seriesId);
  const occurrences = await tx.appointment.findMany({
    where: { businessId, seriesId },
    orderBy: { seriesIndex: "asc" },
    select: { id: true, seriesIndex: true, status: true, startsAt: true, endsAt: true, version: true },
  });
  const created = occurrences.length
    ? await tx.appointmentEvent.findFirst({
        where: { businessId, eventType: "SERIES_CREATED", appointmentId: { in: occurrences.map((o) => o.id) } },
        orderBy: { id: "asc" },
        select: { payload: true },
      })
    : null;
  const pl = (created?.payload ?? {}) as Record<string, unknown>;
  const idx = Array.isArray(pl.skippedIndexes) ? (pl.skippedIndexes as number[]) : [];
  const days = Array.isArray(pl.skippedDays) ? (pl.skippedDays as string[]) : [];
  const reasons = Array.isArray(pl.skippedReasons) ? (pl.skippedReasons as string[]) : [];
  // A split-off series has no SERIES_CREATED of its own (its first occurrence carries the original's): only its own.
  const skipped = pl.seriesId === seriesId
    ? idx.map((index, i) => ({ index, dayKey: days[i], reason: (reasons[i] === "CLOSED" ? "CLOSED" : "CONFLICT") as "CLOSED" | "CONFLICT" }))
    : [];
  return { series, occurrences, skipped };
}

export async function getSeries(principal: AppointmentPrincipal, seriesId: number): Promise<SeriesSummary> {
  authorizeAppointmentAction(principal, "appointment.read");
  return tenantTx(principal.businessId, (tx) => summaryWithinTx(tx, principal.businessId, seriesId));
}

// ── Change: this occurrence / this and following ────────────────────────────────────────────────

export type SeriesChangeInput = {
  action?: unknown;
  scope?: unknown;
  appointmentId?: unknown;
  expectedVersion?: unknown;
  cancelReason?: unknown;
  reason?: unknown;
  startsAt?: unknown;
  durationMinutes?: unknown;
  staffMemberId?: unknown;
};

export type SeriesChangeResult = {
  appointment: Appointment;
  seriesId: number;
  /** The series the following part now belongs to (a split), else the same id. */
  toSeriesId: number;
  changed: number;
  skipped: SkippedOccurrence[];
  replayed: boolean;
  warnings: string[];
};

export async function changeSeries(principal: AppointmentPrincipal, req: OwnerRequest, seriesId: number, input: SeriesChangeInput): Promise<SeriesChangeResult> {
  const action = input.action;
  if (action !== "cancel" && action !== "move") throw invalid("action");
  authorizeAppointmentAction(principal, action === "cancel" ? "appointment.status" : "appointment.reschedule");
  const scope = input.scope;
  if (scope !== "one" && scope !== "following") throw invalid("scope");
  if (!isPositiveInt(input.appointmentId)) throw invalid("appointmentId");
  const appointmentId = input.appointmentId;
  const expectedVersion = input.expectedVersion === undefined || input.expectedVersion === null ? undefined : input.expectedVersion;
  if (expectedVersion !== undefined && !isPositiveInt(expectedVersion)) throw invalid("expectedVersion");

  let cancelReason: AppointmentCancelReason | null = null;
  let reason: string | null = null;
  let startsAt: Date | null = null;
  let durationIn: number | null = null;
  let staffIn: number | null | undefined;
  if (action === "cancel") {
    if (input.cancelReason !== undefined && input.cancelReason !== null) {
      if (!OWNER_CANCEL_REASONS.includes(input.cancelReason as AppointmentCancelReason)) throw invalid("cancelReason");
      cancelReason = input.cancelReason as AppointmentCancelReason;
    }
    reason = optionalText(input.reason, "reason", 500);
  } else {
    startsAt = parseInstant(input.startsAt, "startsAt");
    if (startsAt.getTime() % MINUTE !== 0) throw invalid("startsAt");
    if (input.durationMinutes !== undefined && input.durationMinutes !== null) {
      if (!isPositiveInt(input.durationMinutes) || input.durationMinutes < MIN_DURATION_MINUTES || input.durationMinutes > MAX_DURATION_MINUTES) throw invalid("durationMinutes");
      durationIn = input.durationMinutes;
    }
    staffIn = input.staffMemberId === undefined ? undefined : optionalId(input.staffMemberId, "staffMemberId");
  }
  const body = { seriesId, action, scope, appointmentId, expectedVersion, cancelReason, reason, startsAt: startsAt?.toISOString() ?? null, durationIn, staffIn };
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments/series/[id]/change", body, async (ctx) => {
    const { tx, businessId } = ctx;
    const series = await loadSeries(tx, businessId, seriesId);
    if (series.cancelledAt) throw new AppointmentServiceError("INVALID_TRANSITION");
    if (expectedVersion !== undefined && series.version !== expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: series.version });
    const from = await loadOwn(tx, businessId, appointmentId);
    if (from.seriesId !== series.id || from.seriesIndex === null) throw new AppointmentServiceError("NOT_FOUND");
    if (isTerminal(from.status)) throw new AppointmentServiceError("INVALID_TRANSITION");

    const targets = scope === "one"
      ? [from]
      : await tx.appointment.findMany({
          where: { businessId, seriesId: series.id, seriesIndex: { gte: from.seriesIndex }, status: { in: ACTIVE } },
          orderBy: { seriesIndex: "asc" },
        });

    const fromDay = jerusalemDayKey(from.startsAt as Date);
    const seriesStartsOn = dayKeyOfDate(series.startsOn);
    let toSeriesId = series.id;
    let changed = 0;
    const skipped: SkippedOccurrence[] = [];
    const warnings = new Set<string>();
    const seriesUpdate: Prisma.AppointmentSeriesUpdateInput = { version: { increment: 1 } };

    if (action === "cancel") {
      for (const t of targets) {
        const r = await transitionWithinTx(tx, t, "CANCELED", actor, { appendNote: reason, cancelReason });
        if (!r.ok) throw new AppointmentServiceError("INVALID_TRANSITION");
        changed++;
      }
      if (scope === "following") {
        const last = endBefore(seriesStartsOn, fromDay);
        if (last === null) seriesUpdate.cancelledAt = ctx.now;
        else { seriesUpdate.endsOn = dayDate(last); seriesUpdate.occurrenceCount = null; }
      }
    } else {
      const newStart = startsAt as Date;
      const newDay = jerusalemDayKey(newStart);
      const minute = minuteOf(newStart);
      const delta = daysBetweenDayKeys(fromDay, newDay);
      const keepMinutes = from.durationMinutes ?? Math.round(((from.endsAt as Date).getTime() - (from.startsAt as Date).getTime()) / MINUTE);
      const duration = durationIn ?? keepMinutes;
      const staffMemberId = staffIn === undefined ? from.staffMemberId : staffIn;
      if (staffMemberId !== null && staffMemberId !== from.staffMemberId) await activeStaff(tx, businessId, staffMemberId);
      if (from.businessServiceId !== null && staffMemberId !== from.staffMemberId) await staffServiceDuration(tx, businessId, from.businessServiceId, staffMemberId);

      if (scope === "one") {
        const endsAt = new Date(newStart.getTime() + duration * MINUTE);
        const moved = await moveOne(tx, ctx, actor, from, newStart, endsAt, duration, staffMemberId);
        if (!moved.ok) throw new AppointmentServiceError("SLOT_CONFLICT", { conflictingAppointmentIds: moved.conflicts });
        if (moved.outside) warnings.add("OUTSIDE_AVAILABILITY");
        changed = 1;
      } else {
        const lastDay = addCalendarDays(jerusalemDayKey((targets[targets.length - 1].startsAt as Date)), delta);
        const hours = await laneAvailability(tx, businessId, staffMemberId, newDay < fromDay ? newDay : fromDay, lastDay > newDay ? lastDay : newDay);
        for (const t of targets) {
          const day = addCalendarDays(jerusalemDayKey(t.startsAt as Date), delta);
          if (closedOn(day, hours)) { skipped.push({ index: t.seriesIndex!, dayKey: day, reason: "CLOSED" }); continue; }
          const s = instantOf(day, minute);
          const e = new Date(s.getTime() + duration * MINUTE);
          const moved = await moveOne(tx, ctx, actor, t, s, e, duration, staffMemberId);
          if (!moved.ok) { skipped.push({ index: t.seriesIndex!, dayKey: day, reason: "CONFLICT", conflictingAppointmentIds: moved.conflicts }); continue; }
          if (moved.outside) warnings.add("OUTSIDE_AVAILABILITY");
          changed++;
        }
        if (changed === 0) throw new AppointmentServiceError("SLOT_CONFLICT", { skipped });

        // The rule of the following part. No earlier occurrence ⇒ the series itself changes; else it splits.
        const earlier = await tx.appointment.count({ where: { businessId, seriesId: series.id, seriesIndex: { lt: from.seriesIndex } } });
        const ruleDay = addCalendarDays(fromDay, delta);
        if (earlier === 0) {
          seriesUpdate.weekday = seriesWeekday(ruleDay);
          seriesUpdate.startMinute = minute;
          seriesUpdate.durationMinutes = duration;
          seriesUpdate.staffMemberId = staffMemberId;
          seriesUpdate.startsOn = dayDate(addCalendarDays(seriesStartsOn, delta));
          if (series.endsOn) seriesUpdate.endsOn = dayDate(addCalendarDays(dayKeyOfDate(series.endsOn), delta));
        } else {
          const last = endBefore(seriesStartsOn, fromDay) as JerusalemDayKey;
          const remaining = series.occurrenceCount !== null ? series.occurrenceCount - from.seriesIndex : null;
          const split = await tx.appointmentSeries.create({
            data: {
              businessId, frequency: series.frequency, interval: series.interval, weekday: seriesWeekday(ruleDay), startMinute: minute,
              durationMinutes: duration, staffMemberId, businessServiceId: series.businessServiceId, customerId: series.customerId,
              kind: series.kind, title: series.title, startsOn: dayDate(ruleDay),
              endsOn: remaining === null && series.endsOn ? dayDate(addCalendarDays(dayKeyOfDate(series.endsOn), delta)) : null,
              occurrenceCount: remaining !== null ? Math.max(1, remaining) : null,
              createdByUserId: actor.userId,
            },
          });
          // Re-point the following part (every occurrence from this index on, whatever its state) and re-index from 0.
          await tx.appointment.updateMany({
            where: { businessId, seriesId: series.id, seriesIndex: { gte: from.seriesIndex } },
            data: { seriesId: split.id, seriesIndex: { decrement: from.seriesIndex } },
          });
          seriesUpdate.endsOn = dayDate(last);
          seriesUpdate.occurrenceCount = null;
          toSeriesId = split.id;
        }
      }
    }

    await tx.appointmentSeries.update({ where: { id: series.id }, data: seriesUpdate });
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: from.id, eventType: "SERIES_CHANGED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: {
        seriesId: series.id, toSeriesId, action: action as string, scope: scope as string, changed,
        skippedIndexes: skipped.map((x) => x.index), skippedDays: skipped.map((x) => x.dayKey), skippedReasons: skipped.map((x) => x.reason),
      },
    });
    return { appointmentId: from.id, warnings: [...warnings] };
  });

  return tenantTx(principal.businessId, async (tx) => {
    const appointment = await loadOwn(tx, principal.businessId, out.appointmentId);
    const ev = await tx.appointmentEvent.findFirst({
      where: { businessId: principal.businessId, idempotencyKey: req.idempotencyKey },
      select: { payload: true },
    });
    const pl = (ev?.payload ?? {}) as Record<string, unknown>;
    const idx = Array.isArray(pl.skippedIndexes) ? (pl.skippedIndexes as number[]) : [];
    const days = Array.isArray(pl.skippedDays) ? (pl.skippedDays as string[]) : [];
    const reasons = Array.isArray(pl.skippedReasons) ? (pl.skippedReasons as string[]) : [];
    return {
      appointment,
      seriesId,
      toSeriesId: typeof pl.toSeriesId === "number" ? pl.toSeriesId : seriesId,
      changed: typeof pl.changed === "number" ? pl.changed : 0,
      skipped: idx.map((index, i) => ({ index, dayKey: days[i], reason: (reasons[i] === "CLOSED" ? "CLOSED" : "CONFLICT") as "CLOSED" | "CONFLICT" })),
      replayed: out.replayed,
      warnings: out.warnings,
    };
  });
}

/**
 * Moves one occurrence (same rules as moveAppointment: the lane check under the lock, then the database under a
 * SAVEPOINT). A taken time is answered, never forced; journalled APPOINTMENT_RESCHEDULED + the learning sensor.
 */
async function moveOne(
  tx: Tx, ctx: WriteContext, actor: ReturnType<typeof ownerActor>, current: Appointment,
  startsAt: Date, endsAt: Date, durationMinutes: number, staffMemberId: number | null,
): Promise<{ ok: true; outside: boolean } | { ok: false; conflicts: number[] }> {
  const want = occupiedRange(startsAt, endsAt, current.bufferBeforeMinutes, current.bufferAfterMinutes);
  const clash = (await laneOccupants(tx, ctx.businessId, staffMemberId, want, current.id))
    .filter((o) => overlaps(want, occupiedRange(o.startsAt, o.endsAt, o.bufferBeforeMinutes, o.bufferAfterMinutes)))
    .map((o) => o.id);
  if (clash.length) return { ok: false, conflicts: clash.slice(0, 10) };
  const r = await guarded(tx, "apc_move", async () => {
    // Re-entrant in this transaction (ownerWrite already holds it): a runtime no-op that keeps the lock structurally
    // visible inside the SAVEPOINT arrow (the appointment write guard, rule W1b).
    await lockBusinessAppointments(tx, ctx.businessId);
    return tx.appointment.update({ where: { id: current.id }, data: { startsAt, endsAt, durationMinutes, staffMemberId, version: { increment: 1 } } });
  });
  if (!r.ok) return { ok: false, conflicts: [] };
  const outside = current.kind !== "BLOCK" && (await outsideAvailability(tx, ctx.businessId, staffMemberId, startsAt, endsAt));
  const startChanged = (current.startsAt?.getTime() ?? null) !== startsAt.getTime();
  const durationChanged = (current.durationMinutes ?? null) !== durationMinutes;
  if ((startChanged || durationChanged) && current.kind === "CUSTOMER") {
    await recordSensor({
      businessId: ctx.businessId, sensor: "APPOINTMENT_RESCHEDULED", entityId: current.id, ...sensorWho(actor),
      payload: { previousStartsAt: current.startsAt ? current.startsAt.toISOString() : null, startsAt: startsAt.toISOString(), durationChanged },
    }, { tx });
  }
  await appendAppointmentEvent(tx, {
    businessId: ctx.businessId, appointmentId: current.id, eventType: "APPOINTMENT_RESCHEDULED", ctx: actor,
    payload: {
      fromStartsAt: instantToken(current.startsAt), toStartsAt: instantToken(startsAt),
      fromEndsAt: instantToken(current.endsAt), toEndsAt: instantToken(endsAt),
      fromStaffMemberId: current.staffMemberId, toStaffMemberId: staffMemberId, durationChanged, seriesId: current.seriesId,
    },
  });
  return { ok: true, outside };
}
