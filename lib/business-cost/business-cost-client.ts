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

/** A learned Business Cost insight (KnowledgeMeasure → BusinessInsight), as GET /api/insights returns it. */
export type LearnedCostInsightApi = {
  id: number;
  insightKey: string;
  title: string;
  factLines: Array<{ text: string; sourceKind: string; sourceRef: string }>;
  uncertainty: string | null;
  contributingRules: Array<{ ruleId: string; ruleVersion: string; level?: "FACT" | "PATTERN" | "MEANING" }>;
  generatedAt: string;
};

/** The session business's OPEN learned cost insights (cost.*). Empty when the business is not learning. */
export async function fetchLearnedCostInsights(signal?: AbortSignal): Promise<LearnedCostInsightApi[]> {
  const res = await fetch("/api/insights", { headers: buildClientAuthHeaders(), cache: "no-store", signal });
  if (!res.ok) throw new Error(`insights failed (${res.status})`);
  const body = (await res.json()) as { insights?: LearnedCostInsightApi[] };
  return (body.insights ?? []).filter((i) => i.insightKey.startsWith("cost."));
}
