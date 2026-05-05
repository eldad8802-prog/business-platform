import type {
  AmountEligibilityItem,
  AmountEligibilityLogPayload,
} from "./amount-eligibility.service";

export type AmountPublishBlockReason =
  | "amount_not_eligible_by_evidence"
  | "no_distinct_eligible_amount_candidate"
  | "current_amount_not_in_eligible_candidates";

export type AmountPublishDistinctEligibleItem = {
  lineIndex: number;
  value: number;
  raw: string;
  label?: string;
  understandingRole: AmountEligibilityItem["understandingRole"];
  coarse: AmountEligibilityItem["coarse"];
  fine: AmountEligibilityItem["fine"];
};

export type AmountPublishDecisionLogPayload = {
  currentAmount: number;
  amountEligible: boolean;
  eligibleCountRaw: number;
  eligibleCountDistinct: number;
  publishAmountAllowed: boolean;
  blockReasons: AmountPublishBlockReason[];
  dedupKeyUsed: string;
  distinctEligibleItems: AmountPublishDistinctEligibleItem[];
  currentAmountMatchesDistinctEligible: boolean;
  currentAmountMatchCandidates: number[];
};

const DEDUP_KEY_USED = "lineIndex|value|normalizeRaw(raw)";

function normalizeRaw(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function eligibilityDedupKey(item: AmountEligibilityItem): string {
  return `${item.lineIndex}|${item.value}|${normalizeRaw(item.raw)}`;
}

export function buildAmountPublishDecisionLog(params: {
  amountEligible: boolean;
  currentAmount: number;
  eligibility: AmountEligibilityLogPayload;
}): AmountPublishDecisionLogPayload {
  const { amountEligible, currentAmount, eligibility } = params;

  const eligibleItems = eligibility.items.filter(
    (item) => item.coarse === "eligible_for_final"
  );

  const eligibleCountRaw = eligibleItems.length;

  const seenKeys = new Set<string>();
  const distinctEligibleItems: AmountPublishDistinctEligibleItem[] = [];

  for (const item of eligibleItems) {
    const key = eligibilityDedupKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    distinctEligibleItems.push({
      lineIndex: item.lineIndex,
      value: item.value,
      raw: item.raw,
      label: item.label,
      understandingRole: item.understandingRole,
      coarse: item.coarse,
      fine: item.fine,
    });
  }

  const eligibleCountDistinct = distinctEligibleItems.length;

  const matchingDistinct = distinctEligibleItems.filter(
    (item) => item.value === currentAmount
  );
  const currentAmountMatchesDistinctEligible = matchingDistinct.length > 0;
  const currentAmountMatchCandidates = Array.from(
    new Set(matchingDistinct.map((item) => item.value))
  );

  const publishAmountAllowed =
    amountEligible === true &&
    eligibleCountDistinct > 0 &&
    currentAmountMatchesDistinctEligible === true;

  const blockReasons: AmountPublishBlockReason[] = [];
  if (!amountEligible) {
    blockReasons.push("amount_not_eligible_by_evidence");
  }
  if (eligibleCountDistinct === 0) {
    blockReasons.push("no_distinct_eligible_amount_candidate");
  }
  if (
    amountEligible &&
    eligibleCountDistinct > 0 &&
    !currentAmountMatchesDistinctEligible
  ) {
    blockReasons.push("current_amount_not_in_eligible_candidates");
  }

  return {
    currentAmount,
    amountEligible,
    eligibleCountRaw,
    eligibleCountDistinct,
    publishAmountAllowed,
    blockReasons,
    dedupKeyUsed: DEDUP_KEY_USED,
    distinctEligibleItems,
    currentAmountMatchesDistinctEligible,
    currentAmountMatchCandidates,
  };
}
