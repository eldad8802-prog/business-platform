/**
 * Appointments — the calendar's configuration (milestone A). SERVER-ONLY.
 *
 *   staff members      employees WITHOUT a login: a name and a colour on the calendar. No user, no password, no
 *                      permission — access for staff is a later, separate decision made in Dubiz settings.
 *   assignments        which staff member performs which catalog service (and in how long, when it differs).
 *   weekly hours       per business or per staff member, in wall-clock minutes of the Israeli day.
 *   exceptions         a day closed, in whole or part, or opened with special hours.
 *   booking policy     per catalog service: buffers, notice, horizon, slot step, approval mode, windows.
 *
 * Nothing here deletes a row: staff are deactivated, rules / assignments / exceptions are marked removed (their
 * history stays). Replacing the weekly hours or a staff member's services is one PUT that states the whole set, so
 * repeating it changes nothing.
 */
import type { BookingApprovalMode, Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";

import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError, invalid } from "./appointment-errors";
import { isDayKey, isValidWindow, mergeWindows } from "./availability.core";

type Tx = Prisma.TransactionClient;
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const isIntIn = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const COLOR = /^#[0-9a-fA-F]{6}$/;

function name(value: unknown): string {
  if (typeof value !== "string") throw invalid("displayName");
  const t = value.trim();
  if (t.length === 0 || t.length > 80) throw invalid("displayName");
  return t;
}

function color(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !COLOR.test(value)) throw invalid("color");
  return value;
}

function staffScope(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "business") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!isPositiveInt(n)) throw invalid("staffMemberId");
  return n;
}

async function ownStaff(tx: Tx, businessId: number, id: number) {
  const s = await tx.staffMember.findFirst({ where: { id, businessId, erasedAt: null } });
  if (!s) throw new AppointmentServiceError("STAFF_NOT_FOUND");
  return s;
}

async function ownService(tx: Tx, businessId: number, id: number) {
  const s = await tx.businessService.findFirst({ where: { id, businessId }, select: { id: true, name: true, durationMinutes: true, active: true } });
  if (!s) throw new AppointmentServiceError("SERVICE_NOT_FOUND");
  return s;
}

// ── Staff ───────────────────────────────────────────────────────────────────────────────────────

export async function listStaff(principal: AppointmentPrincipal) {
  authorizeAppointmentAction(principal, "staff.read");
  return tenantTx(principal.businessId, async (tx) => {
    const staff = await tx.staffMember.findMany({
      where: { businessId: principal.businessId, erasedAt: null },
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    const assignments = await tx.staffServiceAssignment.findMany({
      where: { businessId: principal.businessId, removedAt: null },
      select: { staffMemberId: true, businessServiceId: true, durationOverrideMinutes: true },
    });
    return staff.map((s) => ({
      ...s,
      services: assignments.filter((a) => a.staffMemberId === s.id).map((a) => ({ businessServiceId: a.businessServiceId, durationOverrideMinutes: a.durationOverrideMinutes })),
    }));
  });
}

export async function createStaff(principal: AppointmentPrincipal, input: { displayName?: unknown; color?: unknown; sortOrder?: unknown }) {
  authorizeAppointmentAction(principal, "staff.manage");
  const displayName = name(input.displayName);
  const c = color(input.color);
  if (input.sortOrder !== undefined && !isIntIn(input.sortOrder, 0, 10000)) throw invalid("sortOrder");
  return tenantTx(principal.businessId, (tx) =>
    tx.staffMember.create({
      data: { businessId: principal.businessId, displayName, color: c, sortOrder: (input.sortOrder as number | undefined) ?? 0 },
    }),
  );
}

export async function updateStaff(
  principal: AppointmentPrincipal,
  id: number,
  input: { displayName?: unknown; color?: unknown; active?: unknown; sortOrder?: unknown; expectedVersion?: unknown },
) {
  authorizeAppointmentAction(principal, "staff.manage");
  const data: Prisma.StaffMemberUpdateInput = {};
  if (input.displayName !== undefined) data.displayName = name(input.displayName);
  if (input.color !== undefined) data.color = color(input.color);
  if (input.active !== undefined) {
    if (typeof input.active !== "boolean") throw invalid("active");
    data.active = input.active;
  }
  if (input.sortOrder !== undefined) {
    if (!isIntIn(input.sortOrder, 0, 10000)) throw invalid("sortOrder");
    data.sortOrder = input.sortOrder;
  }
  if (Object.keys(data).length === 0) throw invalid("fields");
  if (input.expectedVersion !== undefined && !isPositiveInt(input.expectedVersion)) throw invalid("expectedVersion");
  return tenantTx(principal.businessId, async (tx) => {
    const current = await ownStaff(tx, principal.businessId, id);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    }
    return tx.staffMember.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 } } });
  });
}

