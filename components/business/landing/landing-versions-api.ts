"use client";

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

/** Owner-language message for a refused call. */
export function landingErrorMessage(r: { status: number; code: string | null }): string {
  switch (r.code) {
    case "COMPOSER_UNAVAILABLE": return "יצירת טיוטות דף עדיין לא הופעלה בחשבון הזה, ולכן אי אפשר לשמור גרסה חדשה. הגרסאות ששמרת זמינות כרגיל.";
    case "COMPOSITION_NOT_SAVEABLE": return "הטיוטה לא עברה את בדיקות הבטיחות של דוביז, ולכן לא נשמרה. אפשר ליצור אותה מחדש.";
    case "RENDER_REFUSED": return "את הטיוטה הזו לא ניתן להציג בבטחה, ולכן היא לא נשמרה.";
    case "STRATEGY_NOT_AVAILABLE": return "הכיוון הזה השתנה בינתיים (המידע על העסק התעדכן). חזרו לכיוונים ובחרו שוב.";
    case "NOT_CURRENT_DRAFT": return "אפשר לאשר רק את הטיוטה הנוכחית. רעננו את המסך.";
    case "ROLLBACK_SOURCE_NOT_APPROVED": return "אפשר לשחזר רק גרסה שאושרה בעבר.";
    case "ALREADY_CURRENT": return "זו כבר הגרסה המאושרת.";
    case "SNAPSHOT_INVALID": return "הגרסה הזו נשמרה בפורמט שלא ניתן להציג או לאשר בבטחה.";
    case "VERSION_NOT_FOUND": return "הגרסה לא נמצאה.";
    case "CONFLICT": return "הגרסאות השתנו בינתיים. רעננו את המסך ונסו שוב.";
    default:
      if (r.status === 429) return "נעשו הרבה פעולות בזמן קצר. נסו שוב בעוד כמה דקות.";
      return "לא הצלחנו להשלים את הפעולה כרגע.";
  }
}
