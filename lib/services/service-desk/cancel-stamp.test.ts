/**
 * Run: npx tsx lib/services/service-desk/cancel-stamp.test.ts
 *
 * 1d-A changed stampsFor: a cancel only REQUESTED while the item is at a supplier now stamps cancelledAt (CHECK
 * ServiceCase_cancel_stamp requires it). Pure proof (no database) that no existing cancel flow changed: every CANCEL the
 * core allows — every kind × every status CANCEL starts from × quote / reservations / a pending request — stamps exactly
 * as before, except a cancel from EXTERNAL, which before this PR was refused by the database. Every allowed result
 * satisfies the CHECK, and no other action ever stamps a cancel.
 */
import { ACTION_FROM, evaluateTransition } from "./service-case.core";
import { stampsFor } from "./service-case.service";
import { SERVICE_CASE_KINDS, type ServiceCaseActor, type ServiceCaseContext, type ServiceQuoteSnapshot, type ServiceTransitionDecision } from "./contracts";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}

const OWNER: ServiceCaseActor = { kind: "OWNER", userId: 70 };
const QUOTES: (ServiceQuoteSnapshot | null)[] = [
  null,
  { version: 1, totalAgorot: 45_000, docHash: "h1", state: "SENT", approval: null },
  { version: 1, totalAgorot: 45_000, docHash: "h1", state: "APPROVED", approval: { version: 1, totalAgorot: 45_000, docHash: "h1", method: "PHONE" } },
];
function ctx(o: Partial<ServiceCaseContext>): ServiceCaseContext {
  return {
    kind: "IN_SHOP", status: "OPEN", holdReason: null, outcome: null, version: 3, staffMemberId: 5, siteId: null, coverage: null,
    currentQuote: null, intake: { conditionRecorded: true, accessoriesRecorded: true, customerSigned: true }, qaChecklistCompleted: true,
    openPartReservations: 0, openLoaner: false, pickupRemindersSent: 0, cancellationRequested: false,
    settlement: { known: true, openBalanceAgorot: 0 }, ...o,
  };
}
type Ok = Extract<ServiceTransitionDecision, { ok: true }>;

let allowed = 0, sameAsBefore = 0, fromExternal = 0, checkHolds = 0;
const changedOutsideExternal: string[] = [];
for (const kind of SERVICE_CASE_KINDS) {
  for (const status of ACTION_FROM.CANCEL) {
    for (const currentQuote of QUOTES) {
      for (const openPartReservations of [0, 2]) {
        for (const cancellationRequested of status === "EXTERNAL" ? [false, true] : [false]) {
          const c = ctx({ kind, status, currentQuote, openPartReservations, cancellationRequested, outcome: status === "READY" ? "REPAIRED" : null });
          const d = evaluateTransition(c, { type: "CANCEL", reason: "הלקוח ביטל" }, OWNER);
          if (!d.ok) continue;
          allowed++;
          const before = d.action === "CANCEL" && d.outcome === "CANCELLED"; // the formula before 1d-A
          const now = stampsFor(d as Ok).cancelled;
          if (status === "EXTERNAL") { if (now && !before && d.to === "EXTERNAL" && d.cancellationRequestedAfter) fromExternal++; }
          else if (now === before) sameAsBefore++;
          else changedOutsideExternal.push(`${kind}/${status}`);
          // CHECK ServiceCase_cancel_stamp on the row the service writes (a stamp already set stays: write-once)
          const stamped = now || cancellationRequested;
          if ((d.outcome !== "CANCELLED" && !d.cancellationRequestedAfter) || stamped) checkHolds++;
        }
      }
    }
  }
}
ok("C1 the matrix produced allowed cancels from every status CANCEL starts from", allowed >= ACTION_FROM.CANCEL.length * SERVICE_CASE_KINDS.length, String(allowed));
ok("C2 every allowed cancel outside EXTERNAL stamps exactly as before the change", changedOutsideExternal.length === 0 && sameAsBefore + fromExternal <= allowed && sameAsBefore > 0,
  changedOutsideExternal.join(", "));
ok("C3 a cancel from EXTERNAL is requested only (stays EXTERNAL, request pending) and is now stamped", fromExternal > 0 && sameAsBefore + fromExternal === allowed, `${fromExternal} external, ${sameAsBefore} other, ${allowed} allowed`);
ok("C4 every allowed cancel leaves a row that satisfies CHECK ServiceCase_cancel_stamp", checkHolds === allowed, `${checkHolds}/${allowed}`);

// No other action stamps a cancel, even while a request is pending (the return that completes it keeps the first stamp).
const others = (Object.keys(ACTION_FROM) as (keyof typeof ACTION_FROM)[]).filter((a) => a !== "CANCEL");
const stampsOther = others.filter((a) => stampsFor({ ok: true, action: a, outcome: "CANCELLED", cancellationRequestedAfter: true, statusChanged: true, to: "READY" } as unknown as Ok).cancelled);
ok("C5 no action other than CANCEL stamps cancelledAt (RETURN_FROM_EXTERNAL included)", stampsOther.length === 0 && others.includes("RETURN_FROM_EXTERNAL"), stampsOther.join(", "));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
