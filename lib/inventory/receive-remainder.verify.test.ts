/**
 * Receiving the remainder of a purchase order line — regression for the 2026-11-03
 * inventory audit (ב3: "המשך מתעכב" / "סגור כחוסר" always failed). Pure: no DB. Run:
 *   npx tsx lib/inventory/receive-remainder.verify.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  clampReceived,
  lineOpenQty,
  remainderDecisionPayload,
  shortfall,
} from "@/lib/inventory/receive-remainder";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/** The server's acceptance rule for a remainder quantity (purchase-order.service.ts). */
function serverAccepts(
  line: { orderedQty: number; receivedQty: number },
  payload: { remainingDecision: string; remainingDecisionQty?: number }
): boolean {
  if (payload.remainingDecision === "KEEP_OPEN") return true;
  const qty = payload.remainingDecisionQty;
  return typeof qty === "number" && Number.isFinite(qty) && qty > 0 && qty <= line.orderedQty - line.receivedQty;
}

// First delivery: ordered 10, nothing received yet, 6 arrive.
const first = { orderedQty: 10, receivedQty: 0, closedShortQty: 0, openQty: 10 };
check("open balance on a fresh line is the ordered quantity", lineOpenQty(first) === 10);
check("6 of 10 leaves 4 short", shortfall(first, 6) === 4);

for (const decision of ["BACKORDER", "CLOSED_SHORT"] as const) {
  const payload = remainderDecisionPayload(first, 6, decision);
  check(`${decision} sends the undelivered 4`, payload?.remainingDecisionQty === 4, JSON.stringify(payload));
  check(`${decision} payload is accepted by the server rule`, Boolean(payload) && serverAccepts(first, payload!));
}
const keep = remainderDecisionPayload(first, 6, "KEEP_OPEN");
check("KEEP_OPEN sends no quantity (the server stores none)", keep?.remainingDecision === "KEEP_OPEN" && keep.remainingDecisionQty === undefined);

// Second delivery: 6 already received, open 4; 3 arrive now.
const second = { orderedQty: 10, receivedQty: 6, closedShortQty: 0, openQty: 4 };
check("second delivery is judged on the open 4, not the ordered 10", shortfall(second, 3) === 1 && shortfall(second, 4) === 0);
const secondShort = remainderDecisionPayload(second, 3, "CLOSED_SHORT");
check("closing short after earlier receipts sends 1, not 7", secondShort?.remainingDecisionQty === 1, JSON.stringify(secondShort));
check("…and the server accepts it", Boolean(secondShort) && serverAccepts(second, secondShort!));
check("a full second delivery needs no remainder decision", remainderDecisionPayload(second, 4, "BACKORDER") === null);

// A line already partly closed short: ordered 10, received 5, closed short 3 → open 2.
const partlyClosed = { orderedQty: 10, receivedQty: 5, closedShortQty: 3, openQty: 2 };
check("open balance deducts the quantity already closed short", lineOpenQty(partlyClosed) === 2);

// Without a server openQty the same arithmetic is derived from the parts.
check("open is derived when the server omits openQty", lineOpenQty({ orderedQty: 10, receivedQty: 5, closedShortQty: 3 }) === 2);
check("open never goes below zero", lineOpenQty({ orderedQty: 5, receivedQty: 7, closedShortQty: 0, openQty: -2 }) === 0);

// The stepper cannot ask the server for more than is open (it would refuse the whole receipt).
check("received is capped at the open balance", clampReceived(second, 9) === 4);
check("received never goes below zero", clampReceived(second, -1) === 0);
check("a fully received line cannot be received again", clampReceived({ orderedQty: 5, receivedQty: 5, closedShortQty: 0, openQty: 0 }, 1) === 0);

// No decision chosen, or nothing short → nothing is sent (the line simply stays open).
check("no decision → no remainder request", remainderDecisionPayload(first, 6, undefined) === null);
check("receiving everything → no remainder request", remainderDecisionPayload(first, 10, "CLOSED_SHORT") === null);

// The page must route every remainder request through the helper.
const page = readFileSync(join(process.cwd(), "app/(shell)/inventory/supplier-purchases/[id]/receive/page.tsx"), "utf8");
check("the receive page builds remainder requests with remainderDecisionPayload", page.includes("remainderDecisionPayload("));
check("the receive page no longer compares against the ordered quantity", !/rec\s*<\s*line\.orderedQty/.test(page));

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
