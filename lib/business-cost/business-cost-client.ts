import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * Client for GET /api/business-cost/summary. Every amount is the server's
 * decimal string — the client formats, it never computes money.
 */
export type CostWindowApi = { from: string; to: string; total: string; recorded: string; projected: string; items: Array<{ title: string; dueDate: string; amount: string; basis: "RECORDED" | "PROJECTED" }> };
export type CostPeriodApi = { from: string; to: string; days: number; cashOut: string; allocated: string; completeness: { state: string; reasons: string[] } };
export type CostInsightApi = { dedupeKey: string; kind: string; title: string; body: string; why: string; facts: Array<{ label: string; value: string; sourceRef: string }> };

export type BusinessCostSummaryApi = {
  asOf: string;
  currency: string;
  periods: { today: CostPeriodApi; yesterday: CostPeriodApi; thisWeek: CostPeriodApi; thisMonth: CostPeriodApi; last30Days: CostPeriodApi };
  baseline: { daily: string; weekly: string; monthly: string; annual: string; uncertain: string; completeness: { state: string; reasons: string[] } };
  upcoming: { overdue: CostWindowApi; next7Days: CostWindowApi; next30Days: CostWindowApi; currentMonth: CostWindowApi };
  insights: CostInsightApi[];
};

export async function fetchBusinessCostSummary(signal?: AbortSignal): Promise<BusinessCostSummaryApi> {
  const res = await fetch("/api/business-cost/summary", { headers: buildClientAuthHeaders(), cache: "no-store", signal });
  if (!res.ok) throw new Error(`business cost summary failed (${res.status})`);
  return (await res.json()) as BusinessCostSummaryApi;
}
