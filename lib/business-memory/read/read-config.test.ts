/**
 * Business Memory READ-4 · Read flag (BUSINESS_MEMORY_READ) — unit test. npx tsx. No DB.
 * Fail-closed: ON iff exactly "true" (trimmed/case-insensitive); default OFF; independent from Shadow.
 */
import { isReadEnabled } from "./read-config";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL  ${name}`); }
}

const on = (v: unknown) => isReadEnabled({ BUSINESS_MEMORY_READ: v as string } as NodeJS.ProcessEnv);

check("absent → OFF (default)", isReadEnabled({} as NodeJS.ProcessEnv) === false);
check("empty → OFF", on("") === false);
check("\"false\" → OFF", on("false") === false);
check("\"0\" → OFF", on("0") === false);
check("\"1\" → OFF", on("1") === false);
check("\"yes\" → OFF", on("yes") === false);
check("\"on\" → OFF", on("on") === false);
check("malformed object → OFF", on({}) === false);
check("\"true\" → ON", on("true") === true);
check("\"TRUE\" → ON", on("TRUE") === true);
check("\"  True  \" (trim/case) → ON", on("  True  ") === true);
check("independent from Shadow flag", isReadEnabled({ BUSINESS_MEMORY_SHADOW: "true" } as NodeJS.ProcessEnv) === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(`\nFAILURES:\n  - ${failures.join("\n  - ")}`); process.exit(1); }
console.log("BUSINESS_MEMORY_READ flag: fail-closed · default-OFF · independent from Shadow. ✔");
