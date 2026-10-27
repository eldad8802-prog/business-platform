/**
 * Public booking — the owner's side (Milestone C, segment 2). SERVER-ONLY. Every call runs as the owner, in the owner's
 * business, behind the `appointments` flag (appointmentsRoute).
 *
 *   settings      the business's own choices (D2, D8–D11) and its link. The link id is generated the first time the
 *                 owner turns booking on and can be replaced (the old link stops at once). The platform's ceilings
 *                 (booking.core PLATFORM_LIMITS) and the public_booking flag are not the owner's: they are shown,
 *                 never edited here. Turning the business's switch off stops new requests immediately.
 *   staff         who the public may book (D7) and the order the owner prefers (D8, the staff order). Changing either
 *                 never touches an existing appointment.
 *   requests      pending requests (with the time left), confirmed ones whose customer is still to be linked (D6), and
 *                 the last day's decisions. A possible customer match is computed here, for the owner only.
 *   decide        approve / decline go through the calendar's own status change (changeStatus), which settles the
 *                 request in the same transaction (settleRequestForStatus) — one path, whatever screen it came from.
 *   link          the customer card, only by the owner's explicit choice (D6): an existing customer of the business, or a
 *                 new one from the request's name and phone. Never a merge.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";

import type { AppointmentPrincipal } from "@/lib/services/appointment/appointment-authorization";
import { authorizeAppointmentAction } from "@/lib/services/appointment/appointment-authorization";
import { AppointmentServiceError, invalid } from "@/lib/services/appointment/appointment-errors";
import { appendAppointmentEvent } from "@/lib/services/appointment/appointment-journal";
import { lockBusinessAppointments } from "@/lib/services/appointment/appointment-request";
import { changeStatus, ownerActor, type AppointmentWriteResult } from "@/lib/services/appointment/appointment-schedule.service";
import type { OwnerRequest } from "@/lib/services/appointment/appointment-request";

import { newPublicId, PLATFORM_LIMITS, DEFAULT_PENDING_TTL_MINUTES } from "./booking.core";
import { publicBookingOpen } from "./public-booking.service";
import { resolveRequestNotification } from "./booking-notify";

type Tx = Prisma.TransactionClient;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

export const BOOKING_PATH = "/book/";

// ── Settings ───────────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: false, publicId: null as string | null, defaultApprovalMode: "MANUAL" as const, pendingTtlMinutes: DEFAULT_PENDING_TTL_MINUTES,
  staffChoiceMode: "OPTIONAL" as const, assignmentMode: "BALANCED" as const, selfCancelEnabled: true, selfCancelWindowHours: 24,
  maxOpenRequestsPerPhone: PLATFORM_LIMITS.maxOpenRequestsPerPhone, showAddress: false, showBusinessDetails: false, showPrices: false,
  showStaffNames: true, version: 0,
};

export async function getBookingSettings(principal: AppointmentPrincipal) {
  authorizeAppointmentAction(principal, "policy.read");
  const businessId = principal.businessId;
  const platformOpen = await publicBookingOpen(businessId);
  return tenantTx(businessId, async (tx) => {
    const row = await tx.bookingSettings.findUnique({ where: { businessId } });
    const s = row ?? DEFAULTS;
    const services = await tx.businessService.findMany({
      where: { businessId, active: true },
      select: { id: true, name: true, durationMinutes: true, priceMode: true, priceAmount: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const policies = await tx.serviceBookingPolicy.findMany({ where: { businessId }, select: { businessServiceId: true, publicBookable: true, approvalMode: true, version: true } });
    const staff = await tx.staffMember.findMany({
      where: { businessId, erasedAt: null },
      select: { id: true, displayName: true, color: true, active: true, sortOrder: true, publicBookable: true, version: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });
    const assignments = await tx.staffServiceAssignment.findMany({ where: { businessId, removedAt: null }, select: { staffMemberId: true, businessServiceId: true } });
    return {
      settings: {
        enabled: s.enabled, publicId: s.publicId, linkPath: s.publicId ? `${BOOKING_PATH}${s.publicId}` : null,
        defaultApprovalMode: s.defaultApprovalMode, staffChoiceMode: s.staffChoiceMode, assignmentMode: s.assignmentMode,
        selfCancelEnabled: s.selfCancelEnabled, selfCancelWindowHours: s.selfCancelWindowHours,
        maxOpenRequestsPerPhone: s.maxOpenRequestsPerPhone, pendingTtlMinutes: s.pendingTtlMinutes,
        showAddress: s.showAddress, showBusinessDetails: s.showBusinessDetails, showPrices: s.showPrices, showStaffNames: s.showStaffNames,
        version: row ? row.version : null,
      },
      platform: { open: platformOpen, limits: PLATFORM_LIMITS },
      services: services.map((x) => {
        const p = policies.find((y) => y.businessServiceId === x.id);
        return {
          id: x.id, name: x.name, durationMinutes: x.durationMinutes, hasPrice: x.priceMode !== null && x.priceAmount !== null,
          publicBookable: p?.publicBookable ?? false, approvalMode: p?.approvalMode ?? s.defaultApprovalMode, policyVersion: p?.version ?? null,
        };
      }),
      staff: staff.map((m) => ({ ...m, serviceIds: assignments.filter((a) => a.staffMemberId === m.id).map((a) => a.businessServiceId) })),
    };
  });
}

export type BookingSettingsInput = Record<string, unknown> & { expectedVersion?: unknown };

export async function updateBookingSettings(principal: AppointmentPrincipal, input: BookingSettingsInput) {
  authorizeAppointmentAction(principal, "policy.manage");
  const data: Record<string, unknown> = {};
  const bool = (k: string) => { if (input[k] === undefined) return; if (!isBool(input[k])) throw invalid(k); data[k] = input[k]; };
  bool("enabled"); bool("selfCancelEnabled"); bool("showAddress"); bool("showBusinessDetails"); bool("showPrices"); bool("showStaffNames");
  if (input.defaultApprovalMode !== undefined) {
    if (input.defaultApprovalMode !== "MANUAL" && input.defaultApprovalMode !== "AUTO") throw invalid("defaultApprovalMode");
    data.defaultApprovalMode = input.defaultApprovalMode;
  }
  if (input.staffChoiceMode !== undefined) {
    if (!["NONE", "OPTIONAL", "REQUIRED"].includes(input.staffChoiceMode as string)) throw invalid("staffChoiceMode");
    data.staffChoiceMode = input.staffChoiceMode;
  }
  if (input.assignmentMode !== undefined) {
    if (input.assignmentMode !== "BALANCED" && input.assignmentMode !== "PRIORITY") throw invalid("assignmentMode");
    data.assignmentMode = input.assignmentMode;
  }
  if (input.selfCancelWindowHours !== undefined) {
    if (!isIntIn(input.selfCancelWindowHours, 0, 720)) throw invalid("selfCancelWindowHours");
    data.selfCancelWindowHours = input.selfCancelWindowHours;
  }
  if (input.maxOpenRequestsPerPhone !== undefined) {
    // The owner may only be stricter than the platform (D11).
    if (!isIntIn(input.maxOpenRequestsPerPhone, 1, PLATFORM_LIMITS.maxOpenRequestsPerPhone)) throw invalid("maxOpenRequestsPerPhone");
    data.maxOpenRequestsPerPhone = input.maxOpenRequestsPerPhone;
  }
  if (Object.keys(data).length === 0) throw invalid("fields");
  const expectedVersion = input.expectedVersion;
  if (expectedVersion !== undefined && expectedVersion !== null && !isIntIn(expectedVersion, 1, Number.MAX_SAFE_INTEGER)) throw invalid("expectedVersion");
  const businessId = principal.businessId;
  await tenantTx(businessId, async (tx) => {
    const current = await tx.bookingSettings.findUnique({ where: { businessId } });
    if (current && expectedVersion !== undefined && expectedVersion !== null && current.version !== expectedVersion) {
      throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    }
    if (!current && expectedVersion !== undefined && expectedVersion !== null) throw new AppointmentServiceError("VERSION_CONFLICT", { version: null });
    // A link exists from the first time booking is turned on.
    const publicId = current?.publicId ?? (data.enabled === true ? newPublicId() : null);
    if (!current) {
      await tx.bookingSettings.create({ data: { businessId, ...DEFAULTS_FOR_CREATE, ...(data as object), publicId } as Prisma.BookingSettingsUncheckedCreateInput });
    } else {
      await tx.bookingSettings.update({ where: { businessId }, data: { ...(data as Prisma.BookingSettingsUpdateInput), publicId, version: { increment: 1 } } });
    }
  });
  return getBookingSettings(principal);
}

const DEFAULTS_FOR_CREATE = { staffChoiceMode: "OPTIONAL" as const };

/** A new link id; the old link stops working at once. */
export async function rotateBookingLink(principal: AppointmentPrincipal, input: { expectedVersion?: unknown }) {
  authorizeAppointmentAction(principal, "policy.manage");
  const businessId = principal.businessId;
  await tenantTx(businessId, async (tx) => {
    const current = await tx.bookingSettings.findUnique({ where: { businessId } });
    if (!current) throw new AppointmentServiceError("NOT_FOUND");
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: current.version });
    await tx.bookingSettings.update({ where: { businessId }, data: { publicId: newPublicId(), version: { increment: 1 } } });
  });
  return getBookingSettings(principal);
}

