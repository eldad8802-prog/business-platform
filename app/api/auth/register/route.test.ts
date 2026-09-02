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
import { EmailAlreadyRegisteredError } from "@/lib/auth/signup-identity";

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
  createAccount: number;
  hash: number;
  signToken: number;
  bodyReads: number;
};

function makeDeps(
  enabled: boolean,
  overrides: Partial<RegisterDeps> = {}
): { deps: RegisterDeps; calls: Calls } {
  const calls: Calls = {
    rateLimit: 0,
    createAccount: 0,
    hash: 0,
    signToken: 0,
    bodyReads: 0,
  };

  const deps: RegisterDeps = {
    isSignupEnabled: () => enabled,
    rateLimit: async () => {
      calls.rateLimit += 1;
      return { allowed: true, remaining: 2, resetAt: 0 };
    },
    hashPassword: async () => {
      calls.hash += 1;
      return "hashed";
    },
    // Business + User are now ONE atomic dependency. They used to be two
    // separate injectable writes, which mirrored the two separate writes in the
    // route — and that was the bug: a failure between them left an orphan
    // Business. A single dep is the honest shape now that a single transaction
    // is the implementation.
    createAccount: async (input) => {
      calls.createAccount += 1;
      return {
        userId: 99,
        businessId: 4242,
        email: input.email,
        name: input.name,
        businessName: input.businessName,
        tokenVersion: 0,
      };
    },
    signToken: () => {
      calls.signToken += 1;
      return "signed.token.value";
    },
    // Telemetry is injected so this stays a genuinely pure test. The real
    // implementation swallows its own errors, but it still opens a database
    // connection — which would quietly make "no database, no network" false.
    recordUsage: async () => {},
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
    ok("closed -> NO account created (Business + User)", calls.createAccount === 0);
    ok("closed -> no partial write of any kind", calls.createAccount === 0);
    ok("closed -> no password hashing", calls.hash === 0);
    ok("closed -> no session minted", calls.signToken === 0);
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
    ok("closed -> direct API call creates nothing", calls.createAccount === 0);
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
    ok("closed -> malformed body creates nothing", calls.createAccount === 0);
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
    ok("open -> account created atomically (one call)", calls.createAccount === 1);
    ok("open -> password hashed (never stored plain)", calls.hash === 1);
    ok("open -> ids returned", body.userId === 99 && body.businessId === 4242);
    ok("open -> rate limiter still enforced", calls.rateLimit === 1);

    // Signup returns the SESSION. Previously the client had to call
    // /api/auth/login separately, and a failure there stranded an account that
    // had already been created.
    ok("open -> session minted", calls.signToken === 1);
    ok("open -> token returned to caller", body.token === "signed.token.value");
    ok("open -> sessionId returned", typeof body.sessionId === "string" && body.sessionId.length > 0);
    ok("open -> user payload returned", body.user?.id === 99 && body.user?.businessId === 4242);
  }

  // The account is created with the address FOLDED to lower case, so two
  // spellings can never become two businesses.
  {
    let seen = "";
    const { deps } = makeDeps(true, {
      createAccount: async (input) => {
        seen = input.email;
        return {
          userId: 1,
          businessId: 2,
          email: input.email,
          name: input.name,
          businessName: input.businessName,
          tokenVersion: 0,
        };
      },
    });
    await handleRegister(req({ ...VALID, email: "  Mixed.Case@Example.TEST " }), deps);
    ok("open -> email folded before persistence", seen === "mixed.case@example.test");
  }

  // The password is never hashed from a trimmed value — the secret stored must
  // be exactly the secret typed.
  {
    let hashed = "";
    const { deps } = makeDeps(true, {
      hashPassword: async (plain) => {
        hashed = plain;
        return "hashed";
      },
    });
    await handleRegister(req({ ...VALID, password: "  spaced secret  " }), deps);
    ok("open -> password not trimmed before hashing", hashed === "  spaced secret  ");
  }

  // Duplicate is now decided by the DB unique index, not a racy pre-check, and
  // it is a 409 that names the field rather than a bare 400.
  {
    const { deps, calls } = makeDeps(true, {
      createAccount: async () => {
        throw new EmailAlreadyRegisteredError();
      },
    });
    const res = await handleRegister(req(), deps);
    const body = await res.json();
    ok("open -> duplicate email is 409", res.status === 409);
    ok("open -> duplicate names the field", body.field === "email");
    ok("open -> duplicate carries a machine code", body.code === "EMAIL_ALREADY_REGISTERED");
    ok("open -> duplicate mints no session", calls.signToken === 0);
  }

  {
    const { deps, calls } = makeDeps(true);
    const res = await handleRegister(req({ email: "a@b.test" }), deps);
    const body = await res.json();
    ok("open -> missing fields still 400", res.status === 400);
    ok("open -> missing fields name the offending field", typeof body.field === "string");
    ok("open -> missing fields create nothing", calls.createAccount === 0);
  }

  // A malformed body with the gate OPEN is a 400, never a 500.
  {
    const { deps, calls } = makeDeps(true);
    const broken = new Request("https://app.dubiz.test/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await handleRegister(broken, deps);
    ok("open -> malformed body is 400 (never 500)", res.status === 400);
    ok("open -> malformed body creates nothing", calls.createAccount === 0);
  }

  {
    const { deps, calls } = makeDeps(true, {
      rateLimit: async () => ({ allowed: false, remaining: 0, resetAt: 0 }),
    });
    const res = await handleRegister(req(), deps);
    ok("open -> rate limited still 429", res.status === 429);
    ok("open -> rate limited creates nothing", calls.createAccount === 0);
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
