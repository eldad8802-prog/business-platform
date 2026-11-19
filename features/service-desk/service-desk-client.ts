/**
 * Browser calls for the Service Desk screens (UI 1.3a). Every call goes to an existing /api/service-desk route that
 * authenticates the user, resolves the business's Service Desk mode and scopes the query to the user's own business on
 * the server (serviceDeskRoute). The browser never sends a business id and never decides what is allowed: a refusal
 * comes back as { error, details } and is shown as it is.
 */
import { buildClientAuthHeaders } from "@/lib/client-session";
import { keyFor, settleKey } from "@/lib/tasks/tasks-client";

export type ServiceDeskMode = "FULL" | "READ_ONLY";
export type WarrantyUnit = "DAYS" | "MONTHS";
export type WarrantyTemplate = { value: number; unit: WarrantyUnit; scope: string; exclusions: string | null };
export type ServiceSettings = {
  version: number | null;
  defaultStaffMemberId: number | null;
  warrantyTemplate: WarrantyTemplate | null;
  activeTermsVersionId: number | null;
  activeStatutoryNoticeVersionId: number | null;
  /** UI 1.3: the profile's activity types (what the opening form offers first). */
  profile?: { key: string; defaultTracks: string[]; enabledTracks: string[] };
};
export type StaffMember = { id: number; displayName: string };

export class ServiceDeskApiError extends Error {
  constructor(
    /** HTTP status; null when the request never got an answer (offline, timeout). */
    public readonly status: number | null,
    /** The server's error code (VERSION_CONFLICT, REFUSED, …), or null. */
    public readonly code: string | null,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(code ?? (status === null ? "network" : `HTTP ${status}`));
    this.name = "ServiceDeskApiError";
  }
}

async function call<T>(method: "GET" | "PUT" | "POST", url: string, body?: unknown, key?: string, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: buildClientAuthHeaders({
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ServiceDeskApiError(null, null);
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const details = data.details && typeof data.details === "object" ? (data.details as Record<string, unknown>) : null;
    throw new ServiceDeskApiError(res.status, typeof data.error === "string" ? data.error : null, details);
  }
  return data as T;
}

/** The business's mode. 404 (mode NONE: not open for this business) is returned as null, not thrown. */
export async function getAccess(): Promise<ServiceDeskMode | null> {
  try {
    const r = await call<{ mode: ServiceDeskMode }>("GET", "/api/service-desk/access");
    return r.mode === "FULL" || r.mode === "READ_ONLY" ? r.mode : null;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status === 404) return null;
    throw e;
  }
}

export function getSettings(): Promise<ServiceSettings> {
  return call<ServiceSettings>("GET", "/api/service-desk/settings");
}

export async function listStaff(): Promise<StaffMember[]> {
  const r = await call<{ staff?: StaffMember[] }>("GET", "/api/service-desk/staff");
  return Array.isArray(r.staff) ? r.staff : [];
}

export type SaveSettingsBody = { expectedVersion: number | null; defaultStaffMemberId: number | null; warrantyTemplate: WarrantyTemplate | null };

/**
 * Save the settings. One key per intent: a second tap (or a retry after a lost answer) sends the same key, so the server
 * answers with the stored result instead of saving twice. The key is released once the server has answered — success or a
 * definite refusal — so the next, different save gets a new one.
 */
export async function saveSettings(body: SaveSettingsBody): Promise<ServiceSettings & { replayed: boolean }> {
  const intent = `service-desk/settings:${JSON.stringify(body)}`;
  const key = keyFor(intent);
  try {
    const r = await call<ServiceSettings & { replayed: boolean }>("PUT", "/api/service-desk/settings", body, key);
    settleKey(intent);
    return r;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status !== null) settleKey(intent);
    throw e;
  }
}

// ── UI 1.3: the cases list and the case screen (reads only) ─────────────────────────────────────────

/** GET /api/service-desk/cases — newest first (one page of up to 100). */
export async function listCases(): Promise<import("./cases-model").CaseRowData[]> {
  const r = await call<{ cases?: import("./cases-model").CaseRowData[] }>("GET", "/api/service-desk/cases?limit=100");
  return Array.isArray(r.cases) ? r.cases : [];
}

/** GET /api/service-desk/cases/:id — the case card. */
export function getCase(id: number): Promise<import("./cases-model").CaseCardData> {
  return call<import("./cases-model").CaseCardData>("GET", `/api/service-desk/cases/${id}`);
}

