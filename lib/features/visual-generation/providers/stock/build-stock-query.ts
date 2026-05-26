import type { ContentFlowSnapshot } from "../../types";

function goalEnglishHint(goal?: ContentFlowSnapshot["goal"]): string {
  switch (goal) {
    case "sales":
      return "product business";
    case "trust":
      return "professional authentic";
    case "exposure":
      return "lifestyle creative";
    case "leads":
    default:
      return "people business";
  }
}

export const MAX_STOCK_QUERY_LEN = 120;

/**
 * Builds a Pexels-friendly search string from shot.visual + light flow context.
 * Scripts may be Hebrew; we still pass mixed text — Pexels often matches on English tokens.
 */
export function buildStockSearchQuery(
  visual: string,
  flow: ContentFlowSnapshot
): string {
  const hint = goalEnglishHint(flow.goal);
  const cleaned = visual.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return `${hint} lifestyle`.slice(0, MAX_STOCK_QUERY_LEN);
  }

  const combined = `${hint} ${cleaned}`.trim();
  return combined.slice(0, MAX_STOCK_QUERY_LEN);
}
