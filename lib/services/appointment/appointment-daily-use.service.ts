/**
 * Calendar daily use — the owner's search over appointments (G8) and multi-day closures / holiday closures (G7).
 * SERVER-ONLY. Every read and write is scoped by the session's business in its own WHERE and runs in tenantTx (RLS).
 *
 *   searchAppointments   name or phone (min 2 characters): the customer's name / phone, or the booking request's
 *                        contact name / phone; upcoming first (soonest first), then recent past (latest first), at
 *                        most 30; erased rows never appear.
 *   closeDayRange        one AvailabilityException per day, whole days, business or one staff member, one transaction,
 *                        at most 62 days; a day that already holds the same closure is skipped (repeat-safe).
 *   removeDayRange       marks every CLOSURE (whole or short day) of the scope in the range removed (kept as history);
 *                        a day with different hours (OPEN_HOURS) is left alone.
 *   applyHolidays        holiday ids from the static table (israeli-holidays.ts): holidays closed all day, eves closed
 *                        from the owner's closing time; dates are looked up here, never taken from the browser.
 * The writes never touch an appointment. They answer how many active appointments sit on the closed time, so the
 * owner is warned — nothing is cancelled. `dryRun` answers the same counts without writing (the preview).
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { jerusalemDayKey, jerusalemDayUtcHalfOpen, jerusalemInstantAt } from "@/lib/utils/jerusalem-day";

import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { AppointmentServiceError, invalid } from "./appointment-errors";
import { expandDayRange, holidayPlans, MAX_CLOSURE_DAYS, normalizeSearchQuery, SEARCH_MAX_RESULTS, type ClosurePlan } from "./calendar-daily-core";

type Tx = Prisma.TransactionClient;
const ACTIVE = ["PROPOSED", "CONFIRMED"] as const;
const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
const dayDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);

function staffScope(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "business") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!isPositiveInt(n)) throw invalid("staffMemberId");
  return n;
}

async function ownStaff(tx: Tx, businessId: number, id: number): Promise<void> {
  const s = await tx.staffMember.findFirst({ where: { id, businessId, erasedAt: null }, select: { id: true } });
  if (!s) throw new AppointmentServiceError("STAFF_NOT_FOUND");
}

function cleanLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > 80) throw invalid("label");
  return value.trim() || null;
}

// ── Search (G8) ─────────────────────────────────────────────────────────────────────────────────

export type SearchHit = {
  id: number;
  kind: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  staffMemberId: number | null;
  businessServiceId: number | null;
  customerId: number | null;
  customerName: string | null;
  title: string | null;
  upcoming: boolean;
};

export async function searchAppointments(principal: AppointmentPrincipal, input: { q?: unknown; now?: Date }): Promise<SearchHit[]> {
  authorizeAppointmentAction(principal, "appointment.read");
  const query = normalizeSearchQuery(input.q);
  if (!query) throw invalid("q");
  const now = input.now ?? new Date();
  const businessId = principal.businessId;

  return tenantTx(businessId, async (tx) => {
    const customerOr: Prisma.CustomerWhereInput[] = [{ name: { contains: query.text, mode: "insensitive" } }];
    if (query.digits) customerOr.push({ phone: { contains: query.digits } });
    const customers = await tx.customer.findMany({
      where: { businessId, OR: customerOr },
      select: { id: true, name: true },
      take: 200,
    });
    const requestOr: Prisma.BookingRequestWhereInput[] = [{ contactName: { contains: query.text, mode: "insensitive" } }];
    if (query.digits) requestOr.push({ contactPhone: { contains: query.digits } });
    const requests = await tx.bookingRequest.findMany({
      where: { businessId, erasedAt: null, OR: requestOr },
      select: { appointmentId: true },
      take: 200,
    });
    const customerIds = customers.map((c) => c.id);
    const appointmentIds = requests.map((r) => r.appointmentId).filter((id): id is number => typeof id === "number");
    if (customerIds.length === 0 && appointmentIds.length === 0) return [];

    const match: Prisma.AppointmentWhereInput = {
      businessId,
      erasedAt: null,
      startsAt: { not: null },
      OR: [
        ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
        ...(appointmentIds.length ? [{ id: { in: appointmentIds } }] : []),
      ],
    };
    const select = {
      id: true, kind: true, status: true, startsAt: true, endsAt: true, staffMemberId: true, businessServiceId: true,
      customerId: true, title: true,
    } as const;
    const upcoming = await tx.appointment.findMany({
      where: { ...match, startsAt: { gte: now } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: SEARCH_MAX_RESULTS,
      select,
    });
    const past = upcoming.length >= SEARCH_MAX_RESULTS ? [] : await tx.appointment.findMany({
      where: { ...match, startsAt: { lt: now } },
      orderBy: [{ startsAt: "desc" }, { id: "desc" }],
      take: SEARCH_MAX_RESULTS - upcoming.length,
      select,
    });
    const names = new Map(customers.map((c) => [c.id, c.name]));
    const missing = [...new Set([...upcoming, ...past].map((r) => r.customerId).filter((id): id is number => id !== null && !names.has(id)))];
    if (missing.length) {
      const more = await tx.customer.findMany({ where: { businessId, id: { in: missing } }, select: { id: true, name: true } });
      for (const c of more) names.set(c.id, c.name);
    }
    const hit = (r: (typeof upcoming)[number], isUpcoming: boolean): SearchHit => ({
      id: r.id, kind: r.kind, status: r.status,
      startsAt: r.startsAt ? r.startsAt.toISOString() : null, endsAt: r.endsAt ? r.endsAt.toISOString() : null,
      staffMemberId: r.staffMemberId, businessServiceId: r.businessServiceId, customerId: r.customerId,
      customerName: r.customerId !== null ? names.get(r.customerId) ?? null : null, title: r.title, upcoming: isUpcoming,
    });
    return [...upcoming.map((r) => hit(r, true)), ...past.map((r) => hit(r, false))];
  });
}

// ── Closures (G7) ───────────────────────────────────────────────────────────────────────────────


export type ClosureOutcome = {
  dryRun: boolean;
  /** Days that get a new closure (or would, on a dry run). */
  created: number;
  /** Days that already hold the same closure — left as they are. */
  skipped: number;
  /** Active appointments (not cancelled) on the closed time — a warning; none is cancelled. */
  appointmentsAffected: number;
  days: Array<{ dayKey: string; startMinute: number | null; endMinute: number | null; status: "created" | "exists"; appointments: number }>;
};

