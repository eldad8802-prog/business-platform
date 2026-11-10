/**
 * Pure: the numbering continuity check lists the numbers that exist and the numbers
 * that are missing (as ranges), duplicates, and whether the counter agrees.
 *
 * Run: npx tsx lib/services/billing/numbering/billing-numbering-continuity.test.ts
 */
import { BillingDocumentType } from "@prisma/client";
import { analyzeSeriesContinuity } from "@/lib/services/billing/numbering/billing-numbering-continuity";

let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? " — " + detail : ""}`);
  }
}
const TI = BillingDocumentType.TAX_INVOICE;
const j = (v: unknown) => JSON.stringify(v);

const empty = analyzeSeriesContinuity(TI, [], null);
ok("never used: continuous, no numbers, counter absent", empty.continuous && empty.first === null && empty.issuedCount === 0);

const clean = analyzeSeriesContinuity(TI, [3, 1, 2, 4], 5);
ok("1..4 in any order, counter 5 → continuous", clean.continuous && clean.first === 1 && clean.last === 4 && clean.missingCount === 0, j(clean));

const gaps = analyzeSeriesContinuity(TI, [1, 2, 5, 6, 9], 10);
ok("missing numbers listed as ranges: 3–4 and 7–8", j(gaps.missing) === j([{ from: 3, to: 4 }, { from: 7, to: 8 }]) && gaps.missingCount === 4 && !gaps.continuous, j(gaps));

const late = analyzeSeriesContinuity(TI, [4, 5], 6);
ok("a series that starts above 1 reports 1–3 as missing", j(late.missing) === j([{ from: 1, to: 3 }]) && !late.continuous, j(late));

const dup = analyzeSeriesContinuity(TI, [1, 2, 2, 3], 4);
ok("a duplicated number is reported", j(dup.duplicates) === j([2]) && !dup.continuous && dup.issuedCount === 4, j(dup));

const ahead = analyzeSeriesContinuity(TI, [1, 2], 5);
ok("counter ahead of the last issued (numbers consumed without a document) → inconsistent", !ahead.counterConsistent && !ahead.continuous, j(ahead));

const behind = analyzeSeriesContinuity(TI, [1, 2, 3], 3);
ok("counter behind the last issued → inconsistent", !behind.counterConsistent, j(behind));

const orphanCounter = analyzeSeriesContinuity(TI, [], 2);
ok("a counter with no issued document → inconsistent", !orphanCounter.counterConsistent && !orphanCounter.continuous, j(orphanCounter));

const big = analyzeSeriesContinuity(TI, Array.from({ length: 5000 }, (_, i) => i + 1).filter((n) => n !== 2500), 5001);
ok("5,000 numbers with one hole → exactly that hole", j(big.missing) === j([{ from: 2500, to: 2500 }]) && big.issuedCount === 4999);

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