// ── Requests ───────────────────────────────────────────────────────────────────────────────────

export type RequestRow = {
  id: number;
  status: string;
  contactName: string;
  contactPhone: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  appointment: { id: number; version: number; status: string; startsAt: string | null; endsAt: string | null; staffMemberId: number | null; businessServiceId: number | null; customerId: number | null };
  serviceName: string | null;
  staffName: string | null;
  match: { customerId: number; name: string } | null;
};

export async function listBookingRequests(principal: AppointmentPrincipal, nowIn?: Date): Promise<{ pending: RequestRow[]; toLink: RequestRow[]; recent: RequestRow[] }> {
  authorizeAppointmentAction(principal, "appointment.read");
  const businessId = principal.businessId;
  const now = nowIn ?? new Date();
  return tenantTx(businessId, async (tx) => {
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const reqs = await tx.bookingRequest.findMany({
      where: { businessId, erasedAt: null, OR: [{ status: "PENDING" }, { status: "APPROVED" }, { decidedAt: { gte: since } }] },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: 300,
    });
    const appts = await tx.appointment.findMany({ where: { businessId, id: { in: reqs.map((r) => r.appointmentId) } } });
    const services = await tx.businessService.findMany({ where: { businessId, id: { in: appts.map((a) => a.businessServiceId).filter((x): x is number => x !== null) } }, select: { id: true, name: true } });
    const staff = await tx.staffMember.findMany({ where: { businessId, id: { in: appts.map((a) => a.staffMemberId).filter((x): x is number => x !== null) } }, select: { id: true, displayName: true } });
    const phones = [...new Set(reqs.map((r) => r.contactPhone).filter((p): p is string => !!p))];
    const customers = phones.length ? await tx.customer.findMany({ where: { businessId, phone: { in: phones } }, select: { id: true, name: true, phone: true } }) : [];
    const rows: RequestRow[] = reqs.flatMap((r) => {
      const a = appts.find((x) => x.id === r.appointmentId);
      if (!a) return [];
      const c = r.contactPhone ? customers.find((x) => x.phone === r.contactPhone) : undefined;
      return [{
        id: r.id,
        status: r.status === "PENDING" && r.expiresAt <= now ? "EXPIRED" : r.status,
        contactName: r.contactName, contactPhone: r.contactPhone, note: r.customerNote,
        createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
        appointment: {
          id: a.id, version: a.version, status: a.status, startsAt: a.startsAt?.toISOString() ?? null, endsAt: a.endsAt?.toISOString() ?? null,
          staffMemberId: a.staffMemberId, businessServiceId: a.businessServiceId, customerId: a.customerId,
        },
        serviceName: services.find((s) => s.id === a.businessServiceId)?.name ?? a.title,
        staffName: staff.find((s) => s.id === a.staffMemberId)?.displayName ?? null,
        // Only while the card is not linked, and only for the owner.
        match: a.customerId === null && c ? { customerId: c.id, name: c.name } : null,
      }];
    });
    return {
      pending: rows.filter((r) => r.status === "PENDING"),
      toLink: rows.filter((r) => r.status === "APPROVED" && r.appointment.customerId === null && (r.appointment.status === "CONFIRMED" || r.appointment.status === "PROPOSED")),
      recent: rows.filter((r) => r.status !== "PENDING" && r.decidedAt !== null && Date.parse(r.decidedAt) >= since.getTime()),
    };
  });
}

