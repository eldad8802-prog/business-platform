/**
 * Appointments on the calendar — the owner's timed appointments, internal meetings and time blocks (milestone A).
 * SERVER-ONLY.
 *
 * Builds on appointment.service (the lifecycle, the sensors, the existing paths) and never replaces it. What is new:
 *   - a timed appointment has an end time and a lane (a staff member, or the business's own lane when none);
 *   - no two active appointments of a lane may overlap — checked here first under a per-business lock, so the owner
 *     gets the conflicting appointments back; refused by the database (Appointment_no_overlap) in every case;
 *   - a business-wide block (no staff member) closes the time for every lane;
 *   - every write is idempotent (Idempotency-Key) and journalled; optimistic versions refuse a stale edit;
 *   - the owner may book outside working hours (their calendar, their call): the answer says so
 *     (OUTSIDE_AVAILABILITY) instead of refusing. Overlap is never allowed.
 * Free slots come from availability.core (pure) over the lane's rules, exceptions and busy time.
 */
import type { Appointment, AppointmentKind, AppointmentLocationKind, Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { recordOfferingDemand } from "@/lib/services/offering/offering-demand";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { addCalendarDays, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { isTerminal } from "./appointment.lifecycle";
import { sensorWho, transitionWithinTx } from "./appointment.service";
import type { ActorContext } from "./appointment.types";
import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError, invalid } from "./appointment-errors";
import { appendAppointmentEvent, instantToken } from "./appointment-journal";
import { ownerWrite, type OwnerRequest, type WriteContext } from "./appointment-request";
import {
  computeSlots,
  insideAvailability,
  isDayKey,
  MAX_SLOT_RANGE_DAYS,
  occupiedRange,
  overlaps,
  windowsAsIntervals,
  windowsForDay,
  type DayException,
  type Interval,
  type Slot,
  type WeeklyRule,
} from "./availability.core";

const MINUTE = 60_000;
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 1440;
/** The widest range one calendar read may ask for (a month view plus its edges). */
export const MAX_RANGE_DAYS = 62;
const ACTIVE: Appointment["status"][] = ["PROPOSED", "CONFIRMED"];
const KINDS: AppointmentKind[] = ["CUSTOMER", "INTERNAL", "BLOCK"];
const LOCATIONS: AppointmentLocationKind[] = ["IN_PERSON", "PHONE", "ONLINE"];

/** The owner acting through the owner API (decision 6: always their own user). */
export function ownerActor(principal: AppointmentPrincipal): ActorContext {
  return { actor: "OWNER", userId: principal.userId, sourceChannel: "INBOX_WEB" };
}

// ── Input parsing (shared by the routes and the tests) ──────────────────────────────────────────

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

export function parseInstant(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.length > 40) throw invalid(field);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(field);
  return d;
}

function optionalId(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPositiveInt(value)) throw invalid(field);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw invalid(field);
  const t = value.trim();
  return t.length === 0 ? null : t;
}

function optionalVersion(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPositiveInt(value)) throw invalid("expectedVersion");
  return value;
}

/** End and duration from what the request gave: an end, a duration, or the service's (staff-specific) duration. */
function resolveSpan(startsAt: Date, endsAt: Date | null, durationMinutes: number | null): { endsAt: Date; durationMinutes: number } {
  let minutes: number;
  if (endsAt) {
    const ms = endsAt.getTime() - startsAt.getTime();
    if (ms <= 0 || ms % MINUTE !== 0) throw invalid("endsAt");
    minutes = ms / MINUTE;
    if (durationMinutes !== null && durationMinutes !== minutes) throw invalid("durationMinutes");
  } else if (durationMinutes !== null) {
    minutes = durationMinutes;
  } else {
    throw invalid("durationMinutes");
  }
  if (!Number.isInteger(minutes) || minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) throw invalid("durationMinutes");
  return { endsAt: new Date(startsAt.getTime() + minutes * MINUTE), durationMinutes: minutes };
}

// ── Reads inside a transaction ──────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

