/**
 * Payables — document matching.
 *
 * Pure. No Prisma, no I/O, no clock of its own. Everything it needs arrives as
 * facts, which is what makes the rules below testable one at a time.
 *
 * ── The rule this module exists to enforce ──────────────────────────────────
 *
 * AMOUNT SIMILARITY ALONE NEVER ESTABLISHES ECONOMIC IDENTITY.
 *
 * Two 1,200 ILS facts in the same month are not the same event. A business
 * pays the same round figure to different payees constantly — rent, a monthly
 * retainer, an instalment plan deliberately built from equal parts. A matcher
 * that treats "the numbers agree" as proof will, sooner or later, staple a
 * supplier's receipt onto a municipal tax instalment, and the owner will
 * believe a bill is settled that is not.
 *
 * So a candidate needs corroboration: the amount must agree AND at least one
 * independent signal must agree too. A pairing supported by amount and nothing
 * else is not returned at all — not as a weak suggestion, not greyed out. It
 * would be an invitation to click.
 *
 * ── What this module never does ─────────────────────────────────────────────
 *
 * It does not decide. It scores, explains which signals fired, and stops. The
 * ledger only changes when a person confirms, which is the whole point of a
 * suggestion: the machine narrows the field, the owner settles identity.
 */

import { toMinorUnits } from "./payables-core";

/* ─────────────────────────────── money ───────────────────────────────────── */

/**
 * `FinancialRecord.amount` is a Float — the document pipeline predates this
 * ledger and stores money as a double. The payables side is Decimal(18,2) and
 * integer minor units.
 *
 * This is the ONLY crossing point, and it is deliberately narrow: the float is
 * rounded to two places and handed straight to the canonical converter. No
 * float arithmetic is ever performed on it, and nothing downstream sees the
 * double again — a comparison done in floats would make 1200.00 and 1199.999999
 * disagree, or worse, agree by accident after a subtraction.
 */
export function financialRecordAmountToMinor(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error("FinancialRecord amount is not a finite number");
  }
  // toFixed(2) before the canonical parser: the parser rightly refuses a third
  // decimal place, and a float that prints as 1200.0000000000002 has one.
  return toMinorUnits(Math.abs(amount).toFixed(2));
}

/* ─────────────────────────── vendor name ────────────────────────────────── */

/**
 * Normalise a payee/vendor name for comparison only. The stored snapshot is
 * never touched — this is a lens, not an edit.
 *
 * Hebrew business names arrive with and without the definite article, with
 * legal suffixes, with quotation marks in two different characters, and with
 * the gershayim that Hebrew acronyms use. Comparing the raw strings makes
 * "עיריית תל־אביב" and "עירית תל אביב בע\"מ" look like different companies.
 */
/**
 * Legal-form tokens say what a company IS, not which company it is.
 *
 * Matched as whole TOKENS rather than with `\b`, because `\b` is defined on
 * ASCII word characters: `\bבעמ\b` never matches, so a word-boundary regex
 * silently does nothing to Hebrew and the suffix survives normalisation.
 */
const LEGAL_FORM_TOKENS = new Set([
  "בעמ",
  "בע",
  "ltd",
  "limited",
  "inc",
  "llc",
  "co",
]);

