/**
 * Public booking (Milestone C, segment 1) — the doors a customer without a Dubiz account uses. SERVER-ONLY.
 *
 *   resolve      the opaque link id → its business, through booking_resolve_public (identifiers only), and ONLY while
 *                the business's link is enabled, `appointments` and `public_booking` are ON for it and no emergency
 *                switch is set. Every refusal is the same 404: nothing tells a caller why, or whether the id exists.
 *   profile      what the business chose to publish (D10): its name and its open services always; address, details,
 *                prices and staff display names only when switched on. Never a customer, never a staff contact.
 *   slots        free start times of a service, from the SAME engine the calendar uses, over the lanes the public may
 *                book: active staff the owner made public (D7) who perform the service — or the business's own lane
 *                when it has no staff at all.
 *   submit       a request, re-checked from scratch under the business's appointment lock: the start must be one of
 *                the free times computed NOW for an eligible lane (hours, exceptions, blocks, busy time, buffers,
 *                notice, horizon, step — no owner exception applies here), the per-phone cap (D11) holds, and the
 *                staff member is picked by the business's method (D8). The database's EXCLUDE constraint refuses an
 *                overlap even if this layer were bypassed. Idempotent on the caller's UUIDv7 key (the journal is the
 *                ledger, as for the owner). Manual services wait as PROPOSED holding their time (D3); automatic ones
 *                are CONFIRMED at once. No customer card is linked or created here (D6).
 *   manage       the customer's link: the request's state and, within the business's policy (D9), cancellation.
 *
 * The answer never depends on whether the phone belongs to a known customer.
 */