/** GET /api/service-desk/cases/:id/events — the journal, oldest first. */
export async function listCaseEvents(id: number): Promise<import("./cases-model").JournalItem[]> {
  const r = await call<{ events?: import("./cases-model").JournalItem[] } | import("./cases-model").JournalItem[]>("GET", `/api/service-desk/cases/${id}/events`);
  return Array.isArray(r) ? r : Array.isArray(r.events) ? r.events : [];
}

// ── UI 1.3: case actions (writes; the server decides what is legal) ─────────────────────────────────

/**
 * One state-machine action on the case. The server runs the real case machine (legality, approval, QA, balance,
 * permissions, version); the screen only offers what the action model allows. One key per intent: a retry of the same
 * action at the same version reuses it, so a lost answer never acts twice.
 */
export async function runCaseAction(caseId: number, action: Record<string, unknown>, expectedVersion: number): Promise<{ case: import("./cases-model").CaseRowData }> {
  const intent = `service-desk/cases/${caseId}:action:${expectedVersion}:${JSON.stringify(action)}`;
  const key = keyFor(intent);
  try {
    const r = await call<{ case: import("./cases-model").CaseRowData }>("POST", `/api/service-desk/cases/${caseId}/actions`, { action, expectedVersion }, key);
    settleKey(intent);
    return r;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status !== null) settleKey(intent);
    throw e;
  }
}

export type QuoteSummary = { version: number; state: string; totalAgorot: number | null };

/** GET /api/service-desk/cases/:id/quotes — the case's quote versions. */
export async function listQuotes(caseId: number): Promise<QuoteSummary[]> {
  const r = await call<{ quotes?: Array<Record<string, unknown>> }>("GET", `/api/service-desk/cases/${caseId}/quotes`);
  return (Array.isArray(r.quotes) ? r.quotes : []).map((q) => ({
    version: Number(q.version), state: String(q.state ?? ""), totalAgorot: typeof q.totalAgorot === "number" ? q.totalAgorot : null,
  }));
}

/** The owner records the customer's answer to a quote (by phone or in person). */
export async function decideQuote(caseId: number, version: number, decision: "APPROVE" | "REJECT", method: "PHONE" | "IN_PERSON", expectedVersion: number): Promise<unknown> {
  const intent = `service-desk/cases/${caseId}:quote:${version}:${decision}:${expectedVersion}`;
  const key = keyFor(intent);
  try {
    const r = await call<unknown>("POST", `/api/service-desk/cases/${caseId}/quotes/${version}/decision`, { decision, method, expectedVersion }, key);
    settleKey(intent);
    return r;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status !== null) settleKey(intent);
    throw e;
  }
}

// ── UI 1.3: opening a case ─────────────────────────────────────────────────────────────────────

export type CustomerHit = { id: number; name: string; phone: string | null };

/** GET /api/customers?q= — the business's customers by name or phone (the canonical customers list). */
export async function searchCustomers(q: string): Promise<CustomerHit[]> {
  const r = await call<{ customers?: Array<Record<string, unknown>> }>("GET", `/api/customers?q=${encodeURIComponent(q)}&limit=8`);
  return (Array.isArray(r.customers) ? r.customers : []).map((c) => ({ id: Number(c.id), name: String(c.name ?? ""), phone: (c.phone as string) ?? null }));
}

/** POST /api/customers — a new customer from the opening form (name, optional phone). */
export async function createCustomer(name: string, phone: string | null): Promise<CustomerHit> {
  const r = await call<Record<string, unknown>>("POST", "/api/customers", { name, ...(phone ? { phone } : {}) });
  const c = (r.customer && typeof r.customer === "object" ? r.customer : r) as Record<string, unknown>;
  return { id: Number(c.id), name: String(c.name ?? name), phone: (c.phone as string) ?? phone };
}

/** POST /api/service-desk/cases — open a case on a track (the server snapshots the profile). One key per intent. */
export async function openServiceCase(body: Record<string, unknown>): Promise<{ case: import("./cases-model").CaseRowData }> {
  const intent = `service-desk/cases:open:${JSON.stringify(body)}`;
  const key = keyFor(intent);
  try {
    const r = await call<{ case: import("./cases-model").CaseRowData }>("POST", "/api/service-desk/cases", body, key);
    settleKey(intent);
    return r;
  } catch (e) {
    if (e instanceof ServiceDeskApiError && e.status !== null) settleKey(intent);
    throw e;
  }
}