async function loadOwn(tx: Tx, businessId: number, id: number): Promise<Appointment> {
  const row = await tx.appointment.findFirst({ where: { id, businessId } });
  if (!row) throw new AppointmentServiceError("NOT_FOUND");
  return row;
}

async function activeStaff(tx: Tx, businessId: number, staffMemberId: number) {
  const s = await tx.staffMember.findFirst({ where: { id: staffMemberId, businessId, active: true, erasedAt: null }, select: { id: true } });
  if (!s) throw new AppointmentServiceError("STAFF_NOT_FOUND");
  return s;
}

async function activeService(tx: Tx, businessId: number, businessServiceId: number) {
  const s = await tx.businessService.findFirst({
    where: { id: businessServiceId, businessId, active: true },
    select: { id: true, name: true, durationMinutes: true },
  });
  if (!s) throw new AppointmentServiceError("SERVICE_NOT_FOUND");
  return s;
}

/** A staff member may take a service when the service names no staff at all, or names them. */
async function staffServiceDuration(tx: Tx, businessId: number, businessServiceId: number, staffMemberId: number | null): Promise<number | null> {
  const live = await tx.staffServiceAssignment.findMany({
    where: { businessId, businessServiceId, removedAt: null },
    select: { staffMemberId: true, durationOverrideMinutes: true },
  });
  if (staffMemberId === null || live.length === 0) return null;
  const mine = live.find((a) => a.staffMemberId === staffMemberId);
  if (!mine) throw new AppointmentServiceError("STAFF_NOT_ASSIGNED");
  return mine.durationOverrideMinutes;
}

