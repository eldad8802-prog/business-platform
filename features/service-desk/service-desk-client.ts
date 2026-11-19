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

async function call<T>(method: "GET" | "PUT", url: string, body?: unknown, key?: string, timeoutMs = 15000): Promise<T> {
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
