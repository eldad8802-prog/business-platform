/**
 * Run: npx tsx lib/services/service-desk/settlement.test.ts
 *
 * 1.3c — the balance a handover reads (settlement.ts, contract v2). NO_CHARGE (explicit) and SETTLED are 0; OPEN and
 * CHARGE_NOT_DOCUMENTED carry the debt; UNKNOWN keeps the handover blocked (never 0); today's reader is UNKNOWN / NOT_LINKED.
 */
import { readSettlementNotLinked, settlementForCore } from "./settlement";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  ok("S1 SETTLED → known, 0, documented", JSON.stringify(settlementForCore({ state: "SETTLED", openBalanceAgorot: 0 })) === '{"known":true,"openBalanceAgorot":0,"basis":"DOCUMENTED"}');
  ok("S2 OPEN → known, the integer agorot", JSON.stringify(settlementForCore({ state: "OPEN", openBalanceAgorot: 12550 })) === '{"known":true,"openBalanceAgorot":12550,"basis":"DOCUMENTED"}');
  ok("S3 OPEN with a non-integer or non-positive amount → NOT known (refuse rather than guess)",
    !settlementForCore({ state: "OPEN", openBalanceAgorot: 12.5 }).known && !settlementForCore({ state: "OPEN", openBalanceAgorot: 0 }).known);
  ok("S4 UNKNOWN (any reason) → not known — never 0", (["NOT_LINKED", "DRAFT_PENDING", "FOREIGN_CURRENCY", "READ_ERROR"] as const)
    .every((reason) => settlementForCore({ state: "UNKNOWN", openBalanceAgorot: null, reason }).known === false));
  ok("S5 NO_CHARGE (the owner's explicit decision) → known 0, basis NO_CHARGE", JSON.stringify(settlementForCore({ state: "NO_CHARGE", openBalanceAgorot: 0 })) === '{"known":true,"openBalanceAgorot":0,"basis":"NO_CHARGE"}');
  ok("S7 CHARGE_NOT_DOCUMENTED → the remainder is a debt (basis UNDOCUMENTED); 0 only when the receipts cover it",
    JSON.stringify(settlementForCore({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: 30000 })) === '{"known":true,"openBalanceAgorot":30000,"basis":"UNDOCUMENTED"}'
      && settlementForCore({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: 0 }).known === true
      && !settlementForCore({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: -1 }).known && !settlementForCore({ state: "CHARGE_NOT_DOCUMENTED", openBalanceAgorot: 1.5 }).known);
  ok("S8 a malformed NO_CHARGE / SETTLED amount → not known", !settlementForCore({ state: "NO_CHARGE", openBalanceAgorot: 5 as never }).known && !settlementForCore({ state: "SETTLED", openBalanceAgorot: 1 as never }).known);
  const today = await readSettlementNotLinked({} as never, 1, 1);
  ok("S6 today's reader: UNKNOWN / NOT_LINKED — no inference from customer or dates", today.state === "UNKNOWN" && today.reason === "NOT_LINKED" && today.openBalanceAgorot === null);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}
void main();
