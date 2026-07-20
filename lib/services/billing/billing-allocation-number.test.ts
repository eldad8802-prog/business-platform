/**
 * Unit tests for the canonical allocation-number derivation (run manually):
 *   npx tsx lib/services/billing/billing-allocation-number.test.ts
 */
import {
  ALLOCATION_NUMBER_DIGITS,
  deriveAllocationNumber,
} from "@/lib/services/billing/billing-allocation-number";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`);
  }
}

// ---- §2.2.1: exactly the 9 right-most digits ----
ok("constant is 9", ALLOCATION_NUMBER_DIGITS === 9);
ok(
  "long confirmation_number → 9 right digits",
  deriveAllocationNumber("20240627231846297178091822") === "178091822"
);
ok("exactly 9 digits → unchanged", deriveAllocationNumber("123456789") === "123456789");
ok("trims surrounding whitespace", deriveAllocationNumber("  20240627178091822  ") === "178091822");

// ---- leading zeros preserved (string slice, never Number) ----
ok("leading zeros within the 9 preserved", deriveAllocationNumber("999000000123") === "000000123");
ok("9 digits all leading zeros but last", deriveAllocationNumber("100000000") === "100000000");
ok(
  "no precision loss on very long numeric (not Number())",
  deriveAllocationNumber("99999999999999999999000000007") === "000000007"
);

// ---- fail-closed ----
ok("fewer than 9 digits → null", deriveAllocationNumber("12345678") === null);
ok("empty → null", deriveAllocationNumber("") === null);
ok("whitespace only → null", deriveAllocationNumber("   ") === null);
ok("non-numeric → null", deriveAllocationNumber("ALLOC-SNAP-2") === null);
ok("mixed digits+letters → null", deriveAllocationNumber("12345678a") === null);
ok("digits with hyphen → null (not stripped)", deriveAllocationNumber("1234-56789") === null);
ok("null → null", deriveAllocationNumber(null) === null);
ok("undefined → null", deriveAllocationNumber(undefined) === null);
ok("non-string → null", deriveAllocationNumber(178091822 as unknown as string) === null);

// ---- output is always exactly 9 chars when non-null ----
{
  const r = deriveAllocationNumber("123456789012345");
  ok("output length is exactly 9", r !== null && r.length === 9 && r === "789012345");
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nAll allocation-number derivation checks passed.");
