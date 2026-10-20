/**
 * Safety tests for the Production retention login provisioner (scripts/ops/task-retention-login.ts).
 * No database: synthetic URLs and messages only — no real host, password or secret.
 *
 *   node_modules/.bin/tsx --test scripts/ops/task-retention-login.test.ts
 *
 *  1. Every URL precondition is fail-closed: exact user, verified endpoint, direct (non-pooler), host and
 *     database equal to the owner connection, password 32-128 of [A-Za-z0-9_-].
 *  2. Redaction: no PASSWORD literal, no postgres URL and no registered password survives in an error.
 *  3. Authority is not broadened: the attributes, the connection limit and exactly two GRANTs (EXECUTE on the
 *     two operational functions) are pinned in the source; no role membership, no H3 function, no table grant.
 *  (What the login can actually reach is proven on PostgreSQL by task-retention-login-lab.yml.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRetentionUrl, redact, registerSecretForRedaction } from "./task-retention-login";

const ENDPOINT = "ep-flat-brook-am4bhq1y";
const HOST = `${ENDPOINT}.c-0.example-region.aws.neon.tech`;
const OWNER = `postgresql://owner_user:ownerpw@${HOST}/proddb?sslmode=require`;
const PW = "T3st_only-" + "y".repeat(38); // 48 chars of the allowed charset, synthetic
const url = (user: string, pw: string, host: string, db: string) => `postgresql://${user}:${pw}@${host}/${db}?sslmode=require`;

test("accepts exactly the approved shape", () => {
  assert.deepEqual(parseRetentionUrl(url("task_retention_login", PW, HOST, "proddb"), ENDPOINT, OWNER), { password: PW });
});

const refused: [string, string][] = [
  ["wrong user", url("neondb_owner", PW, HOST, "proddb")],
  ["the maintenance group itself", url("task_maintenance", PW, HOST, "proddb")],
  ["runtime user", url("app_runtime_prod", PW, HOST, "proddb")],
  ["control-plane user", url("app_ctlplane_prod", PW, HOST, "proddb")],
  ["foreign endpoint", url("task_retention_login", PW, "ep-some-other-123.c-0.example-region.aws.neon.tech", "proddb")],
  ["pooler host", url("task_retention_login", PW, `${ENDPOINT}-pooler.c-0.example-region.aws.neon.tech`, "proddb")],
  ["pgbouncer flag", url("task_retention_login", PW, HOST, "proddb") + "&pgbouncer=true"],
  ["host differs from owner", url("task_retention_login", PW, `${ENDPOINT}.c-9.other-region.aws.neon.tech`, "proddb")],
  ["database differs from owner", url("task_retention_login", PW, HOST, "otherdb")],
  ["empty database", `postgresql://task_retention_login:${PW}@${HOST}/?sslmode=require`],
  ["short password", url("task_retention_login", "short_pw", HOST, "proddb")],
  ["password with encoded quote", url("task_retention_login", PW.slice(0, 40) + "%27x", HOST, "proddb")],
  ["password with encoded space", url("task_retention_login", PW.slice(0, 40) + "%20x", HOST, "proddb")],
  ["password with encoded semicolon", url("task_retention_login", PW.slice(0, 40) + "%3Bx", HOST, "proddb")],
  ["not a postgres URL", `mysql://task_retention_login:${PW}@${HOST}/proddb`],
  ["missing", ""],
];
for (const [name, u] of refused) {
  test(`refuses: ${name}`, () => {
    assert.throws(() => parseRetentionUrl(u || undefined, ENDPOINT, OWNER), (e: Error) => e.name === "RefusedError");
  });
}

test("a refusal message never contains the URL or the password", () => {
  for (const [, u] of refused) {
    try { parseRetentionUrl(u || undefined, ENDPOINT, OWNER); } catch (e) {
      const m = redact((e as Error).message);
      assert.ok(!m.includes(PW), "password leaked");
      assert.ok(!/postgres(ql)?:\/\//i.test(m), "URL leaked");
    }
  }
});

test("redacts a PASSWORD literal, a postgres URL and a registered password", () => {
  const before = `Raw query failed: CREATE ROLE task_retention_login LOGIN PASSWORD '${PW}'; via ${url("task_retention_login", PW, HOST, "proddb")}`;
  const once = redact(before);
  assert.ok(!once.includes(PW));
  assert.match(once, /PASSWORD '<redacted>'/);
  assert.match(once, /<url>/);
  registerSecretForRedaction(PW);
  const bare = redact(`unexpected: ${PW} appeared bare`);
  assert.ok(!bare.includes(PW));
  assert.match(bare, /<redacted>/);
});

test("authority is pinned exactly as approved (attributes, two EXECUTE grants, no membership)", () => {
  const src = readFileSync(new URL("./task-retention-login.ts", import.meta.url), "utf8");
  assert.match(src, /const LOGIN = "task_retention_login";/);
  assert.match(src, /const OPERATIONAL = \["task_retention_purge_request_ledger", "task_retention_clear_event_digests"\];/);
  assert.match(src, /const CONNECTION_LIMIT = 2;/);
  assert.match(src, /`LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT \$\{CONNECTION_LIMIT\}`/);
  assert.match(src, /const rotateAttrs = `LOGIN NOINHERIT CONNECTION LIMIT \$\{CONNECTION_LIMIT\}`;/, "rotation changes nothing but login, inherit and the limit");
  assert.match(src, /CREATE ROLE \$\{LOGIN\} \$\{attrs\} PASSWORD/);
  assert.match(src, /ALTER ROLE \$\{LOGIN\} \$\{rotateAttrs\} PASSWORD/);
  const grants = src.match(/\bGRANT\s+[^`]*/g) ?? [];
  assert.deepEqual(grants, ["GRANT EXECUTE ON FUNCTION public.${f}() TO ${LOGIN}"], "the only GRANT is EXECUTE on an OPERATIONAL function");
  assert.match(src, /for \(const f of OPERATIONAL\) await tx\.\$executeRawUnsafe\(`GRANT EXECUTE/, "the grant loops over OPERATIONAL only");
  // No group membership: no `IN ROLE`, no `GRANT <role> TO`, and task_maintenance is never granted.
  assert.ok(!/\bIN\s+ROLE\b/.test(src), "no IN ROLE");
  assert.ok(!/GRANT\s+task_maintenance/i.test(src), "never joins task_maintenance");
  // No table, sequence or schema grant anywhere.
  assert.ok(!/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|USAGE|ALL)\b/i.test(src), "no table / sequence / schema grant");
  // The H3 functions appear only in the NOT_ALLOWED list the post-assertion requires to be unreachable.
  for (const h3 of ["task_retention_clear_source_identifiers", "task_retention_purge_learning_events", "task_retention_purge_source_state"]) {
    assert.equal(src.split(`"${h3}"`).length - 1, 1, `${h3} named once (in NOT_ALLOWED)`);
  }
  const withoutNegations = src.replace(/\bNO(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION|INHERIT)\b/g, "");
  assert.ok(!/\b(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION)\b/.test(withoutNegations.replace(/rol(super|bypassrls|createrole|createdb|replication)/g, "")),
    "no elevated attribute is ever granted");
  assert.ok(!/DROP\s+ROLE/i.test(src), "the role is never dropped");
  // Trigger functions are split off by their catalog return type only — never by name — and a callable definer
  // function still fails the post-assertion.
  assert.equal(src.split(`p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)`).length - 1, 1);
  assert.equal(src.split(`p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype)`).length - 1, 1);
  assert.ok(!/content_variant_same_tenant/.test(src), "no function is exempted by name");
  assert.match(src, /reachable\.otherDefinerExecutable === 0/);
  assert.ok(!/triggerDefinerExecutable ===/.test(src), "the trigger count is reported, it is not a pass condition");
  for (const m of src.match(/PASSWORD '\$\{(\w+)\}'/g) ?? []) assert.equal(m, "PASSWORD '${password}'");
  assert.match(src, /if \(!\/\^\[A-Za-z0-9_-\]\{32,128\}\$\/\.test\(password\)\) throw new RefusedError\("password shape"\);/);
});
