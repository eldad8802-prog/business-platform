type Confidence = "high" | "medium" | "low";

type Candidate = {
  value: number;
  score: number;
};

type FinancialRole = {
  value: number;
  confidence: Confidence;
} | null;

function isClearlyInvalidTotal(value: number): boolean {
  if (value < 10) return true;
  if (value > 1_000_000) return true;
  return false;
}

function isMuchSmallerThanCandidates(
  total: number,
  candidates: Candidate[]
): boolean {
  const largeCandidates = candidates.filter((candidate) => candidate.value >= 100);

  if (largeCandidates.length === 0) return false;

  const maxCandidate = Math.max(...largeCandidates.map((candidate) => candidate.value));

  return total < maxCandidate * 0.2;
}

function pickBestCandidate(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null;

  return (
    candidates
      .filter((candidate) => candidate.value >= 10)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.value - a.value;
      })[0] || null
  );
}

export function resolveFinalAmount(
  financialTotal: FinancialRole,
  candidates: Candidate[]
): {
  amount: number;
  confidence: Confidence;
  source: "financial_role" | "candidate_override" | "candidate";
} {
  if (financialTotal) {
    const totalValue = financialTotal.value;

    const invalid =
      isClearlyInvalidTotal(totalValue) ||
      isMuchSmallerThanCandidates(totalValue, candidates);

    if (!invalid) {
      return {
        amount: totalValue,
        confidence: financialTotal.confidence,
        source: "financial_role",
      };
    }
  }

  const best = pickBestCandidate(candidates);

  if (!best) {
    return {
      amount: 0,
      confidence: "low",
      source: "candidate",
    };
  }

  return {
    amount: best.value,
    confidence: best.score > 120 ? "high" : best.score > 60 ? "medium" : "low",
    source: "candidate_override",
  };
}