/** How many requests wait (for the calendar's tab badge). */
export async function countPendingRequests(principal: AppointmentPrincipal, nowIn?: Date): Promise<number> {
  authorizeAppointmentAction(principal, "appointment.read");
  const now = nowIn ?? new Date();
  return tenantTx(principal.businessId, (tx) => tx.bookingRequest.count({ where: { businessId: principal.businessId, status: "PENDING", expiresAt: { gt: now } } }));
}

async function ownRequest(tx: Tx, businessId: number, id: number) {
  const r = await tx.bookingRequest.findFirst({ where: { id, businessId } });
  if (!r) throw new AppointmentServiceError("NOT_FOUND");
  return r;
}

/** Approve or decline: the calendar's own status change, which settles the request (one path for every screen). */
export async function decideBookingRequest(principal: AppointmentPrincipal, req: OwnerRequest, id: number, input: { decision?: unknown; expectedVersion?: unknown }): Promise<AppointmentWriteResult> {
  if (!isIntIn(id, 1, Number.MAX_SAFE_INTEGER)) throw invalid("id");
  if (input.decision !== "approve" && input.decision !== "decline") throw invalid("decision");
  const appointmentId = await tenantTx(principal.businessId, async (tx) => (await ownRequest(tx, principal.businessId, id)).appointmentId);
  return changeStatus(principal, req, appointmentId, input.decision === "approve"
    ? { to: "CONFIRMED", expectedVersion: input.expectedVersion }
    : { to: "CANCELED", cancelReason: "DECLINED", expectedVersion: input.expectedVersion });
}

