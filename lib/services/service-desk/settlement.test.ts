/**
 * Run: npx tsx lib/services/service-desk/settlement.test.ts
 *
 * 1.3c — the balance a handover reads (settlement.ts). Only SETTLED and OPEN are known; UNKNOWN and NO_CHARGE_DOCUMENT
 * keep the handover blocked (never read as 0); today's only reader answers UNKNOWN / NOT_LINKED (no billing link yet).
 */
import { readSettlementNotLinked, settlementForCore } from "./settlement";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  ok("S1 SETTLED → known, 0", JSON.stringify(settlementForCore({ state: "SETTLED", openBalanceAgorot: 0 })) === '{"known":true,"openBalanceAgorot":0}');
  ok("S2 OPEN → known, the integer agorot", JSON.stringify(settlementForCore({ state: "OPEN", openBalanceAgorot: 12550 })) === '{"known":true,"openBalanceAgorot":12550}');
  ok("S3 OPEN with a non-integer or non-positive amount → NOT known (refuse rather than guess)",
    !settlementForCore({ state: "OPEN", openBalanceAgorot: 12.5 }).known && !settlementForCore({ state: "OPEN", openBalanceAgorot: 0 }).known);
  ok("S4 UNKNOWN (any reason) → not known — never 0", (["NOT_LINKED", "DRAFT_PENDING", "FOREIGN_CURRENCY", "READ_ERROR"] as const)
    .every((reason) => settlementForCore({ state: "UNKNOWN", openBalanceAgorot: null, reason }).known === false));
  ok("S5 NO_CHARGE_DOCUMENT → not known (an owner decision first, not a silent 0)", settlementForCore({ state: "NO_CHARGE_DOCUMENT", openBalanceAgorot: null }).known === false);
  const today = await readSettlementNotLinked({} as never, 1, 1);
  ok("S6 today's reader: UNKNOWN / NOT_LINKED — no inference from customer or dates", today.state === "UNKNOWN" && today.reason === "NOT_LINKED" && today.openBalanceAgorot === null);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}
void main();