async function bufferPolicy(tx: Tx, businessId: number, businessServiceId: number | null) {
  if (businessServiceId === null) return { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
  const p = await tx.serviceBookingPolicy.findFirst({
    where: { businessId, businessServiceId },
    select: { bufferBeforeMinutes: true, bufferAfterMinutes: true },
  });
  return { bufferBeforeMinutes: p?.bufferBeforeMinutes ?? 0, bufferAfterMinutes: p?.bufferAfterMinutes ?? 0 };
}

type Occupant = { id: number; startsAt: Date; endsAt: Date; bufferBeforeMinutes: number; bufferAfterMinutes: number };

/**
 * Who already occupies time around `range` in a lane: the lane's active timed appointments, plus — for a staff
 * lane — the business-wide blocks, which close the time for everyone.
 */
async function laneOccupants(tx: Tx, businessId: number, staffMemberId: number | null, range: Interval, excludeId?: number): Promise<Occupant[]> {
  const pad = 241 * MINUTE; // the widest buffer (240) and one minute
  const rows = await tx.appointment.findMany({
    where: {
      businessId,
      status: { in: ACTIVE },
      endsAt: { not: null, gt: new Date(range.start.getTime() - pad) },
      startsAt: { lt: new Date(range.end.getTime() + pad) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: staffMemberId === null
        ? [{ staffMemberId: null }]
        : [{ staffMemberId }, { staffMemberId: null, kind: "BLOCK" }],
    },
    select: { id: true, startsAt: true, endsAt: true, bufferBeforeMinutes: true, bufferAfterMinutes: true },
  });
  return rows.map((r) => ({ id: r.id, startsAt: r.startsAt as Date, endsAt: r.endsAt as Date, bufferBeforeMinutes: r.bufferBeforeMinutes, bufferAfterMinutes: r.bufferAfterMinutes }));
}

async function assertFree(tx: Tx, businessId: number, staffMemberId: number | null, occupied: Interval, excludeId?: number): Promise<void> {
  const occupants = await laneOccupants(tx, businessId, staffMemberId, occupied, excludeId);
  const clashing = occupants.filter((o) => overlaps(occupied, occupiedRange(o.startsAt, o.endsAt, o.bufferBeforeMinutes, o.bufferAfterMinutes)));
  if (clashing.length > 0) {
    throw new AppointmentServiceError("SLOT_CONFLICT", { conflictingAppointmentIds: clashing.map((c) => c.id).slice(0, 10) });
  }
}

/** The lane's rules and exceptions (a staff member without rules of their own follows the business's hours). */
async function laneAvailability(tx: Tx, businessId: number, staffMemberId: number | null, fromDay: JerusalemDayKey, toDay: JerusalemDayKey) {
  const allRules = await tx.availabilityRule.findMany({
    where: { businessId, removedAt: null, OR: staffMemberId === null ? [{ staffMemberId: null }] : [{ staffMemberId: null }, { staffMemberId }] },
    select: { staffMemberId: true, weekday: true, startMinute: true, endMinute: true, validFrom: true, validUntil: true },
  });
  const own = staffMemberId === null ? [] : allRules.filter((r) => r.staffMemberId === staffMemberId);
  const chosen = own.length > 0 ? own : allRules.filter((r) => r.staffMemberId === null);
  const rules: WeeklyRule[] = chosen.map((r) => ({
    weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute,
    validFrom: r.validFrom ? r.validFrom.toISOString().slice(0, 10) : null,
    validUntil: r.validUntil ? r.validUntil.toISOString().slice(0, 10) : null,
  }));
  const ex = await tx.availabilityException.findMany({
    where: {
      businessId, removedAt: null,
      dayKey: { gte: new Date(`${fromDay}T00:00:00.000Z`), lte: new Date(`${toDay}T00:00:00.000Z`) },
      OR: staffMemberId === null ? [{ staffMemberId: null }] : [{ staffMemberId: null }, { staffMemberId }],
    },
    select: { dayKey: true, kind: true, startMinute: true, endMinute: true },
  });
  const exceptions: DayException[] = ex.map((e) => ({ dayKey: e.dayKey.toISOString().slice(0, 10), kind: e.kind, startMinute: e.startMinute, endMinute: e.endMinute }));
  return { rules, exceptions, hasRules: allRules.length > 0 };
}

async function outsideAvailability(tx: Tx, businessId: number, staffMemberId: number | null, startsAt: Date, endsAt: Date): Promise<boolean> {
  const day = jerusalemDayKey(startsAt);
  const { rules, exceptions, hasRules } = await laneAvailability(tx, businessId, staffMemberId, day, day);
  if (!hasRules && exceptions.length === 0) return false; // no hours defined yet: nothing to be outside of
  return !insideAvailability(startsAt, endsAt, windowsAsIntervals(day, windowsForDay(day, rules, exceptions)));
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

export type CreateAppointmentInput = {
  kind?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  durationMinutes?: unknown;
  staffMemberId?: unknown;
  businessServiceId?: unknown;
  customerId?: unknown;
  leadId?: unknown;
  title?: unknown;
  notes?: unknown;
  locationKind?: unknown;
  locationDetail?: unknown;
  status?: unknown;
};

export type AppointmentWriteResult = { appointment: Appointment; replayed: boolean; warnings: string[] };

export async function createAppointment(principal: AppointmentPrincipal, req: OwnerRequest, input: CreateAppointmentInput): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.create");
  const kind = (input.kind ?? "CUSTOMER") as AppointmentKind;
  if (!KINDS.includes(kind)) throw invalid("kind");
  const status = (input.status ?? "CONFIRMED") as "CONFIRMED" | "PROPOSED";
  if (status !== "CONFIRMED" && status !== "PROPOSED") throw invalid("status");
  const startsAt = parseInstant(input.startsAt, "startsAt");
  const endsAtIn = input.endsAt === undefined || input.endsAt === null ? null : parseInstant(input.endsAt, "endsAt");
  const durationIn = input.durationMinutes === undefined || input.durationMinutes === null ? null : input.durationMinutes;
  if (durationIn !== null && !isPositiveInt(durationIn)) throw invalid("durationMinutes");
  const staffMemberId = optionalId(input.staffMemberId, "staffMemberId") ?? null;
  const businessServiceId = optionalId(input.businessServiceId, "businessServiceId") ?? null;
  const customerId = optionalId(input.customerId, "customerId") ?? null;
  const leadId = optionalId(input.leadId, "leadId") ?? null;
  const title = optionalText(input.title, "title", 200) ?? null;
  const notes = optionalText(input.notes, "notes", 4000) ?? null;
  const locationKind = input.locationKind === undefined || input.locationKind === null ? null : (input.locationKind as AppointmentLocationKind);
  if (locationKind !== null && !LOCATIONS.includes(locationKind)) throw invalid("locationKind");
  const locationDetail = optionalText(input.locationDetail, "locationDetail", 300) ?? null;
  if (kind !== "CUSTOMER" && (customerId !== null || leadId !== null || businessServiceId !== null)) throw invalid("kind");
  if (kind === "BLOCK" && status !== "CONFIRMED") throw invalid("status");

  const body = { kind, status, startsAt: startsAt.toISOString(), endsAt: endsAtIn?.toISOString() ?? null, durationMinutes: durationIn,
    staffMemberId, businessServiceId, customerId, leadId, title, notes, locationKind, locationDetail };
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments", body, async (ctx: WriteContext) => {
    const { tx, businessId } = ctx;
    if (staffMemberId !== null) await activeStaff(tx, businessId, staffMemberId);
    const service = businessServiceId !== null ? await activeService(tx, businessId, businessServiceId) : null;
    const staffDuration = service ? await staffServiceDuration(tx, businessId, service.id, staffMemberId) : null;
    if (customerId !== null && !(await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } }))) {
      throw new AppointmentServiceError("CUSTOMER_NOT_FOUND");
    }
    if (leadId !== null && !(await tx.lead.findFirst({ where: { id: leadId, businessId }, select: { id: true } }))) {
      throw new AppointmentServiceError("LEAD_NOT_FOUND");
    }
    const requested = durationIn as number | null;
    const span = resolveSpan(startsAt, endsAtIn, endsAtIn ? requested : (requested ?? staffDuration ?? service?.durationMinutes ?? null));
    const buffers = kind === "CUSTOMER" ? await bufferPolicy(tx, businessId, service?.id ?? null) : { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
    await assertFree(tx, businessId, staffMemberId, occupiedRange(startsAt, span.endsAt, buffers.bufferBeforeMinutes, buffers.bufferAfterMinutes));
    const warnings = kind !== "BLOCK" && (await outsideAvailability(tx, businessId, staffMemberId, startsAt, span.endsAt)) ? ["OUTSIDE_AVAILABILITY"] : [];

    const row = await tx.appointment.create({
      data: {
        businessId, status, kind, startsAt, endsAt: span.endsAt, durationMinutes: span.durationMinutes,
        title: title ?? service?.name ?? null, notes,
        createdByActor: actor.actor, sourceChannel: actor.sourceChannel, createdByUserId: actor.userId,
        customerId, leadId, businessServiceId: service?.id ?? null, staffMemberId,
        locationKind, locationDetail, ...buffers,
      },
    });
    if (service) {
      const signal = await recordOfferingDemand(tx, {
        businessId, kind: "SERVICE", offeringId: service.id, signalType: "BOOKING", source: "APPOINTMENT",
        appointmentId: row.id, idempotencyKey: `booking:appointment:${row.id}`,
      });
      if (!signal) throw new Error("booking evidence was not written");
    }
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: row.id, eventType: "APPOINTMENT_CREATED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: { kind, status, timed: true, startsAt: instantToken(startsAt), endsAt: instantToken(span.endsAt), staffMemberId, businessServiceId: service?.id ?? null },
    });
    return { appointmentId: row.id, warnings };
  });
  return materialize(principal.businessId, out);
}

