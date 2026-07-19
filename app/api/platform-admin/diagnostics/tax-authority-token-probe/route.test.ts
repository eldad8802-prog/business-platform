/**
 * Tax Authority token-probe route guard (run manually):
 *   npx tsx app/api/platform-admin/diagnostics/tax-authority-token-probe/route.test.ts
 *
 * Verifies the canonical Platform-Admin guard is enforced (non-admins are
 * blocked and never reach the probe; admins do) and that a successful response
 * is JSON with no-store and only the sanitized result.
 */

import { NextRequest, NextResponse } from "next/server";
import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import type { AuthorityTokenProbeResult } from "@/lib/services/billing/authority/billing-authority-token-probe.service";
import { handleAuthorityTokenProbe } from "@/app/api/platform-admin/diagnostics/tax-authority-token-probe/route";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

const req = () =>
  new NextRequest("https://app.test/api/platform-admin/diagnostics/tax-authority-token-probe", {
    method: "POST",
  });

const SAFE_RESULT: AuthorityTokenProbeResult = {
  networkReachable: false,
  httpStatusIfAny: null,
  networkErrorClass: "CONNECTION_REFUSED",
  requestDurationBucket: "<1s",
  runtime: "nodejs",
  region: "iad1",
};

const ADMIN: PlatformAdminUser = {
  id: 1,
  email: "admin@dubiz.test",
  name: "Admin",
  role: "PLATFORM_ADMIN" as PlatformAdminUser["role"],
};

async function main() {
  // Non-admin (403 from the canonical guard) → probe never runs.
  {
    let probeCalls = 0;
    const res = await handleAuthorityTokenProbe(req(), {
      authorize: async () =>
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      probe: async () => {
        probeCalls += 1;
        return SAFE_RESULT;
      },
    });
    ok("non-admin -> 403", res.status === 403);
    ok("non-admin -> probe not called", probeCalls === 0);
  }

  // Unauthenticated (401 from the guard) → probe never runs.
  {
    let probeCalls = 0;
    const res = await handleAuthorityTokenProbe(req(), {
      authorize: async () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      probe: async () => {
        probeCalls += 1;
        return SAFE_RESULT;
      },
    });
    ok("unauthenticated -> 401", res.status === 401);
    ok("unauthenticated -> probe not called", probeCalls === 0);
  }

  // Platform admin → probe runs once, safe JSON + no-store.
  {
    let probeCalls = 0;
    const res = await handleAuthorityTokenProbe(req(), {
      authorize: async () => ADMIN,
      probe: async () => {
        probeCalls += 1;
        return SAFE_RESULT;
      },
    });
    ok("admin -> 200", res.status === 200);
    ok("admin -> probe called exactly once", probeCalls === 1);
    ok("admin -> cache-control no-store", res.headers.get("cache-control") === "no-store");
    const body = (await res.json()) as Record<string, unknown>;
    ok(
      "admin -> body is exactly the sanitized result",
      JSON.stringify(Object.keys(body).sort()) ===
        JSON.stringify(Object.keys(SAFE_RESULT).sort())
    );
    ok("admin -> body carries no secrets/host", !JSON.stringify(body).includes("taxes.gov.il"));
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
