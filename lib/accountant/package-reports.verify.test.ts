/**
 * Pure checks for lib/accountant/package-reports.ts — the names and keys of the Excel report taken out
 * of a sealed package. The storage path (extraction, sha256 check, cache) is proven on PG17 by
 * .acct/excel-download-battery.ts.
 */
import { packageExcelCacheKey, packageExcelDownloadName, packageReportEntryName } from "./package-reports";

let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) console.log(`OK: ${name}`);
  else { failed++; console.log(`FAIL: ${name}`); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch { return true; }
}

const SHA = "a".repeat(64);
const ZIP = "biz/9/exports/accountant/2026-09/v1-aaaaaaaaaaaaaaaa.zip";

ok("the workbook entry is the one the package builder writes", packageReportEntryName("2026-09") === "דוח_2026-09.xlsx");
ok("the cache key sits next to the package object, in the same private exports prefix",
  packageExcelCacheKey(ZIP, 1, SHA) === `biz/9/exports/accountant/2026-09/v1-${SHA}.report.xlsx`);
ok("the cache key carries the FULL package sha256 (a new version can never reuse it)",
  packageExcelCacheKey(ZIP, 2, "b".repeat(64)) !== packageExcelCacheKey(ZIP, 2, SHA));
ok("the cache key keeps the business id of the package object", packageExcelCacheKey(ZIP, 1, SHA).startsWith("biz/9/"));
ok("a malformed sha256 is refused", throws(() => packageExcelCacheKey(ZIP, 1, "xyz")));
ok("an upper-case or short sha256 is refused", throws(() => packageExcelCacheKey(ZIP, 1, "A".repeat(64))) && throws(() => packageExcelCacheKey(ZIP, 1, "a".repeat(63))));
ok("a non-positive version is refused", throws(() => packageExcelCacheKey(ZIP, 0, SHA)) && throws(() => packageExcelCacheKey(ZIP, 1.5, SHA)));
ok("a key without a folder is refused", throws(() => packageExcelCacheKey("pkg.zip", 1, SHA)));
ok("the download name is ASCII and says what it is", packageExcelDownloadName("2026-09", 3) === "accountant-report-2026-09-v3.xlsx");

if (failed) {
  console.log(`package-reports: ${failed} failed`);
  process.exit(1);
}
console.log("package-reports: all checks passed");