async function materialize(businessId: number, out: { appointmentId: number; replayed: boolean; warnings: string[] }): Promise<AppointmentWriteResult> {
  const appointment = await tenantTx(businessId, (tx) => loadOwn(tx, businessId, out.appointmentId));
  return { appointment, replayed: out.replayed, warnings: out.warnings };
}

// ── Read ────────────────────────────────────────────────────────────────────────────────────────

export type ListAppointmentsInput = { from?: unknown; to?: unknown; staffMemberId?: unknown; includeCanceled?: unknown };

/** Appointments that START inside [from, to) — the calendar's view of a range (≤ 62 days). */
export async function listAppointments(principal: AppointmentPrincipal, input: ListAppointmentsInput): Promise<Appointment[]> {
  authorizeAppointmentAction(principal, "appointment.read");
  const from = parseInstant(input.from, "from");
  const to = parseInstant(input.to, "to");
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * MINUTE) throw invalid("to");
  const staffMemberId = optionalId(input.staffMemberId, "staffMemberId");
  const includeCanceled = input.includeCanceled === true || input.includeCanceled === "true";
  return tenantTx(principal.businessId, (tx) =>
    tx.appointment.findMany({
      where: {
        businessId: principal.businessId,
        startsAt: { gte: from, lt: to },
        ...(staffMemberId !== undefined ? { staffMemberId } : {}),
        ...(includeCanceled ? {} : { status: { not: "CANCELED" } }),
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 2000,
    }),
  );
}

