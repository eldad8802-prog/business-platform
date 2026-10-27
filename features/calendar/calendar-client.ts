"use client";

/**
 * The browser side of the calendar (Appointments milestone B). Every call is an EXISTING route:
 *   /api/appointments/*            milestone A — behind the `appointments` flag (404 while it is OFF);
 *   /api/business/services         the catalog's services (name, default duration);
 *   /api/customers, /api/customers/[id]   search, create, a name;
 *   /api/leads?customerId=         the customer's open lead (decision 11: an appointment links to it, the lead's
 *                                  stage is never changed here).
 *
 * Every write carries an Idempotency-Key from the task client's `keyFor(intent)`: one key per intent until the
 * server answered OK, so a lost answer or a double tap never books twice.
 */
import { buildClientAuthHeaders } from "@/lib/client-session";
import { keyFor, settleKey } from "@/lib/tasks/tasks-client";

import type { AppointmentWire, HistoryWire, StaffWire } from "./calendar-model";

export class CalendarApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

async function call<T>(method: string, url: string, body?: unknown, key?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      headers: buildClientAuthHeaders(key ? { "Idempotency-Key": key } : undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new CalendarApiError(0, "NETWORK");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const details = json.details && typeof json.details === "object" ? (json.details as Record<string, unknown>) : {};
    throw new CalendarApiError(res.status, String(json.error ?? res.status), details);
  }
  return json as T;
}

async function write<T>(intent: string, method: string, url: string, body: unknown): Promise<T> {
  const out = await call<T>(method, url, body, keyFor(intent));
  settleKey(intent);
  return out;
}

/** A refused write must not keep its key: the next attempt is a NEW request (another body, after a fix). */
export function forgetIntent(intent: string): void {
  settleKey(intent);
}

export type WriteResult = { appointment: AppointmentWire; replayed?: boolean; warnings?: string[] };

// ── Appointments ────────────────────────────────────────────────────────────────────────────────

export function listAppointments(from: Date, to: Date, opts: { staffMemberId?: number | "none"; includeCanceled?: boolean } = {}) {
  const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (opts.staffMemberId !== undefined) q.set("staffMemberId", String(opts.staffMemberId));
  if (opts.includeCanceled) q.set("includeCanceled", "true");
  return call<{ appointments: AppointmentWire[] }>("GET", `/api/appointments?${q}`).then((r) => r.appointments);
}

export const getAppointment = (id: number) =>
  call<{ appointment: AppointmentWire; history: HistoryWire[] }>("GET", `/api/appointments/${id}`);

export type CreateInput = {
  kind: "CUSTOMER" | "INTERNAL" | "BLOCK";
  startsAt: string;
  durationMinutes?: number;
  endsAt?: string;
  staffMemberId?: number | null;
  businessServiceId?: number | null;
  customerId?: number | null;
  leadId?: number | null;
  title?: string | null;
  notes?: string | null;
  locationKind?: "IN_PERSON" | "PHONE" | "ONLINE" | null;
  locationDetail?: string | null;
  status?: "CONFIRMED" | "PROPOSED";
};

export const createAppointment = (intent: string, input: CreateInput) =>
  write<WriteResult>(intent, "POST", "/api/appointments", input);

export const moveAppointment = (
  intent: string,
  id: number,
  input: { startsAt: string; durationMinutes?: number; staffMemberId?: number | null; expectedVersion: number },
) => write<WriteResult>(intent, "POST", `/api/appointments/${id}/reschedule`, input);

export const changeStatus = (
  intent: string,
  id: number,
  input: { to: "CONFIRMED" | "COMPLETED" | "NO_SHOW" | "CANCELED"; cancelReason?: string | null; reason?: string | null; expectedVersion: number },
) => write<WriteResult>(intent, "POST", `/api/appointments/${id}/status`, input);

export const updateDetails = (
  intent: string,
  id: number,
  input: { title?: string | null; notes?: string | null; locationKind?: string | null; locationDetail?: string | null; expectedVersion: number },
) => write<WriteResult>(intent, "PATCH", `/api/appointments/${id}/details`, input);

export type SlotWire = { startsAt: string; endsAt: string };

export function findSlots(input: { fromDay: string; toDay: string; businessServiceId?: number | null; durationMinutes?: number; staffMemberId?: number | null }) {
  const q = new URLSearchParams({ fromDay: input.fromDay, toDay: input.toDay });
  if (input.businessServiceId) q.set("businessServiceId", String(input.businessServiceId));
  if (input.durationMinutes) q.set("durationMinutes", String(input.durationMinutes));
  if (input.staffMemberId) q.set("staffMemberId", String(input.staffMemberId));
  return call<{ slots: SlotWire[]; durationMinutes: number }>("GET", `/api/appointments/slots?${q}`);
}

// ── Staff, hours, policies ──────────────────────────────────────────────────────────────────────

export const listStaff = () => call<{ staff: StaffWire[] }>("GET", "/api/appointments/staff").then((r) => r.staff);

