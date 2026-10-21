"use client";

import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { CurrentReadiness } from "@/lib/services/landing/persistence/landing-version-model";
import type { LandingOverview, LandingVersionDetail, LandingVersionSummary } from "@/lib/services/landing/persistence/landing-page.service";

/**
 * P3-E — the owner's calls to /api/business/landing/**. The client sends a strategy id (save), a version id
 * (in the path) and, for a rollback, a per-action Idempotency-Key. Nothing else: no blueprint, status,
 * authority, approver or business id ever leaves the browser.
 */

function authHeaders(): Record<string, string> {
  const token = typeof window === "undefined" ? null : localStorage.getItem("token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string | null };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) }, cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (T & { code?: string }) | null;
    if (!res.ok || !body) return { ok: false, status: res.status, code: body?.code ?? null };
    return { ok: true, data: body };
  } catch {
    return { ok: false, status: 0, code: null };
  }
}

export const fetchLandingOverview = () => call<LandingOverview & { composerEnabled: boolean }>("/api/business/landing");

export const fetchLandingVersion = (id: number) => call<LandingVersionDetail>(`/api/business/landing/versions/${id}`);

export const saveLandingDraft = (strategyId: string) =>
  call<{ version: LandingVersionSummary; deduplicated: boolean }>("/api/business/landing/versions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ strategyId }),
  });

export const approveLandingDraft = (id: number) =>
  call<{ version: LandingVersionSummary; alreadyApproved: boolean; currentReadiness: CurrentReadiness }>(`/api/business/landing/versions/${id}/approve`, { method: "POST" });

/** One owner action = one key: a double click sends the same key and creates one version. */
export const rollbackToVersion = (id: number, actionKey: string) =>
  call<{ version: LandingVersionSummary; deduplicated: boolean }>(`/api/business/landing/versions/${id}/rollback`, {
    method: "POST",
    headers: { "Idempotency-Key": actionKey },
  });

export const retireLandingDraft = (id: number) => call<{ version: LandingVersionSummary }>(`/api/business/landing/versions/${id}/retire`, { method: "POST" });

export function newActionKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2, 10)}`;
}

const ERROR_CODES = new Set([
  "COMPOSER_UNAVAILABLE",
  "COMPOSITION_NOT_SAVEABLE",
  "RENDER_REFUSED",
  "STRATEGY_NOT_AVAILABLE",
  "NOT_CURRENT_DRAFT",
  "ROLLBACK_SOURCE_NOT_APPROVED",
  "ALREADY_CURRENT",
  "SNAPSHOT_INVALID",
  "VERSION_NOT_FOUND",
  "CONFLICT",
]);

/** Owner-language message for a refused call. */
export function landingErrorMessage(t: Translator, r: { status: number; code: string | null }): string {
  if (r.code && ERROR_CODES.has(r.code)) return t(`content.identity.versions.error.${r.code}` as MessageKey);
  if (r.status === 429) return t("content.identity.versions.error.rateLimited");
  return t("content.identity.versions.error.generic");
}