export async function getAppointment(principal: AppointmentPrincipal, id: number) {
  authorizeAppointmentAction(principal, "appointment.read");
  return tenantTx(principal.businessId, async (tx) => {
    const appointment = await loadOwn(tx, principal.businessId, id);
    const events = await tx.appointmentEvent.findMany({
      where: { businessId: principal.businessId, appointmentId: id },
      orderBy: { id: "desc" },
      take: 20,
      select: { eventType: true, actor: true, occurredAt: true, payload: true },
    });
    return { appointment, history: events.map((e) => ({ type: e.eventType, actor: e.actor, at: e.occurredAt.toISOString(), payload: e.payload })) };
  });
}

// ── Move ────────────────────────────────────────────────────────────────────────────────────────

export type MoveAppointmentInput = { startsAt?: unknown; endsAt?: unknown; durationMinutes?: unknown; staffMemberId?: unknown; expectedVersion?: unknown };

export async function moveAppointment(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: MoveAppointmentInput): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.reschedule");
  const startsAt = parseInstant(input.startsAt, "startsAt");
  const endsAtIn = input.endsAt === undefined || input.endsAt === null ? null : parseInstant(input.endsAt, "endsAt");
  const durationIn = input.durationMinutes === undefined || input.durationMinutes === null ? null : input.durationMinutes;
  if (durationIn !== null && !isPositiveInt(durationIn)) throw invalid("durationMinutes");
  const staffIn = optionalId(input.staffMemberId, "staffMemberId");
  const expectedVersion = optionalVersion(input.expectedVersion);
  const body = { id, startsAt: startsAt.toISOString(), endsAt: endsAtIn?.toISOString() ?? null, durationMinutes: durationIn, staffMemberId: staffIn, expectedVersion };
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments/[id]/reschedule", body, async (ctx) => {
    const { tx, businessId } = ctx;
    const current = await loadOwn(tx, businessId, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    if (isTerminal(current.status)) throw new AppointmentServiceError("INVALID_TRANSITION");
    const staffMemberId = staffIn === undefined ? current.staffMemberId : staffIn;
    if (staffMemberId !== null && staffMemberId !== current.staffMemberId) await activeStaff(tx, businessId, staffMemberId);
    if (current.businessServiceId !== null && staffMemberId !== current.staffMemberId) {
      await staffServiceDuration(tx, businessId, current.businessServiceId, staffMemberId);
    }
    const keepMinutes = current.durationMinutes ?? (current.endsAt && current.startsAt ? Math.round((current.endsAt.getTime() - current.startsAt.getTime()) / MINUTE) : null);
    const span = resolveSpan(startsAt, endsAtIn, (durationIn as number | null) ?? (endsAtIn ? null : keepMinutes));
    await assertFree(tx, businessId, staffMemberId, occupiedRange(startsAt, span.endsAt, current.bufferBeforeMinutes, current.bufferAfterMinutes), current.id);
    const warnings = current.kind !== "BLOCK" && (await outsideAvailability(tx, businessId, staffMemberId, startsAt, span.endsAt)) ? ["OUTSIDE_AVAILABILITY"] : [];

    const row = await tx.appointment.update({
      where: { id: current.id },
      data: { startsAt, endsAt: span.endsAt, durationMinutes: span.durationMinutes, staffMemberId, version: { increment: 1 } },
    });
    const startChanged = (current.startsAt?.getTime() ?? null) !== startsAt.getTime();
    const durationChanged = (current.durationMinutes ?? null) !== span.durationMinutes;
    if ((startChanged || durationChanged) && current.kind === "CUSTOMER") {
      await recordSensor({
        businessId, sensor: "APPOINTMENT_RESCHEDULED", entityId: row.id, ...sensorWho(actor),
        payload: { previousStartsAt: current.startsAt ? current.startsAt.toISOString() : null, startsAt: startsAt.toISOString(), durationChanged },
      }, { tx });
    }
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: row.id, eventType: "APPOINTMENT_RESCHEDULED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: {
        fromStartsAt: instantToken(current.startsAt), toStartsAt: instantToken(startsAt),
        fromEndsAt: instantToken(current.endsAt), toEndsAt: instantToken(span.endsAt),
        fromStaffMemberId: current.staffMemberId, toStaffMemberId: staffMemberId, durationChanged,
      },
    });
    return { appointmentId: row.id, warnings };
  });
  return materialize(principal.businessId, out);
}