/** Active appointments of the scope that overlap the closed time of a day (the business scope = every lane). */
async function appointmentsOn(tx: Tx, businessId: number, staffMemberId: number | null, plan: ClosurePlan): Promise<number> {
  const day = jerusalemDayUtcHalfOpen(plan.dayKey);
  const from = plan.startMinute === null ? day.from : jerusalemInstantAt(plan.dayKey, Math.floor(plan.startMinute / 60), plan.startMinute % 60);
  return tx.appointment.count({
    where: {
      businessId,
      erasedAt: null,
      status: { in: [...ACTIVE] },
      kind: { not: "BLOCK" },
      startsAt: { lt: day.toExclusive },
      OR: [{ endsAt: { gt: from } }, { endsAt: null, startsAt: { gte: from } }],
      ...(staffMemberId === null ? {} : { staffMemberId }),
    },
  });
}

async function writeClosures(principal: AppointmentPrincipal, staffMemberId: number | null, plans: ClosurePlan[], dryRun: boolean): Promise<ClosureOutcome> {
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await ownStaff(tx, businessId, staffMemberId);
    const existing = await tx.availabilityException.findMany({
      where: {
        businessId, staffMemberId, removedAt: null, kind: "CLOSED",
        dayKey: { in: plans.map((p) => dayDate(p.dayKey)) },
      },
      select: { dayKey: true, startMinute: true, endMinute: true },
    });
    const same = (p: ClosurePlan) => existing.some((e) => dayKeyOf(e.dayKey) === p.dayKey && e.startMinute === p.startMinute && e.endMinute === p.endMinute);
    const out: ClosureOutcome = { dryRun, created: 0, skipped: 0, appointmentsAffected: 0, days: [] };
    for (const p of plans) {
      const exists = same(p);
      const appointments = await appointmentsOn(tx, businessId, staffMemberId, p);
      out.appointmentsAffected += appointments;
      if (exists) {
        out.skipped += 1;
      } else {
        out.created += 1;
        if (!dryRun) {
          await tx.availabilityException.create({
            data: { businessId, staffMemberId, dayKey: dayDate(p.dayKey), kind: "CLOSED", startMinute: p.startMinute, endMinute: p.endMinute, label: p.label },
          });
        }
      }
      out.days.push({ dayKey: p.dayKey, startMinute: p.startMinute, endMinute: p.endMinute, status: exists ? "exists" : "created", appointments });
    }
    return out;
  }, { timeoutMs: 15_000 });
}