export const createStaff = (intent: string, input: { displayName: string; color?: string | null }) =>
  write<{ staffMember: StaffWire }>(intent, "POST", "/api/appointments/staff", input);

export const updateStaff = (
  intent: string,
  id: number,
  input: { displayName?: string; color?: string | null; active?: boolean; expectedVersion?: number },
) => write<{ staffMember: StaffWire }>(intent, "PATCH", `/api/appointments/staff/${id}`, input);

/**
 * The whole list of services one staff member performs. `expectedVersion` is the staff member's version as it was
 * read: when the list changed meanwhile the server answers VERSION_CONFLICT instead of overwriting it.
 */
export const setStaffServices = (
  intent: string,
  id: number,
  services: Array<{ businessServiceId: number; durationOverrideMinutes: number | null }>,
  expectedVersion?: number,
) => write<{ services: StaffWire["services"]; version: number }>(intent, "PUT", `/api/appointments/staff/${id}/services`, {
  services,
  ...(expectedVersion !== undefined ? { expectedVersion } : {}),
});

export type RuleWire = { id?: number; weekday: number; startMinute: number; endMinute: number };
export type ExceptionWire = { id: number; dayKey: string; kind: "CLOSED" | "OPEN_HOURS"; startMinute: number | null; endMinute: number | null; label: string | null };

export function getAvailability(staffMemberId: number | null, fromDay?: string) {
  const q = new URLSearchParams();
  if (staffMemberId !== null) q.set("staffMemberId", String(staffMemberId));
  if (fromDay) q.set("fromDay", fromDay);
  return call<{ staffMemberId: number | null; rules: RuleWire[]; exceptions: ExceptionWire[] }>("GET", `/api/appointments/availability?${q}`);
}

export const replaceWeeklyRules = (intent: string, staffMemberId: number | null, rules: RuleWire[]) =>
  write<{ rules: RuleWire[] }>(intent, "PUT", "/api/appointments/availability", {
    staffMemberId,
    rules: rules.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
  });

export const addException = (
  intent: string,
  input: { staffMemberId: number | null; dayKey: string; kind: "CLOSED" | "OPEN_HOURS"; startMinute?: number | null; endMinute?: number | null; label?: string | null },
) => write<{ exception: ExceptionWire }>(intent, "POST", "/api/appointments/availability/exceptions", input);

export const removeException = (intent: string, id: number) =>
  write<{ exception: ExceptionWire }>(intent, "DELETE", `/api/appointments/availability/exceptions/${id}`, undefined);

export type PolicyWire = {
  businessServiceId: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minLeadMinutes: number;
  maxAdvanceDays: number;
  slotStepMinutes: number;
  /** Milestone C: open on the public booking link, and how its requests are approved (D2). */
  publicBookable?: boolean;
  approvalMode?: "MANUAL" | "AUTO";
  version: number | null;
  persisted?: boolean;
};

export const getPolicy = (serviceId: number) =>
  call<{ policy: PolicyWire }>("GET", `/api/appointments/services/${serviceId}/policy`).then((r) => r.policy);

export const savePolicy = (intent: string, serviceId: number, input: Partial<Omit<PolicyWire, "businessServiceId" | "version" | "persisted">> & { expectedVersion?: number | null }) =>
  write<{ policy: PolicyWire }>(intent, "PUT", `/api/appointments/services/${serviceId}/policy`, input);

// ── The catalog, customers and leads (existing routes) ──────────────────────────────────────────

export type ServiceWire = { id: number; name: string; durationMinutes: number | null; active: boolean };

export async function listServices(): Promise<ServiceWire[]> {
  const r = await call<{ offerings: Array<{ kind: string; canonicalId: number; name: string; durationMinutes: number | null; active: boolean }> }>(
    "GET",
    "/api/business/services",
  );
  return r.offerings
    .filter((o) => o.kind === "SERVICE")
    .map((o) => ({ id: o.canonicalId, name: o.name, durationMinutes: o.durationMinutes, active: o.active }));
}

/**
 * A new catalog service (the existing POST /api/business/services): a name, a length and, when the owner gives one,
 * a fixed price; without a price it is listed with no public price.
 */
export async function createService(input: { name: string; durationMinutes: number | null; priceAmount?: number | null }): Promise<ServiceWire> {
  const r = await call<{ service: { id: number; name: string; durationMinutes: number | null; active: boolean } }>("POST", "/api/business/services", {
    name: input.name,
    durationMinutes: input.durationMinutes,
    ...(input.priceAmount !== undefined && input.priceAmount !== null
      ? { priceMode: "FIXED", priceAmount: input.priceAmount }
      : { priceMode: "NO_PUBLIC_PRICE" }),
  });
  return { id: r.service.id, name: r.service.name, durationMinutes: r.service.durationMinutes, active: r.service.active };
}

