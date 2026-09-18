/**
 * Payables matching — the rules, proven one at a time. No database.
 *
 * The centre of gravity here is a single negative claim: amount similarity
 * alone must never establish economic identity. Most of these checks exist to
 * make that claim fail loudly if anyone ever "improves" the matcher by
 * surfacing amount-only pairings.
 */

import {
  amountsAgree,
  confidenceOf,
  daysBetween,
  financialRecordAmountToMinor,
  normalizeVendorName,
  rankCandidates,
  scoreCandidate,
  vendorSimilarity,
  type CandidateTarget,
  type DocumentFacts,
} from "./payables-matching";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function throws(name: string, fn: () => unknown): void {
  total += 1;
  try {
    fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a throw, none happened`);
  } catch {
    console.log(`  [PASS] ${name}`);
  }
}

const doc = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  documentId: 1,
  financialRecordId: 1,
  amountMinor: 120000,
  date: new Date("2027-01-15T00:00:00.000Z"),
  vendorName: "עיריית תל אביב",
  direction: "expense",
  ...over,
});

const installment = (over: Partial<Extract<CandidateTarget, { kind: "INSTALLMENT" }>> = {}): CandidateTarget => ({
  kind: "INSTALLMENT",
  installmentId: 10,
  commitmentId: 5,
  commitmentTitle: "ארנונה",
  payeeNameSnapshot: "עיריית תל אביב",
  payeeId: 3,
  remainingMinor: 120000,
  dueAt: new Date("2027-01-15T00:00:00.000Z"),
  ...over,
});

const payment = (over: Partial<Extract<CandidateTarget, { kind: "PAYMENT" }>> = {}): CandidateTarget => ({
  kind: "PAYMENT",
  paymentId: 20,
  commitmentId: 5,
  commitmentTitle: "ארנונה",
  payeeNameSnapshot: "עיריית תל אביב",
  payeeId: 3,
  amountMinor: 120000,
  paidAt: new Date("2027-01-15T00:00:00.000Z"),
  hasDocumentEvidence: false,
  ...over,
});

console.log("\n[A] the Float → ledger crossing");
check("A. a clean float converts to minor units", financialRecordAmountToMinor(1200) === 120000);
check("A. two decimals survive", financialRecordAmountToMinor(1200.55) === 120055);
check(
  "A. float dust is rounded at the boundary, not propagated",
  financialRecordAmountToMinor(1200.0000000000002) === 120000,
);
check(
  "A. a repeating-binary value lands where a human would put it",
  financialRecordAmountToMinor(0.1 + 0.2) === 30,
  `got ${financialRecordAmountToMinor(0.1 + 0.2)}`,
);
check("A. a negative expense is read by magnitude", financialRecordAmountToMinor(-450.25) === 45025);
throws("A. NaN is refused rather than becoming 0", () => financialRecordAmountToMinor(NaN));
throws("A. Infinity is refused", () => financialRecordAmountToMinor(Infinity));

console.log("\n[B] vendor normalisation");
check(
  "B. legal suffix and quoting do not change identity",
  normalizeVendorName('חברת החשמל בע"מ') === normalizeVendorName("חברת החשמל"),
);
check(
  "B. maqaf and space are the same separator",
  normalizeVendorName("תל־אביב") === normalizeVendorName("תל אביב"),
);
check("B. an identical name scores 1", vendorSimilarity("עיריית תל אביב", "עיריית תל אביב") === 1);
check(
  "B. an unrelated name scores 0",
  vendorSimilarity("עיריית תל אביב", "סופרגז") === 0,
);
check(
  "B. a partial name still scores something",
  vendorSimilarity("עיריית תל אביב יפו", "עיריית תל אביב") > 0.5,
);

console.log("\n[C] THE RULE — amount alone is never identity");
const amountOnly = scoreCandidate(
  doc({ vendorName: "ספק אחר לגמרי", date: new Date("2027-09-01T00:00:00.000Z") }),
  installment(),
);
check(
  "C. amount agrees, vendor and date do not — NOT offered at all",
  amountOnly === null,
);

const amountAndVendor = scoreCandidate(
  doc({ date: new Date("2027-09-01T00:00:00.000Z") }),
  installment(),
);
check("C. amount + vendor IS offered", amountAndVendor !== null);
check(
  "C. and says which signals fired",
  amountAndVendor !== null &&
    amountAndVendor.signals.includes("AMOUNT") &&
    amountAndVendor.signals.includes("VENDOR"),
);

const amountAndDate = scoreCandidate(
  doc({ vendorName: "ספק אחר לגמרי" }),
  installment(),
);
check("C. amount + date IS offered", amountAndDate !== null);

check(
  "C. a differing amount is never offered, however well everything else fits",
  scoreCandidate(doc({ amountMinor: 119999 }), installment()) === null,
);

check(
  "C. income is refused outright — a receipt for money IN is not a payable",
  scoreCandidate(doc({ direction: "income" }), installment()) === null,
);

console.log("\n[D] scoring and confidence");
const perfect = scoreCandidate(doc(), installment())!;
check("D. everything agreeing scores high", perfect.score >= 0.9, `${perfect.score}`);
check("D. and is STRONG", confidenceOf(perfect) === "STRONG");
check("D. with a zero day gap surfaced", perfect.dayGap === 0);

const weakish = scoreCandidate(
  doc({ vendorName: "ספק אחר לגמרי", date: new Date("2027-02-20T00:00:00.000Z") }),
  installment(),
)!;
check("D. amount + a distant date alone is not STRONG", confidenceOf(weakish) !== "STRONG");
check(
  "D. the band never claims certainty — the top band is STRONG",
  (["STRONG", "POSSIBLE", "WEAK"] as const).includes(confidenceOf(perfect)),
);

const alreadyEvidenced = scoreCandidate(doc(), payment({ hasDocumentEvidence: true }))!;
const notEvidenced = scoreCandidate(doc(), payment())!;
check(
  "D. a payment that already has a document is pushed down, not hidden",
  alreadyEvidenced.score < notEvidenced.score && alreadyEvidenced.score > 0,
);
check(
  "D. and the reason is stated",
  alreadyEvidenced.reasons.some((r) => r.includes("כבר משויך")),
);

console.log("\n[E] ambiguity is reported, not resolved");
const a = scoreCandidate(doc(), installment({ installmentId: 1, dueAt: new Date("2027-01-15T00:00:00.000Z") }))!;
const b = scoreCandidate(doc(), installment({ installmentId: 2, dueAt: new Date("2027-01-15T00:00:00.000Z") }))!;
const twin = rankCandidates([a, b]);
check("E. two identical instalments are flagged ambiguous", twin.ambiguous === true);

const clear = rankCandidates([
  perfect,
  scoreCandidate(doc({ vendorName: "ספק אחר לגמרי", date: new Date("2027-02-20T00:00:00.000Z") }), installment())!,
]);
check("E. a clearly better candidate is not ambiguous", clear.ambiguous === false);
check("E. and ranks first", clear.ranked[0].score >= clear.ranked[1].score);

console.log("\n[F] date arithmetic");
check("F. same day is zero", daysBetween(new Date("2027-01-15"), new Date("2027-01-15")) === 0);
check("F. symmetric", daysBetween(new Date("2027-01-10"), new Date("2027-01-15")) === 5);
check("F. exact agora comparison", amountsAgree(120000, 120000) && !amountsAgree(120000, 119999));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
process.exit(failures === 0 ? 0 : 1);