// ── Status ──────────────────────────────────────────────────────────────────────────────────────

export type ChangeStatusInput = { to?: unknown; cancelReason?: unknown; reason?: unknown; expectedVersion?: unknown };
const OWNER_CANCEL_REASONS = ["OWNER_CANCELED", "CUSTOMER_CANCELED", "OTHER"] as const;

export async function changeStatus(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: ChangeStatusInput): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.status");
  const to = input.to as Appointment["status"];
  if (to !== "CONFIRMED" && to !== "COMPLETED" && to !== "NO_SHOW" && to !== "CANCELED") throw invalid("to");
  const cancelReason = input.cancelReason === undefined || input.cancelReason === null ? null : (input.cancelReason as (typeof OWNER_CANCEL_REASONS)[number]);
  if (cancelReason !== null && (to !== "CANCELED" || !OWNER_CANCEL_REASONS.includes(cancelReason))) throw invalid("cancelReason");
  const reason = optionalText(input.reason, "reason", 500) ?? null;
  const expectedVersion = optionalVersion(input.expectedVersion);
  const body = { id, to, cancelReason, reason, expectedVersion };
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "POST /api/appointments/[id]/status", body, async (ctx) => {
    const current = await loadOwn(ctx.tx, ctx.businessId, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    if (current.kind === "BLOCK" && to !== "CANCELED") throw new AppointmentServiceError("INVALID_TRANSITION");
    const r = await transitionWithinTx(ctx.tx, current, to, actor, {
      appendNote: to === "CANCELED" ? reason : null, cancelReason, journalKey: ctx.key, digest: ctx.digest,
    });
    if (!r.ok) throw new AppointmentServiceError("INVALID_TRANSITION");
    return { appointmentId: current.id };
  });
  return materialize(principal.businessId, out);
}

// ── Details ─────────────────────────────────────────────────────────────────────────────────────

export type UpdateDetailsInput = { title?: unknown; notes?: unknown; locationKind?: unknown; locationDetail?: unknown; customerId?: unknown; expectedVersion?: unknown };