export function normalizeVendorName(raw: string): string {
  const cleaned = raw
    .normalize("NFKC")
    .toLowerCase()
    // Quotation marks (Hebrew gershayim included) carry no identity, and
    // removing rather than spacing them keeps בע"מ a single token.
    .replace(/["'״׳`‘’“”]/g, "")
    // Maqaf and punctuation become separators.
    .replace(/[־\-_,./\\|()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned
    .split(" ")
    .filter((token) => token !== "" && !LEGAL_FORM_TOKENS.has(token))
    .join(" ");
}

/** Token overlap, symmetric, ignoring one-character noise tokens. */
export function vendorSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeVendorName(a).split(" ").filter((t) => t.length > 1));
  const tb = new Set(normalizeVendorName(b).split(" ").filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  // Symmetric: a two-word name fully contained in a five-word one should score
  // well, but not identically to an exact match.
  return (2 * shared) / (ta.size + tb.size);
}

/* ──────────────────────────── the signals ───────────────────────────────── */

export type MatchSignal = "AMOUNT" | "VENDOR" | "DATE" | "PAYEE_LINK";

export type DocumentFacts = {
  documentId: number;
  financialRecordId: number | null;
  /** Already converted through `financialRecordAmountToMinor`. */
  amountMinor: number;
  date: Date;
  vendorName: string;
  /** Only "expense" is ever a payable candidate. */
  direction: string;
};

export type CandidateTarget =
  | {
      kind: "PAYMENT";
      paymentId: number;
      commitmentId: number;
      commitmentTitle: string;
      payeeNameSnapshot: string;
      payeeId: number | null;
      amountMinor: number;
      paidAt: Date;
      /** Active document evidence already attached to this payment. */
      hasDocumentEvidence: boolean;
    }
  | {
      kind: "INSTALLMENT";
      installmentId: number;
      commitmentId: number;
      commitmentTitle: string;
      payeeNameSnapshot: string;
      payeeId: number | null;
      /** What the instalment still owes, not what it was scheduled at. */
      remainingMinor: number;
      dueAt: Date;
    };

export type Candidate = {
  target: CandidateTarget;
  /** 0..1. Presentation only — it orders a list, it never decides anything. */
  score: number;
  signals: MatchSignal[];
  /** Plain-language reasons, so the owner judges the evidence, not the number. */
  reasons: string[];
  /** How far apart the two dates are, surfaced rather than hidden inside a score. */
  dayGap: number;
};

/** Exact to the agora. Money that "nearly" agrees is a different payment. */
export function amountsAgree(a: number, b: number): boolean {
  return a === b;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

const DATE_NEAR_DAYS = 45;
const VENDOR_STRONG = 0.6;
const VENDOR_WEAK = 0.34;

/**
 * Score one pairing, or reject it outright.
 *
 * Returns `null` when the pairing must not be offered at all — which is a
 * different thing from scoring zero. A zero would still appear in a list.
 */
export function scoreCandidate(
  doc: DocumentFacts,
  target: CandidateTarget,
): Candidate | null {
  // Income is not a payable. This is a hard filter, never a low score.
  if (doc.direction !== "expense") return null;

  const targetAmount =
    target.kind === "PAYMENT" ? target.amountMinor : target.remainingMinor;
  const targetDate = target.kind === "PAYMENT" ? target.paidAt : target.dueAt;

  const signals: MatchSignal[] = [];
  const reasons: string[] = [];

  const amountAgrees = amountsAgree(doc.amountMinor, targetAmount);
  if (amountAgrees) {
    signals.push("AMOUNT");
    reasons.push("הסכום זהה");
  }

  const similarity = vendorSimilarity(doc.vendorName, target.payeeNameSnapshot);
  if (similarity >= VENDOR_STRONG) {
    signals.push("VENDOR");
    reasons.push("שם הספק תואם");
  } else if (similarity >= VENDOR_WEAK) {
    signals.push("VENDOR");
    reasons.push("שם הספק דומה");
  }

  const dayGap = daysBetween(doc.date, targetDate);
  if (dayGap <= DATE_NEAR_DAYS) {
    signals.push("DATE");
    reasons.push(
      dayGap === 0 ? "אותו תאריך" : `הפרש של ${dayGap} ימים`,
    );
  }

  // THE RULE. Amount must agree — a document whose figure differs is simply not
  // this payment — and it must not stand alone.
  if (!amountAgrees) return null;
  const corroborating = signals.filter((s) => s !== "AMOUNT");
  if (corroborating.length === 0) return null;

  // Weighting reflects how much each signal narrows identity. The amount is
  // necessary but least discriminating, because equal round figures are
  // exactly what a business pays over and over.
  let score = 0.4;
  if (similarity >= VENDOR_STRONG) score += 0.35;
  else if (similarity >= VENDOR_WEAK) score += 0.18;
  if (dayGap === 0) score += 0.2;
  else if (dayGap <= 7) score += 0.15;
  else if (dayGap <= DATE_NEAR_DAYS) score += 0.08;

  // A payment that already carries document evidence is still offered — the
  // owner may be correcting a wrong attachment — but it is pushed down, because
  // the common case is that this document belongs somewhere else.
  if (target.kind === "PAYMENT" && target.hasDocumentEvidence) {
    score -= 0.25;
    reasons.push("לתשלום הזה כבר משויך מסמך");
  }

  return {
    target,
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    signals,
    reasons,
    dayGap,
  };
}

/**
 * Confidence band. Deliberately coarse and deliberately never "certain":
 * the highest band is called STRONG, not MATCHED, because this module has
 * never established identity and must not appear to claim it.
 */
export type Confidence = "STRONG" | "POSSIBLE" | "WEAK";

export function confidenceOf(candidate: Candidate): Confidence {
  const hasVendor = candidate.signals.includes("VENDOR");
  if (candidate.score >= 0.85 && hasVendor) return "STRONG";
  if (candidate.score >= 0.6) return "POSSIBLE";
  return "WEAK";
}

/**
 * Rank candidates, and say whether the top one stands apart.
 *
 * `ambiguous` is the honest half of the answer. Three instalments of an
 * identical plan, all unpaid, all near the same date, produce three candidates
 * that a score cannot separate — because nothing in the available facts
 * separates them. Saying so is the correct output; silently returning the first
 * one would be a guess wearing a number.
 */
export function rankCandidates(candidates: Candidate[]): {
  ranked: Candidate[];
  ambiguous: boolean;
} {
  const ranked = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.dayGap - b.dayGap;
  });
  const ambiguous =
    ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 0.05;
  return { ranked, ambiguous };
}