/** States the whole list of services a staff member performs; what is not listed is marked removed. */
export async function setStaffServices(principal: AppointmentPrincipal, staffMemberId: number, input: { services?: unknown }) {
  authorizeAppointmentAction(principal, "staff.manage");
  if (!Array.isArray(input.services) || input.services.length > 200) throw invalid("services");
  const wanted = new Map<number, number | null>();
  for (const s of input.services as Array<Record<string, unknown>>) {
    if (!s || typeof s !== "object" || !isPositiveInt(s.businessServiceId)) throw invalid("services");
    const d = s.durationOverrideMinutes;
    if (d !== undefined && d !== null && !isIntIn(d, 5, 1440)) throw invalid("durationOverrideMinutes");
    wanted.set(s.businessServiceId, (d as number | null | undefined) ?? null);
  }
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    await ownStaff(tx, businessId, staffMemberId);
    for (const serviceId of wanted.keys()) await ownService(tx, businessId, serviceId);
    const live = await tx.staffServiceAssignment.findMany({ where: { businessId, staffMemberId, removedAt: null } });
    const now = new Date();
    for (const a of live) {
      if (!wanted.has(a.businessServiceId)) {
        await tx.staffServiceAssignment.update({ where: { id: a.id }, data: { removedAt: now } });
      } else if (wanted.get(a.businessServiceId) !== a.durationOverrideMinutes) {
        await tx.staffServiceAssignment.update({ where: { id: a.id }, data: { durationOverrideMinutes: wanted.get(a.businessServiceId) ?? null } });
      }
    }
    for (const [serviceId, d] of wanted) {
      if (!live.some((a) => a.businessServiceId === serviceId)) {
        await tx.staffServiceAssignment.create({ data: { businessId, staffMemberId, businessServiceId: serviceId, durationOverrideMinutes: d } });
      }
    }
    return tx.staffServiceAssignment.findMany({
      where: { businessId, staffMemberId, removedAt: null },
      select: { businessServiceId: true, durationOverrideMinutes: true },
      orderBy: { businessServiceId: "asc" },
    });
  });
}

// ── Weekly hours and exceptions ─────────────────────────────────────────────────────────────────

const dayDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);

export async function getAvailability(principal: AppointmentPrincipal, input: { staffMemberId?: unknown; fromDay?: unknown }) {
  authorizeAppointmentAction(principal, "availability.read");
  const staffMemberId = staffScope(input.staffMemberId);
  const fromDay = input.fromDay === undefined ? null : input.fromDay;
  if (fromDay !== null && !isDayKey(fromDay)) throw invalid("fromDay");
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await ownStaff(tx, businessId, staffMemberId);
    const rules = await tx.availabilityRule.findMany({
      where: { businessId, staffMemberId, removedAt: null },
      orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
      select: { id: true, weekday: true, startMinute: true, endMinute: true, validFrom: true, validUntil: true },
    });
    const exceptions = await tx.availabilityException.findMany({
      where: { businessId, staffMemberId, removedAt: null, ...(fromDay ? { dayKey: { gte: dayDate(fromDay as string) } } : {}) },
      orderBy: [{ dayKey: "asc" }, { id: "asc" }],
      take: 500,
      select: { id: true, dayKey: true, kind: true, startMinute: true, endMinute: true, label: true },
    });
    return {
      staffMemberId,
      rules: rules.map((r) => ({ ...r, validFrom: r.validFrom ? dayKeyOf(r.validFrom) : null, validUntil: r.validUntil ? dayKeyOf(r.validUntil) : null })),
      exceptions: exceptions.map((e) => ({ ...e, dayKey: dayKeyOf(e.dayKey) })),
    };
  });
}

/** States the whole weekly schedule of one scope (the business, or one staff member); the previous set is removed. */
export async function replaceWeeklyRules(principal: AppointmentPrincipal, input: { staffMemberId?: unknown; rules?: unknown }) {
  authorizeAppointmentAction(principal, "availability.manage");
  const staffMemberId = staffScope(input.staffMemberId);
  if (!Array.isArray(input.rules) || input.rules.length > 70) throw invalid("rules");
  const byDay = new Map<number, { startMinute: number; endMinute: number }[]>();
  for (const r of input.rules as Array<Record<string, unknown>>) {
    if (!r || typeof r !== "object" || !isIntIn(r.weekday, 0, 6)) throw invalid("weekday");
    const w = { startMinute: r.startMinute as number, endMinute: r.endMinute as number };
    if (!isValidWindow(w)) throw invalid("window");
    byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), w]);
  }
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await ownStaff(tx, businessId, staffMemberId);
    await tx.availabilityRule.updateMany({ where: { businessId, staffMemberId, removedAt: null }, data: { removedAt: new Date() } });
    for (const [weekday, windows] of byDay) {
      for (const w of mergeWindows(windows)) {
        await tx.availabilityRule.create({ data: { businessId, staffMemberId, weekday, startMinute: w.startMinute, endMinute: w.endMinute } });
      }
    }
    return tx.availabilityRule.findMany({
      where: { businessId, staffMemberId, removedAt: null },
      orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
      select: { id: true, weekday: true, startMinute: true, endMinute: true },
    });
  });
}

