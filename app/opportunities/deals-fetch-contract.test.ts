/**
 * Opportunities deals-fetch contract (Wave 3 · F-20). Run:
 *   npx tsx app/opportunities/deals-fetch-contract.test.ts
 *
 * Guards the trust invariants behind the "/opportunities shows Unauthorized"
 * fix: the page must fail closed on 401 and must never surface a raw server
 * error string as business data.
 */
import {
  DEALS_ERROR,
  resolveDealsOutcome,
  type DealsCall,
} from "./deals-fetch-contract";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const CALLS: DealsCall[] = ["fetch", "generate", "update"];

// --- 401 → fail closed, for every call, regardless of ok flag -------------
for (const call of CALLS) {
  const outcome = resolveDealsOutcome(call, { ok: false, status: 401 });
  ok(`${call}: 401 → unauthorized`, outcome.kind === "unauthorized", outcome);
  // A 401 outcome carries no message, so nothing server-authored can render.
  ok(
    `${call}: 401 outcome has no renderable message`,
    !("message" in outcome),
    outcome
  );
}

// --- other non-2xx → Hebrew message, never the raw server body ------------
for (const call of CALLS) {
  for (const status of [400, 403, 404, 409, 500, 503]) {
    const outcome = resolveDealsOutcome(call, { ok: false, status });
    ok(
      `${call}: ${status} → error outcome`,
      outcome.kind === "error",
      outcome
    );
    if (outcome.kind === "error") {
      ok(
        `${call}: ${status} → localized message`,
        outcome.message === DEALS_ERROR[call],
        outcome.message
      );
      // The message must be our Hebrew copy, not an English server string.
      ok(
        `${call}: ${status} → message is not raw English`,
        !/unauthorized|failed|error:/i.test(outcome.message),
        outcome.message
      );
    }
  }
}

// --- 2xx → ok, payload is used --------------------------------------------
for (const call of CALLS) {
  for (const status of [200, 201, 204]) {
    const outcome = resolveDealsOutcome(call, { ok: true, status });
    ok(`${call}: ${status} → ok`, outcome.kind === "ok", outcome);
  }
}

// --- every call has a distinct, non-empty Hebrew message ------------------
const messages = Object.values(DEALS_ERROR);
ok(
  "each call has a non-empty message",
  messages.every((m) => m.trim().length > 0),
  messages
);
ok(
  "messages are distinct per call",
  new Set(messages).size === messages.length,
  messages
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll deals-fetch-contract assertions passed");
