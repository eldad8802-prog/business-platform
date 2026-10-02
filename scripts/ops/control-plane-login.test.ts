/**
 * Safety tests for the Production control-plane login provisioner (scripts/ops/control-plane-login.ts).
 * No database: synthetic URLs and messages only — no real host password, no secret.
 *
 *   node_modules/.bin/tsx --test scripts/ops/control-plane-login.test.ts
 *
 *  1. Every URL precondition is fail-closed: exact user, verified endpoint, direct (non-pooler), host and
 *     database equal to the owner connection, password 32-128 of [A-Za-z0-9_-] (so the PASSWORD literal can
 *     never carry a quote).
 *  2. Redaction: no PASSWORD literal, no postgres URL and no registered password survives in an error.
 *  3. Authority is not broadened: the role attributes, the single GRANT and the connection limit are pinned
 *     in the source exactly as approved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseControlPlaneUrl, redact, registerSecretForRedaction } from "./control-plane-login";

const ENDPOINT = "ep-flat-brook-am4bhq1y";
const HOST = `${ENDPOINT}.c-0.example-region.aws.neon.tech`;
const OWNER = `postgresql://owner_user:ownerpw@${HOST}/proddb?sslmode=require`;
const PW = "T3st_only-" + "x".repeat(38); // 48 chars of the allowed charset, synthetic
const url = (user: string, pw: string, host: string, db: string) => `postgresql://${user}:${pw}@${host}/${db}?sslmode=require`;

test("accepts exactly the approved shape", () => {
  assert.deepEqual(parseControlPlaneUrl(url("app_ctlplane_prod", PW, HOST, "proddb"), ENDPOINT, OWNER), { password: PW });
});

const refused: [string, string][] = [
  ["wrong user", url("neondb_owner", PW, HOST, "proddb")],
  ["runtime user", url("app_runtime_prod", PW, HOST, "proddb")],
  ["foreign endpoint", url("app_ctlplane_prod", PW, "ep-some-other-123.c-0.example-region.aws.neon.tech", "proddb")],
  ["pooler host", url("app_ctlplane_prod", PW, `${ENDPOINT}-pooler.c-0.example-region.aws.neon.tech`, "proddb")],
  ["pgbouncer flag", url("app_ctlplane_prod", PW, HOST, "proddb") + "&pgbouncer=true"],
  ["host differs from owner", url("app_ctlplane_prod", PW, `${ENDPOINT}.c-9.other-region.aws.neon.tech`, "proddb")],
  ["database differs from owner", url("app_ctlplane_prod", PW, HOST, "otherdb")],
  ["empty database", `postgresql://app_ctlplane_prod:${PW}@${HOST}/?sslmode=require`],
  ["short password", url("app_ctlplane_prod", "short_pw", HOST, "proddb")],
  ["password with encoded quote", url("app_ctlplane_prod", PW.slice(0, 40) + "%27x", HOST, "proddb")],
  ["password with encoded space", url("app_ctlplane_prod", PW.slice(0, 40) + "%20x", HOST, "proddb")],
  ["password with encoded semicolon", url("app_ctlplane_prod", PW.slice(0, 40) + "%3Bx", HOST, "proddb")],
  ["not a postgres URL", `mysql://app_ctlplane_prod:${PW}@${HOST}/proddb`],
  ["missing", ""],
];
for (const [name, u] of refused) {
  test(`refuses: ${name}`, () => {
    assert.throws(() => parseControlPlaneUrl(u || undefined, ENDPOINT, OWNER), (e: Error) => e.name === "RefusedError");
  });
}

test("a refusal message never contains the URL or the password", () => {
  for (const [, u] of refused) {
    try { parseControlPlaneUrl(u || undefined, ENDPOINT, OWNER); } catch (e) {
      const m = redact((e as Error).message);
      assert.ok(!m.includes(PW), "password leaked");
      assert.ok(!/postgres(ql)?:\/\//i.test(m), "URL leaked");
    }
  }
});

test("redacts a PASSWORD literal, a postgres URL and a registered password", () => {
  const before = `Raw query failed: CREATE ROLE app_ctlplane_prod LOGIN PASSWORD '${PW}'; via ${url("app_ctlplane_prod", PW, HOST, "proddb")}`;
  const once = redact(before);
  assert.ok(!once.includes(PW));
  assert.match(once, /PASSWORD '<redacted>'/);
  assert.match(once, /<url>/);
  registerSecretForRedaction(PW);
  const bare = redact(`unexpected: ${PW} appeared bare`);
  assert.ok(!bare.includes(PW));
  assert.match(bare, /<redacted>/);
});

test("authority is pinned exactly as approved (attributes, single GRANT, connection limit)", () => {
  const src = readFileSync(new URL("./control-plane-login.ts", import.meta.url), "utf8");
  assert.match(src, /const LOGIN = "app_ctlplane_prod";/);
  assert.match(src, /const GROUP = "app_ctlplane";/);
  assert.match(src, /const CONNECTION_LIMIT = 5;/);
  assert.match(src, /`LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT \$\{CONNECTION_LIMIT\}`/);
  const grants = src.match(/\bGRANT\s+[^`]*/g) ?? [];
  assert.deepEqual(grants, ["GRANT ${GROUP} TO ${LOGIN}"], "exactly one GRANT, of the group, to the login");
  // Every elevated attribute appears only in its NO… form.
  const withoutNegations = src.replace(/\bNO(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION)\b/g, "");
  assert.ok(!/\b(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION)\b/.test(withoutNegations), "no elevated attribute is ever granted");
  assert.ok(!/DROP\s+ROLE/i.test(src), "the role is never dropped");
  // The PASSWORD literal is only ever built from the charset-validated password.
  for (const m of src.match(/PASSWORD '\$\{(\w+)\}'/g) ?? []) assert.equal(m, "PASSWORD '${password}'");
  assert.match(src, /if \(!\/\^\[A-Za-z0-9_-\]\{32,128\}\$\/\.test\(password\)\) throw new RefusedError\("password shape"\);/);
});
