/**
 * Client-side fetch helpers for the Payment Secretary surface. Mirrors the
 * existing client-fetch convention (Bearer token from localStorage, thrown
 * Error on non-2xx). Pure transport — no business logic.
 */

export type ObligationState = "OPEN" | "MET" | "RELEASED";
export type RecurrenceCadence = "NONE" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type MorningState = "CALM" | "BUSY" | "CRITICAL" | "STILL_SETTLING_IN";
export type AttentionReason = "OVERDUE" | "DUE_TODAY" | "DUE_SOON";

export interface ObligationApi {
  id: number;
  obligeeName: string;
  amount: string;
  currency: string;
  dueAt: string;
  state: ObligationState;
  source: string;
  recurrence: RecurrenceCadence;
  recurrenceSeriesId: string | null;
  note: string | null;
  followUpAt: string | null;
  settlementAssertedBy: string | null;
  metAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BriefingItemApi {
  obligation: ObligationApi;
  reason: AttentionReason;
}

export interface BriefingApi {
  state: MorningState;
  oriented: boolean;
  attention: BriefingItemApi[];
  watching: ObligationApi[];
  counts: {
    open: number;
    attention: number;
    breakToday: number;
    watching: number;
  };
  generatedAt: string;
}

export interface CreateObligationInput {
  obligeeName: string;
  amount: string | number;
  currency?: string;
  dueAt: string; // ISO
  recurrence?: RecurrenceCadence;
  note?: string | null;
}

async function apiFetch<T>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `שגיאת שרת (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchBriefing(token: string): Promise<BriefingApi> {
  return apiFetch<BriefingApi>("/api/obligations/briefing", token);
}

export function fetchObligations(
  token: string,
  includeClosed = false
): Promise<{ obligations: ObligationApi[] }> {
  const q = includeClosed ? "?includeClosed=1" : "";
  return apiFetch<{ obligations: ObligationApi[] }>(
    `/api/obligations${q}`,
    token
  );
}

export function createObligation(
  token: string,
  input: CreateObligationInput
): Promise<ObligationApi> {
  return apiFetch<ObligationApi>("/api/obligations", token, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function completeObligation(
  token: string,
  id: number
): Promise<{ obligation: ObligationApi; nextInstance: ObligationApi | null }> {
  return apiFetch(`/api/obligations/${id}/complete`, token, { method: "POST" });
}

export function snoozeObligation(
  token: string,
  id: number,
  followUpAt: string
): Promise<ObligationApi> {
  return apiFetch<ObligationApi>(`/api/obligations/${id}/snooze`, token, {
    method: "POST",
    body: JSON.stringify({ followUpAt }),
  });
}

export function releaseObligation(
  token: string,
  id: number
): Promise<ObligationApi> {
  return apiFetch<ObligationApi>(`/api/obligations/${id}/release`, token, {
    method: "POST",
  });
}

export function markOriented(
  token: string
): Promise<{ businessId: number; oriented: boolean; orientedAt: string | null }> {
  return apiFetch("/api/obligations/orientation", token, { method: "POST" });
}
