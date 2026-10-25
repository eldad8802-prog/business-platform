"use client";

/**
 * Browser calls of the accountant-pack screen. The session token is the same bearer every Documents
 * screen uses; the business is never sent — the server derives it from the session.
 */

import type { PeriodView, RecipientView } from "@/lib/accountant/view.service";
import type { PeriodStatus } from "@/lib/accountant/workflow-status";

export type PeriodListItem = { periodKey: string; label: string; status: PeriodStatus | null; statusLabel: string | null };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let body: { error?: string; details?: Record<string, unknown> } = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, body.error ?? `HTTP_${res.status}`, body.details ?? {});
  }
  return (await res.json()) as T;
}

/** null when the workflow is not enabled for this business (the API answers 404). */
export async function fetchPeriods(token: string): Promise<PeriodListItem[] | null> {
  try {
    return (await call<{ periods: PeriodListItem[] }>(token, "/api/accountant/periods")).periods;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchPeriod(token: string, periodKey: string): Promise<PeriodView> {
  return (await call<{ period: PeriodView }>(token, `/api/accountant/periods/${periodKey}`)).period;
}

export async function preparePeriod(token: string, periodKey: string): Promise<PeriodView> {
  return (await call<{ period: PeriodView }>(token, `/api/accountant/periods/${periodKey}/prepare`, { method: "POST" })).period;
}

export async function saveRecipient(
  token: string,
  input: { name: string; email: string; expectedVersion: number | null }
): Promise<{ recipient: RecipientView; canceledApprovals: number }> {
  return call(token, "/api/accountant/recipient", { method: "PUT", body: JSON.stringify({ ...input, confirm: true }) });
}

export async function approveSend(
  token: string,
  periodKey: string,
  input: { packageId: number; packageSha256: string; recipientVersion: number; recipientEmail: string; acknowledgeIncomplete: boolean },
  idempotencyKey: string
): Promise<{ deliveryId: number; period: PeriodView }> {
  return call(token, `/api/accountant/periods/${periodKey}/deliveries`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function revokeLink(token: string, deliveryId: number): Promise<void> {
  await call(token, `/api/accountant/deliveries/${deliveryId}/revoke`, { method: "POST" });
}

export async function cancelSend(token: string, deliveryId: number): Promise<void> {
  await call(token, `/api/accountant/deliveries/${deliveryId}/cancel`, { method: "POST" });
}

export async function completeManually(token: string, periodKey: string, packageId: number): Promise<PeriodView> {
  return (
    await call<{ period: PeriodView }>(token, `/api/accountant/periods/${periodKey}/complete`, {
      method: "POST",
      body: JSON.stringify({ packageId, confirm: true }),
    })
  ).period;
}

export type PackageDownloadFormat = "zip" | "xlsx" | "pdf";

/**
 * Downloads a stored package — the ZIP, the report workbook taken out of it, or its PDF rendering — as a five-minute signed
 * URL (production) or the bytes (local development).
 */
export async function downloadPackage(token: string, packageId: number, format: PackageDownloadFormat = "zip"): Promise<void> {
  const res = await fetch(`/api/accountant/packages/${packageId}/download?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(res.status, typeof body?.error === "string" ? body.error : `HTTP_${res.status}`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const { url } = (await res.json()) as { url: string };
    window.location.assign(url);
    return;
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = format === "zip" ? `accountant-package-${packageId}.zip` : `accountant-report-${packageId}.${format}`;
  a.click();
  URL.revokeObjectURL(href);
}

export function newIdempotencyKey(): string {
  const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `send:${raw.replace(/[^A-Za-z0-9-]/g, "")}`;
}
