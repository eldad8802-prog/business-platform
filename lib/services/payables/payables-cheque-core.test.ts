/**
 * Payables Phase 3 — the cheque lifecycle, as a pure table. Run:
 *   npx tsx lib/services/payables/payables-cheque-core.test.ts
 */
import {
  CHEQUE_STATUSES,
  assertChequeAdvance,
  assertChequeBounceable,
  assertChequeCancellable,
  assertChequeClearable,
  assertChequeReplaceable,
  assertCreatableStatus,
  availableChequeActions,
  chequePaymentKey,
  holdsItsNumber,
  normalizeChequeNumber,
  type ChequeStatusValue,
} from "./payables-cheque-core";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function ok(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/* ── A. numbers are text ─────────────────────────────────────────────── */
console.log("\n[A] cheque numbers");
check("leading zeros survive", normalizeChequeNumber(" 000123 ") === "000123");
check("letters and slashes survive", normalizeChequeNumber("A-7788/ג") === "A-7788/ג");
check("a JS number is refused (zeros already lost)", !ok(() => normalizeChequeNumber(123 as unknown as string)));
check("empty is refused", !ok(() => normalizeChequeNumber("   ")));
check("over 32 characters is refused", !ok(() => normalizeChequeNumber("1".repeat(33))));
check("control characters are refused", !ok(() => normalizeChequeNumber("12\n34")));

/* ── B. the lifecycle table ──────────────────────────────────────────── */
console.log("\n[B] lifecycle");
const allowedAdvance: Array<[ChequeStatusValue, ChequeStatusValue]> = [
  ["PLANNED", "ISSUED"],
  ["ISSUED", "DELIVERED"],
  ["ISSUED", "PRESENTED"],
  ["DELIVERED", "PRESENTED"],
];
for (const from of CHEQUE_STATUSES) {
  for (const to of CHEQUE_STATUSES) {
    const expected = allowedAdvance.some(([f, t]) => f === from && t === to);
    if (ok(() => assertChequeAdvance(from, to)) !== expected) {
      check(`advance ${from} → ${to} should be ${expected ? "allowed" : "refused"}`, false);
    }
  }
}
check("advance table: exactly the 4 forward steps are allowed", true);
check("no status can advance backwards to PLANNED", CHEQUE_STATUSES.every((s) => !ok(() => assertChequeAdvance(s, "PLANNED"))));

check("PLANNED cannot clear (not written yet)", !ok(() => assertChequeClearable("PLANNED")));
check("ISSUED / DELIVERED / PRESENTED can clear", (["ISSUED", "DELIVERED", "PRESENTED"] as const).every((s) => ok(() => assertChequeClearable(s))));
check("BOUNCED / CANCELLED / REPLACED / CLEARED cannot clear", (["BOUNCED", "CANCELLED", "REPLACED", "CLEARED"] as const).every((s) => !ok(() => assertChequeClearable(s))));

check("CLEARED can bounce (owner correction)", ok(() => assertChequeBounceable("CLEARED")));
check("PLANNED cannot bounce", !ok(() => assertChequeBounceable("PLANNED")));

check("CLEARED cannot be cancelled — money left", !ok(() => assertChequeCancellable("CLEARED")));
check("PRESENTED cannot be cancelled (it is at the bank)", !ok(() => assertChequeCancellable("PRESENTED")));
check("BOUNCED can be cancelled", ok(() => assertChequeCancellable("BOUNCED")));

check("CLEARED cannot be replaced", !ok(() => assertChequeReplaceable("CLEARED")));
check("REPLACED cannot be replaced again (no fork)", !ok(() => assertChequeReplaceable("REPLACED")));
check("BOUNCED and CANCELLED can be replaced", ok(() => assertChequeReplaceable("BOUNCED")) && ok(() => assertChequeReplaceable("CANCELLED")));

check("only PLANNED and ISSUED are creatable", CHEQUE_STATUSES.every((s) => ok(() => assertCreatableStatus(s)) === (s === "PLANNED" || s === "ISSUED")));
check("CLEARED cannot be created directly (it needs its event)", !ok(() => assertCreatableStatus("CLEARED")));

check("CANCELLED and REPLACED release the number", !holdsItsNumber("CANCELLED") && !holdsItsNumber("REPLACED"));
check("every other status holds it", (["PLANNED", "ISSUED", "DELIVERED", "PRESENTED", "CLEARED", "BOUNCED"] as const).every(holdsItsNumber));

const acts = availableChequeActions("ISSUED");
check("screen actions derive from the same table", acts.clear && acts.bounce && acts.cancel && acts.replace && acts.advance.join() === "DELIVERED,PRESENTED");
check("a CLEARED cheque offers only bounce", JSON.stringify(availableChequeActions("CLEARED")) === JSON.stringify({ advance: [], clear: false, bounce: true, cancel: false, replace: false }));

/* ── C. the ledger key ───────────────────────────────────────────────── */
console.log("\n[C] ledger key");
check("cheque 42 → cheque:42", chequePaymentKey(42) === "cheque:42");
check("a non-positive id is refused", !ok(() => chequePaymentKey(0)));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
if (failures > 0) process.exit(1);
