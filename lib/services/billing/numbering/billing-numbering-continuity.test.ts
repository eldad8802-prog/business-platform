/**
 * Pure: the numbering continuity check.
 *   - lists missing numbers (ranges), duplicates, counter agreement;
 *   - with the opening number unknown, checks only first..last and never claims full verification;
 *   - a series starting at 459 is not "missing 1–458";
 *   - a preserved cancelled number is present, not missing.
 *
 * Run: npx tsx lib/services/billing/numbering/billing-numbering-continuity.test.ts
 */
import { BillingDocumentType } from "@prisma/client";
import { analyzeSeriesContinuity, type SeriesContinuityInput } from "@/lib/services/billing/numbering/billing-numbering-continuity";

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
const run = (p: Partial<SeriesContinuityInput> & Pick<SeriesContinuityInput, "issuedNumbers" | "counterNext">) =>
  analyzeSeriesContinuity({ businessId: 7, documentType: TI, ...p });

// empty
const empty = run({ issuedNumbers: [], counterNext: null });
ok("empty series: coverage EMPTY, nothing missing, counter consistent, not 'fully verified'", empty.coverage === "EMPTY" && empty.missingCount === 0 && empty.counterConsistent && !empty.fullyVerified, j(empty));
ok("series key names business and type", empty.seriesKey === "7:TAX_INVOICE");

// opening unknown → partial
const clean = run({ issuedNumbers: [3, 1, 2, 4], counterNext: 5 });
ok("1..4, counter 5, opening unknown → consistent in range, but only partial (never fully verified)",
  clean.consistentInRange && clean.coverage === "FROM_FIRST_ISSUED" && !clean.fullyVerified, j(clean));
const s459 = run({ issuedNumbers: [459, 460, 461], counterNext: 462 });
ok("a series starting at 459 is NOT missing 1–458 when the opening is unknown",
  s459.missingCount === 0 && s459.first === 459 && s459.consistentInRange && !s459.fullyVerified && s459.coverage === "FROM_FIRST_ISSUED", j(s459));

// opening known
const open459 = run({ issuedNumbers: [459, 460, 461], counterNext: 462, openingNumber: 459 });
ok("opening 459 declared, 459..461 → fully verified", open459.fullyVerified && open459.coverage === "FROM_OPENING", j(open459));
const openGap = run({ issuedNumbers: [461, 462], counterNext: 463, openingNumber: 459 });
ok("opening 459, first issued 461 → 459–460 missing", j(openGap.missing) === j([{ from: 459, to: 460 }]) && !openGap.fullyVerified, j(openGap));
const below = run({ issuedNumbers: [100, 459], counterNext: 460, openingNumber: 459 });
ok("a number below the declared opening is reported, not silently counted", j(below.belowOpening) === j([100]) && !below.consistentInRange, j(below));
const openedUnused = run({ issuedNumbers: [], counterNext: 459, openingNumber: 459 });
ok("opening declared, nothing issued yet, counter at the opening → consistent", openedUnused.counterConsistent && openedUnused.missingCount === 0, j(openedUnused));

// gaps, duplicates, counter
const gaps = run({ issuedNumbers: [1, 2, 5, 6, 9], counterNext: 10 });
ok("missing listed as ranges 3–4 and 7–8", j(gaps.missing) === j([{ from: 3, to: 4 }, { from: 7, to: 8 }]) && gaps.missingCount === 4 && !gaps.consistentInRange, j(gaps));
const dup = run({ issuedNumbers: [1, 2, 2, 3], counterNext: 4 });
ok("a number issued twice is a duplicate", j(dup.duplicates) === j([2]) && !dup.consistentInRange && dup.issuedCount === 4, j(dup));
const ahead = run({ issuedNumbers: [1, 2], counterNext: 5 });
ok("counter ahead of the last issued → inconsistent", !ahead.counterConsistent && !ahead.consistentInRange, j(ahead));
const behind = run({ issuedNumbers: [1, 2, 3], counterNext: 3 });
ok("counter behind the last issued → inconsistent", !behind.counterConsistent, j(behind));
const orphan = run({ issuedNumbers: [], counterNext: 2 });
ok("a counter with nothing issued and no opening → inconsistent", !orphan.counterConsistent && orphan.coverage === "FROM_FIRST_ISSUED", j(orphan));

// cancelled
const cancelled = run({ issuedNumbers: [1, 2, 4], cancelledNumbers: [3], counterNext: 5 });
ok("a preserved cancelled number (3) is present, not missing", cancelled.missingCount === 0 && cancelled.cancelledCount === 1 && cancelled.consistentInRange, j(cancelled));
const cancelledDup = run({ issuedNumbers: [1, 2, 3], cancelledNumbers: [3], counterNext: 4 });
ok("a number both issued and cancelled is a duplicate", j(cancelledDup.duplicates) === j([3]), j(cancelledDup));
const cancelledLast = run({ issuedNumbers: [1, 2], cancelledNumbers: [3], counterNext: 4 });
ok("a cancelled last number counts for the counter", cancelledLast.counterConsistent && cancelledLast.last === 3, j(cancelledLast));

// large ranges
const big = run({ issuedNumbers: Array.from({ length: 100_000 }, (_, i) => i + 1).filter((n) => n !== 50_000), counterNext: 100_001 });
ok("100,000 numbers with one hole → exactly that hole", j(big.missing) === j([{ from: 50_000, to: 50_000 }]) && big.issuedCount === 99_999);
const sparse = run({ issuedNumbers: [1, 1_000_000], counterNext: 1_000_001 });
ok("two numbers 1 and 1,000,000 → one range of 999,998 missing, no expansion", sparse.missing.length === 1 && sparse.missingCount === 999_998, j(sparse));

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
