/**
 * TEMPORARY — tests for the Tax Authority token-probe UI logic.
 *   npx tsx components/platform-admin/tax-authority-probe-logic.test.ts
 *
 * All tests use mocked probe requests — the real probe is never invoked, so no
 * network call happens during test/build/CI.
 */

import { PlatformAdminFetchError } from "@/lib/platform-admin/fetch-platform-admin";
import type { TokenProbeInvocation } from "@/lib/platform-admin/fetch-platform-admin";
import {
  createProbeRunner,
  executeTokenProbe,
  parseProbeResult,
  sanitizeProbeErrorMessage,
  type ProbeRunnerState,
} from "./tax-authority-probe-logic";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const VALID_BODY = {
  networkReachable: false,
  httpStatusIfAny: null,
  networkErrorClass: "CONNECTION_REFUSED",
  requestDurationBucket: "<1s",
  runtime: "nodejs",
  region: "iad1",
  // an extra server field must NOT leak into the view:
  secretLeak: "SHOULD-NOT-APPEAR",
};

function countingRequest(
  impl: () => Promise<TokenProbeInvocation>
): { fn: () => Promise<TokenProbeInvocation>; calls: () => number } {
  let calls = 0;
  return {
    fn: () => {
      calls += 1;
      return impl();
    },
    calls: () => calls,
  };
}

async function collectStates(
  run: (onState: (s: ProbeRunnerState) => void) => Promise<void>
): Promise<ProbeRunnerState[]> {
  const states: ProbeRunnerState[] = [];
  await run((s) => states.push(s));
  return states;
}

async function main() {
  // ---- parseProbeResult (strict validation) --------------------------------
  {
    const parsed = parseProbeResult(VALID_BODY);
    ok("valid body parses", parsed !== null);
    ok(
      "parsed exposes exactly the six fields",
      parsed !== null &&
        JSON.stringify(Object.keys(parsed).sort()) ===
          JSON.stringify(
            [
              "httpStatusIfAny",
              "networkErrorClass",
              "networkReachable",
              "region",
              "requestDurationBucket",
              "runtime",
            ].sort()
          )
    );
    ok(
      "parsed drops unknown/extra fields",
      parsed !== null && !("secretLeak" in parsed)
    );
    ok("null body rejected", parseProbeResult(null) === null);
    ok("wrong-typed body rejected", parseProbeResult({ networkReachable: "no" }) === null);
    ok("missing field rejected", parseProbeResult({ networkReachable: true }) === null);
  }

  // ---- sanitizeProbeErrorMessage ------------------------------------------
  ok("401 sanitized", sanitizeProbeErrorMessage(401).includes("401"));
  ok("403 sanitized", sanitizeProbeErrorMessage(403).includes("403"));
  ok("500 sanitized", sanitizeProbeErrorMessage(500).includes("500"));
  ok("null (network) sanitized", sanitizeProbeErrorMessage(null).includes("HTTP"));

  // ---- executeTokenProbe: success -> view with 7 fields only ---------------
  {
    const outcome = await executeTokenProbe(async () => ({
      routeHttpStatus: 200,
      result: VALID_BODY,
    }));
    ok("success -> succeeded", outcome.phase === "succeeded");
    if (outcome.phase === "succeeded") {
      const keys = Object.keys(outcome.view).sort();
      ok(
        "view has exactly 7 allowed fields",
        JSON.stringify(keys) ===
          JSON.stringify(
            [
              "httpStatusIfAny",
              "networkErrorClass",
              "networkReachable",
              "region",
              "requestDurationBucket",
              "routeHttpStatus",
              "runtime",
            ].sort()
          )
      );
      ok("view.routeHttpStatus = 200", outcome.view.routeHttpStatus === 200);
      const serialized = JSON.stringify(outcome).toLowerCase();
      ok("no leaked extra field in view", !serialized.includes("secretleak"));
    }
  }

  // ---- executeTokenProbe: HTTP errors keep routeHttpStatus + sanitized ------
  for (const status of [401, 403, 500]) {
    const outcome = await executeTokenProbe(async () => {
      throw new PlatformAdminFetchError("raw provider text", status);
    });
    ok(`${status} -> failed`, outcome.phase === "failed");
    if (outcome.phase === "failed") {
      ok(`${status} -> routeHttpStatus kept`, outcome.routeHttpStatus === status);
      ok(`${status} -> message sanitized (status only)`, outcome.message.includes(String(status)));
      ok(`${status} -> no raw provider text`, !outcome.message.includes("raw provider text"));
    }
  }

  // ---- executeTokenProbe: network failure -> routeHttpStatus null -----------
  {
    const outcome = await executeTokenProbe(async () => {
      throw new TypeError("fetch failed connecting to 199.203.206.249");
    });
    ok("network failure -> failed", outcome.phase === "failed");
    if (outcome.phase === "failed") {
      ok("network failure -> routeHttpStatus null", outcome.routeHttpStatus === null);
      ok(
        "network failure -> host/ip not leaked",
        !outcome.message.includes("199.203.206.249") && !outcome.message.includes("fetch failed")
      );
    }
  }

  // ---- executeTokenProbe: malformed body does not leak ---------------------
  {
    const outcome = await executeTokenProbe(async () => ({
      routeHttpStatus: 200,
      result: { unexpected: "RAW-SHAPE" },
    }));
    ok("malformed body -> failed", outcome.phase === "failed");
    if (outcome.phase === "failed") {
      ok("malformed -> keeps routeHttpStatus", outcome.routeHttpStatus === 200);
      ok("malformed -> raw shape not leaked", !JSON.stringify(outcome).includes("RAW-SHAPE"));
    }
  }

  // ---- Single-shot runner: one POST, locked after first attempt ------------
  {
    const req = countingRequest(async () => ({ routeHttpStatus: 200, result: VALID_BODY }));
    const states = await collectStates(async (onState) => {
      const runner = createProbeRunner({ probeRequest: req.fn, onState });
      // concurrent double-click
      await Promise.all([runner.run(), runner.run()]);
      // post-completion clicks
      await runner.run();
      await runner.run();
    });
    ok("double-click + later clicks -> exactly ONE request", req.calls() === 1);
    ok("ends in a terminal state", states[states.length - 1].phase === "succeeded");
  }

  // ---- Locked after HTTP error and after network failure -------------------
  for (const thrower of [
    () => {
      throw new PlatformAdminFetchError("x", 403);
    },
    () => {
      throw new TypeError("fetch failed");
    },
  ]) {
    const req = countingRequest(async () => {
      thrower();
      return { routeHttpStatus: 0, result: {} };
    });
    await collectStates(async (onState) => {
      const runner = createProbeRunner({ probeRequest: req.fn, onState });
      await runner.run();
      await runner.run(); // must NOT send another request after a failure
    });
    ok("locked after failure -> exactly ONE request", req.calls() === 1);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
