/**
 * Business Cost Intelligence — the read side.
 *
 * One load per call (`loadBusinessCostInputs`, the same loader as the daily
 * engine), then pure derivation. Nothing is stored, nothing is cached: every
 * answer is re-derived from the ledger, so it cannot drift from it.
 *
 * Tenant isolation is the loader's: one `tenantTx(businessId)` (RLS on every
 * table read) plus an explicit businessId filter. `businessId` always comes
 * from the caller's session.
 */
import { fromMinorUnits } from "@/lib/services/payables/payables-core";
import { civilDateInZone, DEFAULT_BUSINESS_TIME_ZONE, toDayNumber } from "./business-cost-core";
import { costForRange, summarizeBusinessCost, SIGNAL_POLICY } from "./business-cost-intelligence";
import { composeCostInsights } from "./business-cost-insights";
import { loadBusinessCostInputs } from "./business-cost.service";

/** Payments loaded for the signal history: every comparable window plus the current one. */
const HISTORY_DAYS = SIGNAL_POLICY.windowDays * (SIGNAL_POLICY.historyWindows + 1);

export async function deriveBusinessCostSummary(input: { businessId: number; date?: string | null; now?: Date }) {
  const asOf = input.date ?? civilDateInZone(input.now ?? new Date(), DEFAULT_BUSINESS_TIME_ZONE);
  const day = toDayNumber(asOf); // validates before any query
  const inputs = await loadBusinessCostInputs({ businessId: input.businessId, paidFromDay: day - HISTORY_DAYS, paidToDay: day });
  const summary = summarizeBusinessCost({ ...inputs, asOf });
  return { summary, insights: composeCostInsights(summary) };
}

export async function deriveBusinessCostRange(input: { businessId: number; from: string; to: string }) {
  const a = toDayNumber(input.from);
  const b = toDayNumber(input.to);
  const inputs = await loadBusinessCostInputs({ businessId: input.businessId, paidFromDay: a, paidToDay: b });
  return costForRange({ ...inputs, asOf: input.to }, input.from, input.to);
}

/**
 * API shape: every `…Minor` integer becomes a decimal string under the same name
 * without the suffix (`cashOutMinor: 5000` → `cashOut: "50.00"`). Never floats.
 */
export function serializeMoney<T>(value: T): unknown {
  if (Array.isArray(value)) return value.map(serializeMoney);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.endsWith("Minor") && typeof v === "number") out[k.slice(0, -5)] = fromMinorUnits(v);
    else if (k.endsWith("Minor") && v === null) out[k.slice(0, -5)] = null;
    else out[k] = serializeMoney(v);
  }
  return out;
}
