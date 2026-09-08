/**
 * Auth-plane identity probe route guard (run manually):
 *   npx tsx app/api/platform-admin/diagnostics/auth-plane-identity/route.test.ts
 *
 * Verifies the canonical Platform-Admin guard is enforced (non-admins are
 * blocked and never reach the database), that the response carries a boolean
 * and nothing else, and that the role name never leaves the server.
 */

import { NextRequest, NextResponse } from "next/server";
import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import {
  EXPECTED_AUTH_ROLE,
  handleAuthPlaneIdentityProbe,
} from "@/app/api/platform-admin/diagnostics/auth-plane-identity/route";

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
  new NextRequest(
    "https://app.test/api/platform-admin/diagnostics/auth-plane-identity",
    { method: "POST" }
  );

const ADMIN: PlatformAdminUser = {
  id: 1,
  email: "admin@dubiz.test",
  name: "Admin",
  role: "PLATFORM_ADMIN" as PlatformAdminUser["role"],
};

async function main() {
  // Unauthorized (401 from the canonical guard) → the database is never touched.
  {
    let reads = 0;
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () =>
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      readCurrentUser: async () => {
        reads += 1;
        return EXPECTED_AUTH_ROLE;
      },
    });
    ok("unauthorized -> 401", res.status === 401);
    ok("unauthorized -> no database read", reads === 0);
  }

  // Non-admin (403) → same.
  {
    let reads = 0;
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () =>
        NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      readCurrentUser: async () => {
        reads += 1;
        return EXPECTED_AUTH_ROLE;
      },
    });
    ok("non-admin -> 403", res.status === 403);
    ok("non-admin -> no database read", reads === 0);
  }

  // Admin + expected role → matchesExpected true, and NOTHING else in the body.
  {
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () => ADMIN,
      readCurrentUser: async () => EXPECTED_AUTH_ROLE,
    });
    const body = (await res.json()) as Record<string, unknown>;
    ok("admin -> 200", res.status === 200);
    ok("admin -> matchesExpected true", body.matchesExpected === true);
    ok(
      "response has exactly one key",
      Object.keys(body).length === 1 && Object.keys(body)[0] === "matchesExpected"
    );
    ok(
      "response never carries the role name",
      !JSON.stringify(body).includes(EXPECTED_AUTH_ROLE)
    );
    ok(
      "response is not cached",
      res.headers.get("cache-control") === "no-store"
    );
  }

  // Admin + any other role → false, still no role name on the wire.
  {
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () => ADMIN,
      readCurrentUser: async () => "app_runtime_prod",
    });
    const body = (await res.json()) as Record<string, unknown>;
    ok("wrong role -> matchesExpected false", body.matchesExpected === false);
    ok(
      "wrong role -> role name still withheld",
      !JSON.stringify(body).includes("app_runtime_prod")
    );
  }

  // No row at all → false, not a crash and not an optimistic pass.
  {
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () => ADMIN,
      readCurrentUser: async () => null,
    });
    const body = (await res.json()) as Record<string, unknown>;
    ok("no row -> matchesExpected false", body.matchesExpected === false);
  }

  // A driver failure must fail closed with a generic body, never the message —
  // a connection error can carry the URL.
  {
    const secret = "postgresql://user:pw@host/db";
    const res = await handleAuthPlaneIdentityProbe(req(), {
      authorize: async () => ADMIN,
      readCurrentUser: async () => {
        throw new Error(`connect failed: ${secret}`);
      },
    });
    const raw = await res.text();
    ok("driver failure -> 500", res.status === 500);
    ok("driver failure -> body carries no connection string", !raw.includes(secret));
    ok("driver failure -> no matchesExpected true", !raw.includes("true"));
  }

  // The statement itself is constant: no interpolation, no parameters.
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("./route.ts", import.meta.url),
      "utf8"
    );
    const raw = src.match(/\$queryRaw[\s\S]*?`([\s\S]*?)`/);
    ok("uses $queryRaw with a constant statement", raw?.[1] === "SELECT current_user");
    ok(
      "no template interpolation in the statement",
      raw?.[1] !== undefined && !raw[1].includes("${")
    );
    ok("reads through authDb(), not a new client", /\bauthDb\(\)/.test(src));
    // Matched as CODE, not as prose: the header explains why AUTH_DATABASE_URL
    // cannot be read, so a name-only grep would fail on the comment that exists
    // to justify the design.
    ok(
      "does not build its own connection",
      !/new\s+PrismaClient/.test(src) && !/process\s*\.\s*env/.test(src)
    );
    ok(
      "uses the MFA-aware canonical guard",
      /requirePlatformAdminOrResponse/.test(src) &&
        !/requirePlatformAdminIdentity/.test(src)
    );
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

void main();