/** D6: link the request's appointment to a customer card — an existing one, or a new one from its name and phone. */
export async function linkBookingCustomer(principal: AppointmentPrincipal, id: number, input: { customerId?: unknown; create?: unknown; expectedVersion?: unknown }) {
  authorizeAppointmentAction(principal, "appointment.edit");
  if (!isIntIn(id, 1, Number.MAX_SAFE_INTEGER)) throw invalid("id");
  const create = input.create === true;
  if (!create && !isIntIn(input.customerId, 1, Number.MAX_SAFE_INTEGER)) throw invalid("customerId");
  if (input.expectedVersion !== undefined && !isIntIn(input.expectedVersion, 1, Number.MAX_SAFE_INTEGER)) throw invalid("expectedVersion");
  const businessId = principal.businessId;
  const actor = ownerActor(principal);
  return tenantTx(businessId, async (tx) => {
    await lockBusinessAppointments(tx, businessId);
    const r = await ownRequest(tx, businessId, id);
    const appt = await tx.appointment.findFirst({ where: { id: r.appointmentId, businessId } });
    if (!appt) throw new AppointmentServiceError("NOT_FOUND");
    if (input.expectedVersion !== undefined && appt.version !== input.expectedVersion) throw new AppointmentServiceError("VERSION_CONFLICT", { version: appt.version });
    if (appt.customerId !== null) throw new AppointmentServiceError("CONFLICT", { reason: "ALREADY_LINKED" });
    let customerId: number;
    if (create) {
      if (!r.contactPhone) throw invalid("phone");
      const existing = await tx.customer.findFirst({ where: { businessId, phone: r.contactPhone }, select: { id: true, name: true } });
      // Never a second card for a known phone (Customer is unique per business and phone): the owner picks the match.
      if (existing) throw new AppointmentServiceError("CONFLICT", { reason: "PHONE_EXISTS", customerId: existing.id });
      customerId = (await tx.customer.create({ data: { businessId, name: r.contactName, phone: r.contactPhone } })).id;
    } else {
      const c = await tx.customer.findFirst({ where: { id: input.customerId as number, businessId }, select: { id: true } });
      if (!c) throw new AppointmentServiceError("CUSTOMER_NOT_FOUND");
      customerId = c.id;
    }
    const updated = await tx.appointment.update({ where: { id: appt.id }, data: { customerId, version: { increment: 1 } } });
    await appendAppointmentEvent(tx, {
      businessId, appointmentId: appt.id, eventType: "APPOINTMENT_DETAILS_CHANGED", ctx: actor,
      payload: { fields: ["customerId"], customerLinked: true, customerCreated: create, requestId: r.id },
    });
    await resolveRequestNotification(tx, businessId, r.id, new Date());
    return { appointmentId: updated.id, customerId, version: updated.version };
  });
}