/** Edit a catalog service's name and length (PATCH /api/business/services/[id]); price and status stay as they are. */
export async function updateService(id: number, input: { name?: string; durationMinutes?: number | null }): Promise<ServiceWire> {
  const r = await call<{ service: { id: number; name: string; durationMinutes: number | null; active: boolean } }>("PATCH", `/api/business/services/${id}`, input);
  return { id: r.service.id, name: r.service.name, durationMinutes: r.service.durationMinutes, active: r.service.active };
}

export type CustomerWire = { id: number; name: string; phone: string | null };

export function searchCustomers(q: string, limit = 20) {
  const params = new URLSearchParams({ status: "active", limit: String(limit) });
  if (q.trim()) params.set("q", q.trim());
  return call<{ customers: CustomerWire[] }>("GET", `/api/customers?${params}`).then((r) => r.customers);
}

export function createCustomer(input: { name: string; phone?: string | null }) {
  return call<{ customer: CustomerWire }>("POST", "/api/customers", input).then((r) => r.customer);
}

/** One customer's name (the customer card's first section) — for an appointment outside the recent list. */
export function customerName(id: number) {
  return call<{ customer: CustomerWire }>("GET", `/api/customers/${id}`).then((r) => r.customer);
}

type LeadRow = { id: number; customer: { id: number } | null };

/**
 * The customer's open lead (decision 11): the leads inbox filtered by this customer — open leads only, by default —
 * newest activity first. None → no link (the appointment is booked either way). The row's own customer is checked
 * again, so nothing is ever linked to another customer's lead.
 */
export async function openLeadOf(customer: CustomerWire): Promise<number | null> {
  try {
    const r = await call<{ leads?: LeadRow[] }>("GET", `/api/leads?${new URLSearchParams({ customerId: String(customer.id), limit: "5" })}`);
    return (r.leads ?? []).find((l) => l.customer?.id === customer.id)?.id ?? null;
  } catch {
    return null;
  }
}

// ── Public booking — the owner's side (Milestone C) ─────────────────────────────────────────────────

export type BookingSettingsWire = {
  enabled: boolean;
  publicId: string | null;
  linkPath: string | null;
  defaultApprovalMode: "MANUAL" | "AUTO";
  staffChoiceMode: "NONE" | "OPTIONAL" | "REQUIRED";
  assignmentMode: "BALANCED" | "PRIORITY";
  selfCancelEnabled: boolean;
  selfCancelWindowHours: number;
  maxOpenRequestsPerPhone: number;
  pendingTtlMinutes: number;
  showAddress: boolean;
  showBusinessDetails: boolean;
  showPrices: boolean;
  showStaffNames: boolean;
  version: number | null;
};
export type BookingServiceWire = { id: number; name: string; durationMinutes: number | null; hasPrice: boolean; publicBookable: boolean; approvalMode: "MANUAL" | "AUTO"; policyVersion: number | null };
export type BookingStaffWire = { id: number; displayName: string; color: string | null; active: boolean; sortOrder: number; publicBookable: boolean; version: number; serviceIds: number[] };
export type BookingAdminWire = {
  settings: BookingSettingsWire;
  platform: { open: boolean; limits: { maxOpenRequestsPerPhone: number; submitPerIpPerMinute: number; submitPerIpPerHour: number; submitPerBusinessPerHour: number } };
  services: BookingServiceWire[];
  staff: BookingStaffWire[];
};

export const getBookingAdmin = () => call<BookingAdminWire>("GET", "/api/appointments/booking/settings");
export const saveBookingSettings = (patch: Partial<BookingSettingsWire> & { expectedVersion?: number | null }) =>
  call<BookingAdminWire>("PUT", "/api/appointments/booking/settings", patch);
export const rotateBookingLink = (expectedVersion: number | null) =>
  call<BookingAdminWire>("POST", "/api/appointments/booking/settings/link", expectedVersion === null ? {} : { expectedVersion });
export const setStaffPublic = (id: number, input: { publicBookable?: boolean; sortOrder?: number; expectedVersion: number }) =>
  call<{ staffMember: StaffWire }>("PATCH", `/api/appointments/staff/${id}`, input);

export type BookingRequestWire = {
  id: number;
  status: "PENDING" | "APPROVED" | "DECLINED" | "EXPIRED" | "WITHDRAWN";
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
export type BookingRequestsWire = { pending: BookingRequestWire[]; toLink: BookingRequestWire[]; recent: BookingRequestWire[] };

export const listBookingRequests = () => call<BookingRequestsWire>("GET", "/api/appointments/booking/requests");
export const pendingRequestCount = () => call<{ pending: number }>("GET", "/api/appointments/booking/requests?count=1");
export const decideRequest = (intent: string, id: number, decision: "approve" | "decline", expectedVersion: number) =>
  write<WriteResult>(intent, "POST", `/api/appointments/booking/requests/${id}`, { action: decision, expectedVersion });
export const linkRequestCustomer = (id: number, input: { customerId: number } | { create: true }, expectedVersion: number) =>
  call<{ appointmentId: number; customerId: number; version: number }>("POST", `/api/appointments/booking/requests/${id}`, { action: "link", ...input, expectedVersion });