import type { Appointment, Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { recordOfferingDemand } from "@/lib/services/offering/offering-demand";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { resolveFeatureAccess } from "@/lib/services/feature-access/resolve-feature-access";
import { checkIdempotencyKey, digestKeysFromEnv, requestDigest, type RequestIdentity } from "@/lib/services/tasks/task-idempotency";
import { runWithTenantContext } from "@/lib/tenant/context";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { addCalendarDays, jerusalemDayKey, type JerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { transitionWithinTx } from "@/lib/services/appointment/appointment.service";
import type { ActorContext } from "@/lib/services/appointment/appointment.types";
import { AppointmentServiceError, invalid } from "@/lib/services/appointment/appointment-errors";
import { appendAppointmentEvent, instantToken } from "@/lib/services/appointment/appointment-journal";
import { findPrior, isOverlapViolation, lockBusinessAppointments, type PreparedRequest } from "@/lib/services/appointment/appointment-request";
import { laneAvailability, laneOccupants } from "@/lib/services/appointment/appointment-schedule.service";
import { computeSlots, isDayKey, MAX_SLOT_RANGE_DAYS, occupiedRange } from "@/lib/services/appointment/availability.core";

import {
  chooseStaff,
  effectiveOpenCap,
  manageLinkExpiry,
  MANAGE_TOKEN,
  newManageToken,
  parseContact,
  PUBLIC_ID,
  requestExpiry,
  requestFingerprint,
  selfCancel,
  sha256Hex,
  withinBusinessHours,
  type AssignmentMode,
} from "./booking.core";
import { notifyAutoConfirmed, notifyCustomerCancelled, notifyPending, resolveRequestNotification } from "./booking-notify";

type Tx = Prisma.TransactionClient;
const ACTIVE: Appointment["status"][] = ["PROPOSED", "CONFIRMED"];
export const PUBLIC_ROUTE = "PUBLIC POST /api/public/booking/requests";
const CUSTOMER: ActorContext = { actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" };

const notFound = () => new AppointmentServiceError("NOT_FOUND");

// ── The door ────────────────────────────────────────────────────────────────────────────────────

/** True when both flags are ON for the business and no emergency switch is set. Fail closed. */
export async function publicBookingOpen(businessId: number): Promise<boolean> {
  try {
    return await runWithTenantContext({ businessId }, async () => {
      const appts = await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.APPOINTMENTS);
      if (appts.allowed !== true) return false;
      const pub = await resolveFeatureAccess(businessId, PLATFORM_FEATURE_KEYS.PUBLIC_BOOKING);
      return pub.allowed === true;
    });
  } catch {
    return false;
  }
}

/** The link id → its business, or null (unknown, malformed, disabled, deleted business, or a flag OFF). */
export async function resolvePublicBusiness(publicId: unknown): Promise<number | null> {
  if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) return null;
  const rows = await prisma.$queryRaw<{ id: number }[]>`SELECT booking_resolve_public AS id FROM public.booking_resolve_public(${publicId})`;
  if (rows.length !== 1) return null;
  const businessId = Number(rows[0].id);
  return (await publicBookingOpen(businessId)) ? businessId : null;
}

async function requireBusiness(publicId: unknown): Promise<number> {
  const businessId = await resolvePublicBusiness(publicId);
  if (businessId === null) throw notFound();
  return businessId;
}

// ── What the public may see ─────────────────────────────────────────────────────────────────────

type Settings = NonNullable<Awaited<ReturnType<typeof loadSettings>>>;
async function loadSettings(tx: Tx, businessId: number) {
  return tx.bookingSettings.findUnique({ where: { businessId } });
}

/** The services open to the public, each with the lanes that may take it (ordered by the owner's order). */
async function publicCatalog(tx: Tx, businessId: number) {
  const policies = await tx.serviceBookingPolicy.findMany({ where: { businessId, publicBookable: true } });
  if (policies.length === 0) return { services: [], staff: [], noStaff: false };
  const services = await tx.businessService.findMany({
    where: { businessId, active: true, id: { in: policies.map((p) => p.businessServiceId) }, durationMinutes: { not: null, gte: 5, lte: 1440 } },
    select: { id: true, name: true, durationMinutes: true, priceMode: true, priceAmount: true, priceMax: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const allStaff = await tx.staffMember.findMany({
    where: { businessId, active: true, erasedAt: null },
    select: { id: true, displayName: true, color: true, sortOrder: true, publicBookable: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  const assignments = await tx.staffServiceAssignment.findMany({
    where: { businessId, removedAt: null, businessServiceId: { in: services.map((s) => s.id) } },
    select: { staffMemberId: true, businessServiceId: true, durationOverrideMinutes: true },
  });
  const noStaff = allStaff.length === 0;
  const publicStaff = allStaff.filter((s) => s.publicBookable);
  const out = services.map((svc) => {
    const policy = policies.find((p) => p.businessServiceId === svc.id)!;
    const named = assignments.filter((a) => a.businessServiceId === svc.id);
    // A service that names nobody is open to every (public) staff member — the calendar's own rule.
    const lanes: Array<{ staffMemberId: number | null; durationMinutes: number }> = noStaff
      ? [{ staffMemberId: null, durationMinutes: svc.durationMinutes as number }]
      : publicStaff
          .filter((s) => named.length === 0 || named.some((a) => a.staffMemberId === s.id))
          .map((s) => ({ staffMemberId: s.id, durationMinutes: named.find((a) => a.staffMemberId === s.id)?.durationOverrideMinutes ?? (svc.durationMinutes as number) }));
    return { ...svc, policy, lanes };
  });
  return { services: out.filter((s) => s.lanes.length > 0), staff: publicStaff, noStaff };
}

function price(svc: { priceMode: string | null; priceAmount: Prisma.Decimal | null; priceMax: Prisma.Decimal | null }) {
  if (!svc.priceMode || svc.priceAmount === null) return null;
  return { mode: svc.priceMode, amount: Number(svc.priceAmount), max: svc.priceMax === null ? null : Number(svc.priceMax), currency: "ILS" };
}

export async function getPublicProfile(publicId: unknown) {
  const businessId = await requireBusiness(publicId);
  return tenantTx(businessId, async (tx) => {
    const settings = (await loadSettings(tx, businessId)) as Settings;
    const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true } });
    const profile = settings.showAddress || settings.showBusinessDetails
      ? await tx.businessProfile.findFirst({ where: { businessId }, select: { city: true, billingAddress: true, billingPhone: true, category: true, subCategory: true } })
      : null;
    const catalog = await publicCatalog(tx, businessId);
    return {
      business: {
        name: business?.name ?? "",
        ...(settings.showAddress ? { city: profile?.city ?? null, address: profile?.billingAddress ?? null } : {}),
        ...(settings.showBusinessDetails ? { category: profile?.subCategory ?? profile?.category ?? null, phone: profile?.billingPhone ?? null } : {}),
      },
      staffChoice: catalog.noStaff ? "NONE" : settings.staffChoiceMode,
      selfCancel: { enabled: settings.selfCancelEnabled, windowHours: settings.selfCancelWindowHours },
      services: catalog.services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.durationMinutes,
        approval: s.policy.approvalMode,
        ...(settings.showPrices ? { price: price(s) } : {}),
        ...(settings.showStaffNames && !catalog.noStaff && settings.staffChoiceMode !== "NONE"
          ? { staff: s.lanes.map((l) => { const m = catalog.staff.find((x) => x.id === l.staffMemberId)!; return { id: m.id, name: m.displayName, color: m.color }; }) }
          : {}),
      })),
    };
  });
}

// ── Free times ─────────────────────────────────────────────────────────────────────────────────

type Lane = { staffMemberId: number | null; durationMinutes: number };

async function laneSlots(tx: Tx, businessId: number, lane: Lane, policy: { bufferBeforeMinutes: number; bufferAfterMinutes: number; slotStepMinutes: number; minLeadMinutes: number; maxAdvanceDays: number }, fromDay: JerusalemDayKey, toDay: JerusalemDayKey, now: Date) {
  const { rules, exceptions } = await laneAvailability(tx, businessId, lane.staffMemberId, fromDay, toDay);
  // A lane with no hours at all is never offered to the public (the owner's calendar may still book it).
  if (rules.length === 0 && exceptions.every((e) => e.kind !== "OPEN_HOURS")) return [];
  const range = { start: new Date(`${addCalendarDays(fromDay, -1)}T00:00:00.000Z`), end: new Date(`${addCalendarDays(toDay, 2)}T00:00:00.000Z`) };
  const busy = (await laneOccupants(tx, businessId, lane.staffMemberId, range)).map((o) =>
    occupiedRange(o.startsAt, o.endsAt, o.bufferBeforeMinutes, o.bufferAfterMinutes));
  const slots = computeSlots({
    fromDay, toDay, durationMinutes: lane.durationMinutes,
    bufferBeforeMinutes: policy.bufferBeforeMinutes, bufferAfterMinutes: policy.bufferAfterMinutes,
    slotStepMinutes: policy.slotStepMinutes, minLeadMinutes: policy.minLeadMinutes, maxAdvanceDays: policy.maxAdvanceDays,
    now, rules, exceptions, busy,
  });
  // The business lane's hours are the business's. A staff member's lane may run on own hours (they stand in for the
  // business hours on the owner's calendar); on the link they may only narrow the business's own windows (owner
  // decision 2026-10-28). This one place serves the free times, the server's re-check on submit, and "any staff".
  if (lane.staffMemberId === null) return slots;
  const business = await laneAvailability(tx, businessId, null, fromDay, toDay);
  return slots.filter((s) => withinBusinessHours(s, business));
}

function pickService(catalog: Awaited<ReturnType<typeof publicCatalog>>, serviceId: unknown) {
  if (typeof serviceId !== "number" || !Number.isInteger(serviceId) || serviceId <= 0) throw invalid("serviceId");
  const svc = catalog.services.find((s) => s.id === serviceId);
  if (!svc) throw notFound();
  return svc;
}

function pickLanes(svc: { lanes: Lane[] }, settings: Settings, noStaff: boolean, staffId: unknown): Lane[] {
  if (staffId === undefined || staffId === null) {
    if (!noStaff && settings.staffChoiceMode === "REQUIRED") throw invalid("staffId");
    return svc.lanes;
  }
  if (noStaff || settings.staffChoiceMode === "NONE") throw invalid("staffId");
  if (typeof staffId !== "number" || !Number.isInteger(staffId)) throw invalid("staffId");
  const lane = svc.lanes.find((l) => l.staffMemberId === staffId);
  if (!lane) throw notFound();
  return [lane];
}

export async function getPublicSlots(publicId: unknown, input: { serviceId?: unknown; staffId?: unknown; fromDay?: unknown; toDay?: unknown; now?: Date }) {
  const businessId = await requireBusiness(publicId);
  if (!isDayKey(input.fromDay)) throw invalid("fromDay");
  if (!isDayKey(input.toDay)) throw invalid("toDay");
  const fromDay = input.fromDay;
  const toDay = input.toDay;
  if (toDay < fromDay || addCalendarDays(fromDay, MAX_SLOT_RANGE_DAYS - 1) < toDay) throw invalid("toDay");
  const now = input.now ?? new Date();
  return tenantTx(businessId, async (tx) => {
    const settings = (await loadSettings(tx, businessId)) as Settings;
    const catalog = await publicCatalog(tx, businessId);
    const svc = pickService(catalog, input.serviceId);
    const lanes = pickLanes(svc, settings, catalog.noStaff, input.staffId);
    const starts = new Set<string>();
    for (const lane of lanes) {
      for (const s of await laneSlots(tx, businessId, lane, svc.policy, fromDay, toDay, now)) starts.add(s.startsAt.toISOString());
    }
    return { durationMinutes: svc.durationMinutes, slots: [...starts].sort().map((startsAt) => ({ startsAt })) };
  });
}

// ── Submit ─────────────────────────────────────────────────────────────────────────────────────

export type SubmitInput = { serviceId?: unknown; staffId?: unknown; startsAt?: unknown; name?: unknown; phone?: unknown; note?: unknown; website?: unknown };
export type SubmitResult = {
  status: "PENDING" | "CONFIRMED";
  replayed: boolean;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  staffName: string | null;
  expiresAt: string | null;
  manageToken: string;
  selfCancelUntil: string | null;
};

const whenLabel = (d: Date) =>
  new Intl.DateTimeFormat("he-IL", { weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jerusalem" }).format(d);

/** Expire the business's pending requests that lapsed (D3) — inside the caller's locked transaction. */
export async function expireDueRequests(tx: Tx, businessId: number, now: Date): Promise<number[]> {
  const due = await tx.bookingRequest.findMany({ where: { businessId, status: "PENDING", expiresAt: { lte: now } }, select: { id: true, appointmentId: true } });
  const done: number[] = [];
  for (const r of due) {
    const appt = await tx.appointment.findFirst({ where: { id: r.appointmentId, businessId } });
    if (appt && appt.status === "PROPOSED") {
      const t = await transitionWithinTx(tx, appt, "CANCELED", { actor: "SYSTEM", userId: null, sourceChannel: "PUBLIC_BOOKING" }, {
        cancelReason: "EXPIRED", journalKey: `system:expire:${r.id}`, now,
      });
      if (!t.ok) continue;
    }
    await tx.bookingRequest.update({ where: { id: r.id }, data: { status: "EXPIRED", decidedAt: now } });
    await resolveRequestNotification(tx, businessId, r.id, now);
    done.push(r.id);
  }
  return done;
}

/** D8 "balanced": the staff member's active appointments (not blocks) on that Israeli day. */
async function dayLoad(tx: Tx, businessId: number, staffMemberId: number, day: JerusalemDayKey): Promise<number> {
  const rows = await tx.appointment.findMany({
    where: {
      businessId, staffMemberId, status: { in: ACTIVE }, kind: { not: "BLOCK" },
      startsAt: { gte: new Date(`${addCalendarDays(day, -1)}T12:00:00.000Z`), lt: new Date(`${addCalendarDays(day, 1)}T12:00:00.000Z`) },
    },
    select: { startsAt: true },
  });
  return rows.filter((r) => r.startsAt && jerusalemDayKey(r.startsAt) === day).length;
}

async function issueManageToken(tx: Tx, businessId: number, appointmentId: number, startsAt: Date, now: Date): Promise<string> {
  // A replay (or a second issue) supersedes the earlier link of this appointment.
  await tx.appointmentManageToken.updateMany({ where: { businessId, appointmentId, revokedAt: null }, data: { revokedAt: now } });
  const token = newManageToken();
  await tx.appointmentManageToken.create({
    data: { businessId, appointmentId, tokenHash: sha256Hex(token), expiresAt: manageLinkExpiry(now, startsAt), createdAt: now },
  });
  return token;
}

async function describe(tx: Tx, businessId: number, appointmentId: number, settings: Settings, now: Date, token: string, replayed: boolean): Promise<SubmitResult> {
  const appt = await tx.appointment.findFirst({ where: { id: appointmentId, businessId } });
  const req = await tx.bookingRequest.findFirst({ where: { businessId, appointmentId } });
  if (!appt || !req || !appt.startsAt || !appt.endsAt) throw new AppointmentServiceError("CONFLICT");
  const service = appt.businessServiceId ? await tx.businessService.findFirst({ where: { id: appt.businessServiceId, businessId }, select: { name: true } }) : null;
  const staff = appt.staffMemberId && settings.showStaffNames ? await tx.staffMember.findFirst({ where: { id: appt.staffMemberId, businessId }, select: { displayName: true } }) : null;
  const cancel = selfCancel({ enabled: settings.selfCancelEnabled, windowHours: settings.selfCancelWindowHours }, appt.startsAt, now);
  return {
    status: appt.status === "CONFIRMED" ? "CONFIRMED" : "PENDING",
    replayed,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    serviceName: service?.name ?? appt.title ?? "",
    staffName: staff?.displayName ?? null,
    expiresAt: req.status === "PENDING" ? req.expiresAt.toISOString() : null,
    manageToken: token,
    selfCancelUntil: cancel.allowed && cancel.until ? cancel.until.toISOString() : null,
  };
}

/**
 * A customer's request. `key` is the Idempotency-Key (UUIDv7); a repeat of the same request returns the same
 * booking with a fresh manage link (the earlier link is revoked — only the hash was ever stored).
 */
export async function submitPublicRequest(
  publicId: unknown, input: SubmitInput, key: string, nowIn?: Date,
  opts: { beforeWrite?: (businessId: number) => Promise<void> } = {},
): Promise<SubmitResult> {
  const businessId = await requireBusiness(publicId);
  // The per-business ceiling (D11) — known only once the link has resolved.
  await opts.beforeWrite?.(businessId);
  const now = nowIn ?? new Date();
  // A filled honeypot is refused like any malformed request (no hint that it was noticed).
  if (input.website !== undefined && input.website !== null && input.website !== "") throw invalid("request");
  const parsed = parseContact(input);
  if (!parsed.ok) throw invalid(parsed.field);
  const contact = parsed.contact;
  if (typeof input.startsAt !== "string" || input.startsAt.length > 40) throw invalid("startsAt");
  const startsAt = new Date(input.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw invalid("startsAt");
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new AppointmentServiceError("IDEMPOTENCY_KEY_INVALID");

  const body = { serviceId: input.serviceId ?? null, staffId: input.staffId ?? null, startsAt: startsAt.toISOString(), name: contact.name, phone: contact.phone, note: contact.note };
  const keys = digestKeysFromEnv();
  const ident: RequestIdentity = { route: PUBLIC_ROUTE, businessId, userId: 0, body };
  const prepared: PreparedRequest = { key, now, keys, ident, digest: { value: requestDigest(keys.current, ident), keyId: keys.current.id } };

  const attempt = () => tenantTx(businessId, async (tx) => {
    await lockBusinessAppointments(tx, businessId);
    const settings = (await loadSettings(tx, businessId)) as Settings;
    const prior = await findPrior(tx, businessId, prepared);
    if (prior !== null) {
      const appt = await tx.appointment.findFirst({ where: { id: prior, businessId } });
      const token = await issueManageToken(tx, businessId, prior, appt?.startsAt ?? now, now);
      return describe(tx, businessId, prior, settings, now, token, true);
    }
    const verdict = checkIdempotencyKey(key, now);
    if (!verdict.ok) throw new AppointmentServiceError(verdict.code);

    // Lapsed requests release their time before anything is checked (the sweeper may not have run yet).
    await expireDueRequests(tx, businessId, now);

    const open = await tx.bookingRequest.count({ where: { businessId, status: "PENDING", contactPhone: contact.phone } });
    if (open >= effectiveOpenCap(settings.maxOpenRequestsPerPhone)) throw new AppointmentServiceError("REQUEST_LIMIT");

    const catalog = await publicCatalog(tx, businessId);
    const svc = pickService(catalog, input.serviceId);
    const lanes = pickLanes(svc, settings, catalog.noStaff, input.staffId);
    const day = jerusalemDayKey(startsAt);
    const free: Lane[] = [];
    for (const lane of lanes) {
      const slots = await laneSlots(tx, businessId, lane, svc.policy, day, day, now);
      if (slots.some((s) => s.startsAt.getTime() === startsAt.getTime())) free.push(lane);
    }
    if (free.length === 0) throw new AppointmentServiceError("SLOT_UNAVAILABLE");

    let lane = free[0];
    if (free.length > 1) {
      const candidates = await Promise.all(free.map(async (l) => ({
        id: l.staffMemberId as number,
        sortOrder: catalog.staff.find((s) => s.id === l.staffMemberId)?.sortOrder ?? 0,
        dayLoad: await dayLoad(tx, businessId, l.staffMemberId as number, day),
      })));
      const chosen = chooseStaff(candidates, settings.assignmentMode as AssignmentMode);
      lane = free.find((l) => l.staffMemberId === chosen) ?? free[0];
    }

    const auto = svc.policy.approvalMode === "AUTO";
    const endsAt = new Date(startsAt.getTime() + lane.durationMinutes * 60_000);
    const expiresAt = requestExpiry(now, startsAt, settings.pendingTtlMinutes);
    const appt = await tx.appointment.create({
      data: {
        businessId, kind: "CUSTOMER", status: auto ? "CONFIRMED" : "PROPOSED",
        startsAt, endsAt, durationMinutes: lane.durationMinutes, title: svc.name,
        createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING", createdByUserId: null,
        businessServiceId: svc.id, staffMemberId: lane.staffMemberId,
        bufferBeforeMinutes: svc.policy.bufferBeforeMinutes, bufferAfterMinutes: svc.policy.bufferAfterMinutes,
        holdExpiresAt: auto ? null : expiresAt,
      },
    });
    const request = await tx.bookingRequest.create({
      data: {
        businessId, appointmentId: appt.id, status: auto ? "APPROVED" : "PENDING",
        contactName: contact.name, contactPhone: contact.phone, customerNote: contact.note,
        fingerprint: requestFingerprint(businessId, key), expiresAt,
        decidedAt: auto ? now : null,
      },
    });
    const signal = await recordOfferingDemand(tx, {
      businessId, kind: "SERVICE", offeringId: svc.id, signalType: "BOOKING", source: "APPOINTMENT",
      appointmentId: appt.id, idempotencyKey: `booking:appointment:${appt.id}`,
    });
    if (!signal) throw new Error("booking evidence was not written");
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: appt.id, eventType: "APPOINTMENT_CREATED", ctx: CUSTOMER, idempotencyKey: key, digest: prepared.digest,
      payload: { kind: "CUSTOMER", status: appt.status, timed: true, startsAt: instantToken(startsAt), endsAt: instantToken(endsAt), staffMemberId: lane.staffMemberId, businessServiceId: svc.id, channel: "PUBLIC_BOOKING", requestId: request.id },
    });
    const facts = { requestId: request.id, contactName: contact.name, serviceName: svc.name, when: whenLabel(startsAt) };
    if (auto) await notifyAutoConfirmed(tx, businessId, facts, now);
    else await notifyPending(tx, businessId, facts, now);
    const token = await issueManageToken(tx, businessId, appt.id, startsAt, now);
    return describe(tx, businessId, appt.id, settings, now, token, false);
  }, { timeoutMs: 15_000 });

  try {
    return await attempt();
  } catch (e) {
    if (isOverlapViolation(e)) throw new AppointmentServiceError("SLOT_UNAVAILABLE", { source: "database" });
    if ((e as { code?: string })?.code !== "P2002") throw e;
    try {
      return await attempt();
    } catch (e2) {
      if (isOverlapViolation(e2)) throw new AppointmentServiceError("SLOT_UNAVAILABLE", { source: "database" });
      throw e2;
    }
  }
}

// ── The customer's link ────────────────────────────────────────────────────────────────────────

async function resolveToken(token: unknown): Promise<{ businessId: number; hash: string } | null> {
  if (typeof token !== "string" || !MANAGE_TOKEN.test(token)) return null;
  const hash = sha256Hex(token);
  const rows = await prisma.$queryRaw<{ id: number }[]>`SELECT booking_resolve_manage_token AS id FROM public.booking_resolve_manage_token(${hash})`;
  if (rows.length !== 1) return null;
  const businessId = Number(rows[0].id);
  // The link keeps working only while the business still offers public booking (the kill switch closes it too).
  return (await publicBookingOpen(businessId)) ? { businessId, hash } : null;
}

export type ManageView = {
  state: "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  startsAt: string | null;
  serviceName: string;
  staffName: string | null;
  businessName: string;
  expiresAt: string | null;
  canCancel: boolean;
  cancelUntil: string | null;
};

async function manageView(tx: Tx, businessId: number, hash: string, now: Date) {
  const t = await tx.appointmentManageToken.findFirst({ where: { businessId, tokenHash: hash, revokedAt: null, expiresAt: { gt: now } } });
  if (!t) throw notFound();
  const appt = await tx.appointment.findFirst({ where: { id: t.appointmentId, businessId } });
  const req = await tx.bookingRequest.findFirst({ where: { businessId, appointmentId: t.appointmentId } });
  if (!appt || !req) throw notFound();
  const settings = (await loadSettings(tx, businessId)) as Settings;
  const service = appt.businessServiceId ? await tx.businessService.findFirst({ where: { id: appt.businessServiceId, businessId }, select: { name: true } }) : null;
  const staff = appt.staffMemberId && settings.showStaffNames ? await tx.staffMember.findFirst({ where: { id: appt.staffMemberId, businessId }, select: { displayName: true } }) : null;
  const business = await tx.business.findFirst({ where: { id: businessId }, select: { name: true } });
  const state: ManageView["state"] =
    req.status === "DECLINED" ? "DECLINED"
      : req.status === "EXPIRED" || (req.status === "PENDING" && req.expiresAt <= now) ? "EXPIRED"
        : req.status === "WITHDRAWN" ? "CANCELED"
          : appt.status === "PROPOSED" ? "PENDING"
            : appt.status;
  const live = state === "PENDING" || state === "CONFIRMED";
  const cancel = appt.startsAt ? selfCancel({ enabled: settings.selfCancelEnabled, windowHours: settings.selfCancelWindowHours }, appt.startsAt, now) : { allowed: false, until: null };
  // A pending request may always be withdrawn before it is decided; a confirmed one within the business's window.
  const canCancel = live && (state === "PENDING" || cancel.allowed);
  const view: ManageView = {
    state,
    startsAt: appt.startsAt?.toISOString() ?? null,
    serviceName: service?.name ?? appt.title ?? "",
    staffName: staff?.displayName ?? null,
    businessName: business?.name ?? "",
    expiresAt: state === "PENDING" ? req.expiresAt.toISOString() : null,
    canCancel,
    cancelUntil: state === "CONFIRMED" && cancel.until ? cancel.until.toISOString() : null,
  };
  return { view, appt, req };
}

export async function viewByToken(token: unknown, nowIn?: Date): Promise<ManageView> {
  const r = await resolveToken(token);
  if (!r) throw notFound();
  const now = nowIn ?? new Date();
  return tenantTx(r.businessId, async (tx) => (await manageView(tx, r.businessId, r.hash, now)).view);
}

/** The customer cancels (or withdraws a pending request). Idempotent: an already cancelled booking answers as is. */
export async function cancelByToken(token: unknown, nowIn?: Date): Promise<ManageView> {
  const r = await resolveToken(token);
  if (!r) throw notFound();
  const now = nowIn ?? new Date();
  return tenantTx(r.businessId, async (tx) => {
    await lockBusinessAppointments(tx, r.businessId);
    const { view, appt, req } = await manageView(tx, r.businessId, r.hash, now);
    if (view.state === "CANCELED") return view;
    if (!view.canCancel) throw new AppointmentServiceError("SELF_CANCEL_CLOSED");
    const t = await transitionWithinTx(tx, appt, "CANCELED", CUSTOMER, { cancelReason: "CUSTOMER_CANCELED", journalKey: `customer:cancel:${req.id}`, now });
    if (!t.ok) throw new AppointmentServiceError("INVALID_TRANSITION");
    if (req.status === "PENDING") await tx.bookingRequest.update({ where: { id: req.id }, data: { status: "WITHDRAWN", decidedAt: now } });
    await resolveRequestNotification(tx, r.businessId, req.id, now);
    await notifyCustomerCancelled(tx, r.businessId, { requestId: req.id, contactName: req.contactName, serviceName: view.serviceName, when: appt.startsAt ? whenLabel(appt.startsAt) : "" }, now);
    return (await manageView(tx, r.businessId, r.hash, now)).view;
  }, { timeoutMs: 15_000 });
}
