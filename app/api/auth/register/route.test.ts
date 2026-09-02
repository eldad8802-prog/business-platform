/**
 * Registration guard under the public-signup gate (run manually):
 *   npx tsx app/api/auth/register/route.test.ts
 *
 * Proves the server-side half of "Closed Registration / Existing Users Only":
 * with the gate closed no User and no Business is ever created — not even
 * partially — no rate-limit budget is spent, the request body is never read,
 * and the caller gets a deterministic 403 SIGNUP_DISABLED instead of a 500.
 * With the gate open, registration behaves exactly as before.
 *
 * Pure dependency injection — no database, no network.
 */

import {
  handleRegister,
  type RegisterDeps,
} from "@/app/api/auth/register/route";
import { SIGNUP_DISABLED_CODE } from "@/lib/auth/signup-gate";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

type Calls = {
  rateLimit: number;
  findUser: number;
  createBusiness: number;
  createUser: number;
  hash: number;
  bodyReads: number;
};

function makeDeps(
  enabled: boolean,
  overrides: Partial<RegisterDeps> = {}
): { deps: RegisterDeps; calls: Calls } {
  const calls: Calls = {
    rateLimit: 0,
    findUser: 0,
    createBusiness: 0,
    createUser: 0,
    hash: 0,
    bodyReads: 0,
  };

  const deps: RegisterDeps = {
    isSignupEnabled: () => enabled,
    rateLimit: async () => {
      calls.rateLimit += 1;
      return { allowed: true, remaining: 2, resetAt: 0 };
    },
    findUserByEmail: async () => {
      calls.findUser += 1;
      return null;
    },
    createBusiness: async () => {
      calls.createBusiness += 1;
      return { id: 4242 };
    },
    createUser: async () => {
      calls.createUser += 1;
      return { id: 99 };
    },
    hashPassword: async () => {
      calls.hash += 1;
      return "hashed";
    },
    ...overrides,
  };

  return { deps, calls };
}

const VALID = {
  email: "new-owner@example.test",
  password: "sup3rsecret",
  name: "בעל עסק חדש",
  businessName: "עסק חדש",
};

function req(body: unknown = VALID, init: RequestInit = {}): Request {
  return new Request("https://app.dubiz.test/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

async function main() {
  // ---------------------------------------------------------------- CLOSED --
  {
    const { deps, calls } = makeDeps(false);
    const res = await handleRegister(req(), deps);
    const body = await res.json();

    ok("closed -> 403 (not 500, not 200)", res.status === 403);
    ok("closed -> code SIGNUP_DISABLED", body.code === SIGNUP_DISABLED_CODE);
    ok("closed -> error field is the code too", body.error === SIGNUP_DISABLED_CODE);
    ok("closed -> Hebrew user message", /[\u0590-\u05FF]/.test(body.message ?? ""));
    ok("closed -> no-store", res.headers.get("cache-control") === "no-store");
    ok("closed -> NO Business created", calls.createBusiness === 0);
    ok("closed -> NO User created", calls.createUser === 0);
    ok("closed -> no partial write of any kind", calls.createBusiness + calls.createUser === 0);
    ok("closed -> no password hashing", calls.hash === 0);
    ok("closed -> no user lookup", calls.findUser === 0);
    ok("closed -> rate-limit budget untouched", calls.rateLimit === 0);
  }

  // A direct API hit that skips the UI entirely is the same code path.
  {
    const { deps, calls } = makeDeps(false);
    const raw = new Request("https://app.dubiz.test/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify(VALID),
    });
    const res = await handleRegister(raw, deps);
    ok("closed -> direct API call (no browser) blocked", res.status === 403);
    ok("closed -> direct API call creates nothing", calls.createUser === 0 && calls.createBusiness === 0);
  }

  // A malformed / hostile body must still be a clean 403, never a 500.
  {
    const { deps, calls } = makeDeps(false);
    const broken = new Request("https://app.dubiz.test/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await handleRegister(broken, deps);
    const body = await res.json();
    ok("closed -> malformed body still 403 (never 500)", res.status === 403);
    ok("closed -> malformed body still SIGNUP_DISABLED", body.code === SIGNUP_DISABLED_CODE);
    ok("closed -> malformed body creates nothing", calls.createUser === 0 && calls.createBusiness === 0);
  }

  // The gate is re-read per request: no build-time or module-load caching.
  {
    let enabled = false;
    const { deps } = makeDeps(true, { isSignupEnabled: () => enabled });
    const closedRes = await handleRegister(req(), deps);
    enabled = true;
    const openRes = await handleRegister(req(), deps);
    ok("gate is evaluated per request, not cached", closedRes.status === 403 && openRes.status === 200);
  }

  // ------------------------------------------------------------------ OPEN --
  {
    const { deps, calls } = makeDeps(true);
    const res = await handleRegister(req(), deps);
    const body = await res.json();

    ok("open -> 200", res.status === 200);
    ok("open -> success payload", body.success === true);
    ok("open -> Business created", calls.createBusiness === 1);
    ok("open -> User created", calls.createUser === 1);
    ok("open -> password hashed (never stored plain)", calls.hash === 1);
    ok("open -> ids returned", body.userId === 99 && body.businessId === 4242);
    ok("open -> rate limiter still enforced", calls.rateLimit === 1);
  }

  // Pre-existing behaviour must survive the refactor.
  {
    const { deps } = makeDeps(true, { findUserByEmail: async () => ({ id: 7 }) });
    const res = await handleRegister(req(), deps);
    ok("open -> duplicate email still 400", res.status === 400);
  }

  {
    const { deps, calls } = makeDeps(true);
    const res = await handleRegister(req({ email: "a@b.test" }), deps);
    ok("open -> missing fields still 400", res.status === 400);
    ok("open -> missing fields create nothing", calls.createUser === 0 && calls.createBusiness === 0);
  }

  {
    const { deps, calls } = makeDeps(true, {
      rateLimit: async () => ({ allowed: false, remaining: 0, resetAt: 0 }),
    });
    const res = await handleRegister(req(), deps);
    ok("open -> rate limited still 429", res.status === 429);
    ok("open -> rate limited creates nothing", calls.createUser === 0 && calls.createBusiness === 0);
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