export async function updateDetails(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: UpdateDetailsInput): Promise<AppointmentWriteResult> {
  authorizeAppointmentAction(principal, "appointment.edit");
  const title = optionalText(input.title, "title", 200);
  const notes = optionalText(input.notes, "notes", 4000);
  const locationDetail = optionalText(input.locationDetail, "locationDetail", 300);
  const locationKind = input.locationKind === undefined ? undefined : input.locationKind === null ? null : (input.locationKind as AppointmentLocationKind);
  if (locationKind !== undefined && locationKind !== null && !LOCATIONS.includes(locationKind)) throw invalid("locationKind");
  const customerId = optionalId(input.customerId, "customerId");
  const expectedVersion = optionalVersion(input.expectedVersion);
  const data: Prisma.AppointmentUncheckedUpdateInput = {};
  const fields: string[] = [];
  if (title !== undefined) { data.title = title; fields.push("title"); }
  if (notes !== undefined) { data.notes = notes; fields.push("notes"); }
  if (locationKind !== undefined) { data.locationKind = locationKind; fields.push("locationKind"); }
  if (locationDetail !== undefined) { data.locationDetail = locationDetail; fields.push("locationDetail"); }
  if (fields.length === 0 && customerId === undefined) throw invalid("fields");
  const body = { id, title, notes, locationKind, locationDetail, customerId, expectedVersion };
  const actor = ownerActor(principal);

  const out = await ownerWrite(principal, req, "PATCH /api/appointments/[id]/details", body, async (ctx) => {
    const { tx, businessId } = ctx;
    const current = await loadOwn(tx, businessId, id);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    if (customerId !== undefined) {
      if (current.kind !== "CUSTOMER") throw invalid("customerId");
      if (customerId !== null && !(await tx.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true } }))) {
        throw new AppointmentServiceError("CUSTOMER_NOT_FOUND");
      }
      data.customerId = customerId;
      fields.push("customerId");
    }
    await tx.appointment.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 } } });
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: current.id, eventType: "APPOINTMENT_DETAILS_CHANGED", ctx: actor, idempotencyKey: ctx.key, digest: ctx.digest,
      payload: { fields },
    });
    return { appointmentId: current.id };
  });
  return materialize(principal.businessId, out);
}

// ── Free slots ──────────────────────────────────────────────────────────────────────────────────

export type FindSlotsInput = { fromDay?: unknown; toDay?: unknown; businessServiceId?: unknown; durationMinutes?: unknown; staffMemberId?: unknown; now?: Date };

export async function findSlots(principal: AppointmentPrincipal, input: FindSlotsInput): Promise<{ slots: Slot[]; durationMinutes: number }> {
  authorizeAppointmentAction(principal, "availability.read");
  if (!isDayKey(input.fromDay)) throw invalid("fromDay");
  if (!isDayKey(input.toDay)) throw invalid("toDay");
  const fromDay = input.fromDay;
  const toDay = input.toDay;
  if (toDay < fromDay || addCalendarDays(fromDay, MAX_SLOT_RANGE_DAYS - 1) < toDay) throw invalid("toDay");
  const businessServiceId = optionalId(input.businessServiceId, "businessServiceId") ?? null;
  const staffMemberId = optionalId(input.staffMemberId, "staffMemberId") ?? null;
  if (input.durationMinutes !== undefined && input.durationMinutes !== null && !isPositiveInt(input.durationMinutes)) throw invalid("durationMinutes");
  const now = input.now ?? new Date();
  const businessId = principal.businessId;

  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await activeStaff(tx, businessId, staffMemberId);
    const service = businessServiceId !== null ? await activeService(tx, businessId, businessServiceId) : null;
    const staffDuration = service ? await staffServiceDuration(tx, businessId, service.id, staffMemberId) : null;
    const duration = (input.durationMinutes as number | undefined) ?? staffDuration ?? service?.durationMinutes ?? null;
    if (duration === null || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) throw invalid("durationMinutes");
    const policy = service
      ? await tx.serviceBookingPolicy.findFirst({ where: { businessId, businessServiceId: service.id } })
      : null;
    const { rules, exceptions } = await laneAvailability(tx, businessId, staffMemberId, fromDay, toDay);
    const range: Interval = {
      start: new Date(`${addCalendarDays(fromDay, -1)}T00:00:00.000Z`),
      end: new Date(`${addCalendarDays(toDay, 2)}T00:00:00.000Z`),
    };
    const busy = (await laneOccupants(tx, businessId, staffMemberId, range)).map((o) =>
      occupiedRange(o.startsAt, o.endsAt, o.bufferBeforeMinutes, o.bufferAfterMinutes));
    const slots = computeSlots({
      fromDay, toDay, durationMinutes: duration,
      bufferBeforeMinutes: policy?.bufferBeforeMinutes ?? 0, bufferAfterMinutes: policy?.bufferAfterMinutes ?? 0,
      slotStepMinutes: policy?.slotStepMinutes ?? 15, minLeadMinutes: policy?.minLeadMinutes ?? 0,
      maxAdvanceDays: policy?.maxAdvanceDays ?? 365, now, rules, exceptions, busy,
    });
    return { slots, durationMinutes: duration };
  });
}
