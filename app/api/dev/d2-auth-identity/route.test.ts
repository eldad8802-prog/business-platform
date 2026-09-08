/**
 * TEMPORARY D2 STAGE D PROBE — MUST BE REMOVED IN PR-B AFTER PRODUCTION IDENTITY PROOF
 *
 * The probe exists to answer one question in Production, so these pin the
 * properties that make it safe to put there at all: that it refuses in every
 * configuration it has not been deliberately opted into, that it reaches the
 * database only through the auth plane, and that a broken auth plane produces
 * an error rather than an answer from some other identity.
 *
 * The last one matters most. A probe that fell back would report the reassuring
 * result precisely when the thing being proven had failed.
 *
 * Run: npx tsx app/api/dev/d2-auth-identity/route.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const queue: Array<() => Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
  queue.push(async () => {
    try {
      await fn();
      pass += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      fail += 1;
      console.log(`  [FAIL] ${name} — ${String((e as Error)?.message ?? e).slice(0, 240)}`);
    }
  });
}

/** Comments are stripped: the file documents what it does NOT do, and a raw scan
 *  would match the prose explaining the guarantee rather than the code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const SRC = code(readFileSync(new URL("./route.ts", import.meta.url), "utf8"));

const TOKEN = "d2-probe-token-for-tests-only-not-a-secret";
const request = (headers: Record<string, string> = {}) =>
  new Request("https://example.invalid/api/dev/d2-auth-identity", { headers });

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log("== D2 Stage D auth-identity probe ==");

// ---- refuses in every unconfigured or unauthorised shape -------------------
test("no D2_AUTH_PROBE_TOKEN configured -> 404 (inert by default)", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: undefined, AUTH_PLANE_ENABLED: "false" }, async () => {
    const { GET } = await import("./route");
    const res = await GET(request({ "x-d2-auth-probe": TOKEN }));
    assert.equal(res.status, 404);
  }));

test("empty D2_AUTH_PROBE_TOKEN -> 404", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: "   ", AUTH_PLANE_ENABLED: "false" }, async () => {
    const { GET } = await import("./route");
    const res = await GET(request({ "x-d2-auth-probe": TOKEN }));
    assert.equal(res.status, 404);
  }));

test("missing header -> 404", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: TOKEN, AUTH_PLANE_ENABLED: "false" }, async () => {
    const { GET } = await import("./route");
    const res = await GET(request());
    assert.equal(res.status, 404);
  }));

test("wrong header -> 404", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: TOKEN, AUTH_PLANE_ENABLED: "false" }, async () => {
    const { GET } = await import("./route");
    const res = await GET(request({ "x-d2-auth-probe": TOKEN + "x" }));
    assert.equal(res.status, 404);
  }));

test("a header of a different length -> 404, not a crash", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: TOKEN, AUTH_PLANE_ENABLED: "false" }, async () => {
    // The digest compare exists so mismatched lengths are handled without an
    // early return; a raw timingSafeEqual on unequal buffers throws.
    const { GET } = await import("./route");
    const res = await GET(request({ "x-d2-auth-probe": "short" }));
    assert.equal(res.status, 404);
  }));

test("refusal is 404, never 401 (existence is not disclosed)", () => {
  assert.ok(!/\b401\b/.test(SRC), "the route can answer 401, which discloses that it exists");
  assert.ok(/404/.test(SRC));
});

// ---- fail-closed when the auth plane is unusable ---------------------------
test("an unusable auth plane errors rather than answering", () =>
  withEnv({ D2_AUTH_PROBE_TOKEN: TOKEN, AUTH_PLANE_ENABLED: "true", AUTH_DATABASE_URL: undefined },
    async () => {
      const { GET } = await import("./route");
      await assert.rejects(() => GET(request({ "x-d2-auth-probe": TOKEN })),
        /AUTH_DATABASE_URL is not configured/);
    }));

// ---- reaches the database through the auth plane only ----------------------
test("the route imports only the auth client", () => {
  assert.ok(/from "@\/lib\/prisma-auth"/.test(SRC), "the auth client import is gone");
  assert.ok(!/from "@\/lib\/prisma"/.test(SRC), "the route imports the tenant client");
  assert.ok(!/prisma-admin|prisma-control-plane/.test(SRC), "the route reaches an admin plane");
});

test("every database call goes through authDb()", () => {
  const calls = SRC.match(/\$queryRaw\w*|\$executeRaw\w*|\$transaction/g) ?? [];
  assert.equal(calls.length, 1, `expected exactly one database call, found ${calls.length}`);
  assert.ok(/authDb\(\)\.\$queryRawUnsafe/.test(SRC), "the single call is not on authDb()");
});

test("there is no fallback path to another client", () => {
  const catches = SRC.split(/\bcatch\b/).slice(1).join("\n");
  assert.ok(!/authDb|prisma/.test(catches), "a client is selected inside a catch block");
});

// ---- the query and the response are the minimum ----------------------------
test("the query is exactly SELECT current_user, with no input interpolated", () => {
  assert.ok(/SELECT current_user::text AS current_user/.test(SRC), "the query changed shape");
  assert.ok(!/\$\{/.test(SRC.split("$queryRawUnsafe")[1] ?? ""), "input is interpolated into the query");
});

test("no mutation is possible", () => {
  // Scoped to the SQL the route actually sends. A scan of the whole file matches
  // `createHash(...).update(...)` and would fail on the digest compare, which is
  // not a database statement at all — the assertion has to look where SQL is.
  const sql = (SRC.match(/`[^`]*`/g) ?? []).join("\n");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql),
    `the route's SQL contains a mutating statement: ${sql.slice(0, 120)}`);
  assert.ok(!/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(SRC),
    "the route exposes a mutating HTTP method");
});

test("the response carries only the role name", () => {
  const forbidden = ["is_superuser", "bypassrls", "memberships", "owned_relations", "rolinherit",
    "pg_has_role", "current_database", "inet_server", "search_path", "DATABASE_URL"];
  for (const f of forbidden) {
    assert.ok(!SRC.includes(f), `the route can disclose ${f}`);
  }
  assert.ok(/NextResponse\.json\(\{ currentUser:/.test(SRC), "the response shape changed");
});

test("the token is never logged or echoed", () => {
  assert.ok(!/console\.(log|error|warn|info|debug)/.test(SRC), "the route logs");
  // The property that matters is that neither secret reaches the response. The
  // earlier form split on the function name and caught the call's own arguments,
  // so it failed on the gate itself rather than on any disclosure.
  const responses = SRC.match(/NextResponse\.json\([^;]*\)/g) ?? [];
  for (const r of responses) {
    assert.ok(!/presented|expected|PROBE_TOKEN/.test(r), `a response can carry the token: ${r}`);
  }
  assert.ok(!/headers\.get\([^)]*\)[^;]*NextResponse/.test(SRC), "a header value flows into a response");
});

// ---- the removal contract --------------------------------------------------
test("the file states, in the file, that PR-B must remove it", () => {
  const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.ok(raw.includes(
    "TEMPORARY D2 STAGE D PROBE — MUST BE REMOVED IN PR-B AFTER PRODUCTION IDENTITY PROOF"),
    "the removal notice is missing");
});

async function main() {
  for (const t of queue) await t();
  console.log(`\n[d2-auth-identity] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

void main();