export async function addException(
  principal: AppointmentPrincipal,
  input: { staffMemberId?: unknown; dayKey?: unknown; kind?: unknown; startMinute?: unknown; endMinute?: unknown; label?: unknown },
) {
  authorizeAppointmentAction(principal, "availability.manage");
  const staffMemberId = staffScope(input.staffMemberId);
  if (!isDayKey(input.dayKey)) throw invalid("dayKey");
  const kind = input.kind;
  if (kind !== "CLOSED" && kind !== "OPEN_HOURS") throw invalid("kind");
  const hasWindow = input.startMinute !== undefined && input.startMinute !== null;
  if (hasWindow !== (input.endMinute !== undefined && input.endMinute !== null)) throw invalid("window");
  if (hasWindow && !isValidWindow({ startMinute: input.startMinute as number, endMinute: input.endMinute as number })) throw invalid("window");
  if (kind === "OPEN_HOURS" && !hasWindow) throw invalid("window");
  let label: string | null = null;
  if (input.label !== undefined && input.label !== null) {
    if (typeof input.label !== "string" || input.label.trim().length > 80) throw invalid("label");
    label = input.label.trim() || null;
  }
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await ownStaff(tx, businessId, staffMemberId);
    return tx.availabilityException.create({
      data: {
        businessId, staffMemberId, dayKey: dayDate(input.dayKey as string), kind,
        startMinute: hasWindow ? (input.startMinute as number) : null, endMinute: hasWindow ? (input.endMinute as number) : null, label,
      },
    });
  });
}

/** Marks an exception removed (it stays as history). Removing a removed one changes nothing. */
export async function removeException(principal: AppointmentPrincipal, id: number) {
  authorizeAppointmentAction(principal, "availability.manage");
  return tenantTx(principal.businessId, async (tx) => {
    const ex = await tx.availabilityException.findFirst({ where: { id, businessId: principal.businessId } });
    if (!ex) throw new AppointmentServiceError("NOT_FOUND");
    if (ex.removedAt) return ex;
    return tx.availabilityException.update({ where: { id: ex.id }, data: { removedAt: new Date() } });
  });
}

// ── Booking policy per service ──────────────────────────────────────────────────────────────────

export const DEFAULT_POLICY = {
  publicBookable: false,
  approvalMode: "MANUAL" as BookingApprovalMode,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minLeadMinutes: 0,
  maxAdvanceDays: 60,
  slotStepMinutes: 15,
  cancelWindowHours: null as number | null,
  rescheduleWindowHours: null as number | null,
};

export async function getServicePolicy(principal: AppointmentPrincipal, businessServiceId: number) {
  authorizeAppointmentAction(principal, "policy.read");
  return tenantTx(principal.businessId, async (tx) => {
    await ownService(tx, principal.businessId, businessServiceId);
    const p = await tx.serviceBookingPolicy.findFirst({ where: { businessId: principal.businessId, businessServiceId } });
    return p ?? { ...DEFAULT_POLICY, businessServiceId, version: null, persisted: false };
  });
}

export async function upsertServicePolicy(principal: AppointmentPrincipal, businessServiceId: number, input: Record<string, unknown>) {
  authorizeAppointmentAction(principal, "policy.manage");
  const data: Record<string, unknown> = {};
  const int = (k: string, lo: number, hi: number, nullable = false) => {
    if (input[k] === undefined) return;
    if (nullable && input[k] === null) { data[k] = null; return; }
    if (!isIntIn(input[k], lo, hi)) throw invalid(k);
    data[k] = input[k];
  };
  if (input.publicBookable !== undefined) {
    if (typeof input.publicBookable !== "boolean") throw invalid("publicBookable");
    data.publicBookable = input.publicBookable;
  }
  if (input.approvalMode !== undefined) {
    if (input.approvalMode !== "MANUAL" && input.approvalMode !== "AUTO") throw invalid("approvalMode");
    data.approvalMode = input.approvalMode;
  }
  int("bufferBeforeMinutes", 0, 240);
  int("bufferAfterMinutes", 0, 240);
  int("minLeadMinutes", 0, 20160);
  int("maxAdvanceDays", 1, 365);
  int("slotStepMinutes", 5, 240);
  int("cancelWindowHours", 0, 720, true);
  int("rescheduleWindowHours", 0, 720, true);
  if (Object.keys(data).length === 0) throw invalid("fields");
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && !isPositiveInt(input.expectedVersion)) throw invalid("expectedVersion");
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    await ownService(tx, businessId, businessServiceId);
    const current = await tx.serviceBookingPolicy.findFirst({ where: { businessId, businessServiceId } });
    if (!current) {
      return tx.serviceBookingPolicy.create({ data: { ...(data as Partial<Prisma.ServiceBookingPolicyUncheckedCreateInput>), businessId, businessServiceId } });
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && current.version !== input.expectedVersion) {
      throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    }
    return tx.serviceBookingPolicy.update({ where: { id: current.id }, data: { ...(data as Prisma.ServiceBookingPolicyUpdateInput), version: { increment: 1 } } });
  });
}
