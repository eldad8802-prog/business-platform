"use client";

import { fetchJsonCached, invalidateCachedJson } from "@/lib/ui/cached-json";

/**
 * Closed Loop — the browser side of the owner recommendation surface. Mirrors the server's view model
 * exactly; every word the owner reads is produced there, not here.
 */

export type DecisionKind = "ACCEPT" | "REJECT" | "MODIFY" | "NOT_NOW";

export type RecommendationView = {
  id: number;
  version: number;
  type: "SETTLE_OVERDUE_INSTALLMENT" | "REVIEW_PENDING_DOCUMENTS";
  stage: "waiting" | "in_progress" | "closed";
  what: string;
  summary: string;
  why: string[];
  evidence: { lines: string[]; capturedAt: string; capturedNote: string; intact: boolean };
  options: { decision: DecisionKind; label: string; href: string | null }[];
  selectable: { id: number; label: string }[];
  status: string;
  after: string[];
  decidable: boolean;
  handoff: string | null;
  decision: { decision: DecisionKind; label: string; at: string } | null;
  issuedAt: string;
  validUntil: string;
};

type Choices = {
  reasons: { code: string; label: string }[];
  notNow: { days: number; label: string }[];
};

export type RecommendationsPayload =
  | { enabled: false }
  | ({ enabled: true; items: RecommendationView[]; counts: { waiting: number; in_progress: number; closed: number } } & Choices);

export type RecommendationPayload = { enabled: false } | ({ enabled: true; item: RecommendationView } & Choices);

export const RECOMMENDATIONS_URL = "/api/outcomes/recommendations";
const TTL = 15_000;

export function loadRecommendations(): Promise<RecommendationsPayload> {
  return fetchJsonCached<RecommendationsPayload>(RECOMMENDATIONS_URL, TTL);
}

export async function loadRecommendation(id: number): Promise<RecommendationPayload> {
  const res = await fetch(`${RECOMMENDATIONS_URL}/${id}`, { cache: "no-store", credentials: "same-origin" });
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as RecommendationPayload;
}

export type DecideInput = {
  decision: DecisionKind;
  recommendationVersion: number;
  targets?: number[];
  reasonCode?: string | null;
  deferDays?: number;
};

export type DecideResult = { ok: true } | { ok: false; code: "VERSION_MISMATCH" | "NOT_ACTIVE" | "NOT_FOUND" | "FEATURE_DISABLED" | "FAILED" };

/**
 * One owner answer. `idempotencyKey` is minted once per answer the owner is giving, so an impatient second tap
 * is the same decision, never a second one.
 */
export async function decide(id: number, input: DecideInput, idempotencyKey: string): Promise<DecideResult> {
  try {
    const res = await fetch(`${RECOMMENDATIONS_URL}/${id}/decision`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    });
    invalidateCachedJson(RECOMMENDATIONS_URL);
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const code = body.error;
    if (code === "VERSION_MISMATCH" || code === "NOT_ACTIVE" || code === "NOT_FOUND" || code === "FEATURE_DISABLED") return { ok: false, code };
    return { ok: false, code: "FAILED" };
  } catch {
    return { ok: false, code: "FAILED" };
  }
}

export function newIdempotencyKey(id: number, version: number, decision: DecisionKind): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2);
  return `rec-${id}-v${version}-${decision}-${rand}`.slice(0, 120);
}