export type CloseRangeInput = { staffMemberId?: unknown; fromDay?: unknown; toDay?: unknown; label?: unknown; dryRun?: unknown };

/** Whole days from–to (inclusive), closed for the business or one staff member — one row per day, one transaction. */
export async function closeDayRange(principal: AppointmentPrincipal, input: CloseRangeInput): Promise<ClosureOutcome> {
  authorizeAppointmentAction(principal, "availability.manage");
  const staffMemberId = staffScope(input.staffMemberId);
  const days = expandDayRange(input.fromDay, input.toDay, MAX_CLOSURE_DAYS);
  if (!days) throw invalid("toDay");
  const label = cleanLabel(input.label);
  const plans = days.map((dayKey) => ({ dayKey, startMinute: null, endMinute: null, label }));
  return writeClosures(principal, staffMemberId, plans, input.dryRun === true);
}

export type RemoveRangeInput = { staffMemberId?: unknown; fromDay?: unknown; toDay?: unknown; dryRun?: unknown };

/** Marks every closure (whole or short day) of the scope inside from–to removed (kept as history); different-hours days stay. */
export async function removeDayRange(principal: AppointmentPrincipal, input: RemoveRangeInput): Promise<{ dryRun: boolean; removed: number }> {
  authorizeAppointmentAction(principal, "availability.manage");
  const staffMemberId = staffScope(input.staffMemberId);
  const days = expandDayRange(input.fromDay, input.toDay, MAX_CLOSURE_DAYS);
  if (!days) throw invalid("toDay");
  const businessId = principal.businessId;
  const dryRun = input.dryRun === true;
  return tenantTx(businessId, async (tx) => {
    if (staffMemberId !== null) await ownStaff(tx, businessId, staffMemberId);
    // Only closures (whole days and short days, kind CLOSED) — a day with different hours (OPEN_HOURS) stays (owner, 2026-11-24).
    const where = { businessId, staffMemberId, removedAt: null, kind: "CLOSED" as const, dayKey: { gte: dayDate(days[0]), lte: dayDate(days[days.length - 1]) } };
    if (dryRun) return { dryRun, removed: await tx.availabilityException.count({ where }) };
    const r = await tx.availabilityException.updateMany({ where, data: { removedAt: new Date() } });
    return { dryRun, removed: r.count };
  });
}

export type ApplyHolidaysInput = { staffMemberId?: unknown; holidays?: unknown; eveClosingMinute?: unknown; dryRun?: unknown; today?: string };

export async function applyHolidays(principal: AppointmentPrincipal, input: ApplyHolidaysInput): Promise<ClosureOutcome> {
  authorizeAppointmentAction(principal, "availability.manage");
  const staffMemberId = staffScope(input.staffMemberId);
  const today = input.today ?? jerusalemDayKey(new Date());
  const plans = holidayPlans(input.holidays, input.eveClosingMinute, today);
  return writeClosures(principal, staffMemberId, plans, input.dryRun === true);
}
