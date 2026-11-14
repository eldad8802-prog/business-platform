/**
 * Service Desk — deriveIdempotencyKey, pure proofs (no database, no network, no clock). Run:
 *   npx tsx lib/services/service-desk/idempotency-key.test.ts
 *
 *   - boundary client key lengths 1, 7, 8, 36 (UUIDv7), 197, 198, 199, 200 and longer: the result always fits the column
 *     CHECK ^[A-Za-z0-9:_#-]{8,200}$ — the plain form while it fits, the hashed form beyond;
 *   - today's UUIDv7 keys give exactly the former `${key}#${step}` (rows already written keep matching);
 *   - determinism (a replay finds its row) and distinctness (other key or other step → other result, across both forms);
 *   - a derived key is never a valid client key (prepare's UUIDv7, IDEMPOTENCY_KEY_PATTERN), and the hashed form never
 *     equals any plain form;
 *   - invalid step tokens and an empty client key throw; every call site in the module uses the helper.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { IDEMPOTENCY_KEY_PATTERN, uuidV7 } from "@/lib/services/tasks/task-idempotency";

import { DERIVED_STEP, HASHED_PREFIX, SERVICE_KEY_COLUMN, SERVICE_KEY_MAX, deriveIdempotencyKey } from "./idempotency-key";
import { releaseEventKey } from "./part-release";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const key = (n: number, c = "a") => c.repeat(n);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isClientKey = (k: string) => IDEMPOTENCY_KEY_PATTERN.test(k) || UUID_V7.test(k);

console.log("L — lengths and the column CHECK");
for (const n of [1, 7, 8, 36, 196, 197, 198, 199, 200, 201, 500]) {
  for (const step of ["2", "3", "rel1", "rel2147483647", "x".repeat(32)]) {
    const d = deriveIdempotencyKey(key(n), step);
    ok(`L len ${n} step ${step.length}: within the column CHECK (${d.length} ≤ ${SERVICE_KEY_MAX})`, SERVICE_KEY_COLUMN.test(d) && d.length <= SERVICE_KEY_MAX, d.length);
  }
}
ok("L1 len 197 + '#2' = 199 → plain", deriveIdempotencyKey(key(197), 2) === `${key(197)}#2`);
ok("L2 len 198 + '#2' = 200 → plain (exactly the limit)", deriveIdempotencyKey(key(198), 2) === `${key(198)}#2`);
ok("L3 len 199 + '#2' = 201 → hashed", deriveIdempotencyKey(key(199), 2).startsWith(HASHED_PREFIX));
ok("L4 len 200 + '#2' = 202 → hashed", deriveIdempotencyKey(key(200), 2).startsWith(HASHED_PREFIX));
ok("L5 len 198 + '#rel12' = 204 → hashed (the step counts)", deriveIdempotencyKey(key(198), "rel12").startsWith(HASHED_PREFIX));
ok("L6 len 1 → hashed (a plain 'a#2' is below the column minimum 8)", deriveIdempotencyKey(key(1), 2).startsWith(HASHED_PREFIX));
ok("L7 len 5 + '#2' = 7 → hashed; len 6 + '#2' = 8 → plain", deriveIdempotencyKey(key(5), 2).startsWith(HASHED_PREFIX) && deriveIdempotencyKey(key(6), 2) === `${key(6)}#2`);
ok("L8 the hashed form is h: + 43 base64url + # + step", /^h:[A-Za-z0-9_-]{43}#2$/.test(deriveIdempotencyKey(key(200), 2)));

console.log("U — today's UUIDv7 keys: unchanged");
const u = uuidV7(new Date("2026-11-12T10:00:00Z"), () => 0.5);
ok("U1 UUIDv7 + 2 → `${key}#2`", deriveIdempotencyKey(u, 2) === `${u}#2`);
ok("U2 UUIDv7 + rel17 → `${key}#rel17` (= releaseEventKey)", deriveIdempotencyKey(u, "rel17") === `${u}#rel17` && releaseEventKey(u, 17) === `${u}#rel17`);

console.log("D — determinism and distinctness");
ok("D1 same input → same output (plain and hashed)", deriveIdempotencyKey(key(36), 2) === deriveIdempotencyKey(key(36), 2) && deriveIdempotencyKey(key(200), 2) === deriveIdempotencyKey(key(200), 2));
const outs = new Set<string>();
let inputs = 0;
const alphabet = ["a", "b", "Z", "9", "-", "_"];
for (const n of [1, 6, 7, 36, 197, 198, 199, 200, 201]) {
  for (const c of alphabet) {
    for (const v of [key(n, c), `${key(Math.max(n - 1, 0), c)}x`]) {
      for (const step of ["2", "3", "rel1"]) { outs.add(deriveIdempotencyKey(v, step)); inputs++; }
    }
  }
}
const distinctInputs = new Set<string>();
for (const n of [1, 6, 7, 36, 197, 198, 199, 200, 201]) for (const c of alphabet) for (const v of [key(n, c), `${key(Math.max(n - 1, 0), c)}x`]) for (const step of ["2", "3", "rel1"]) distinctInputs.add(`${v}\u0000${step}`);
ok(`D2 ${distinctInputs.size} distinct (key, step) inputs → ${outs.size} distinct outputs`, outs.size === distinctInputs.size, { inputs, distinct: distinctInputs.size, outs: outs.size });
ok("D3 keys differing only in the last character (200 long) → different hashed keys", deriveIdempotencyKey(`${key(199)}a`, 2) !== deriveIdempotencyKey(`${key(199)}b`, 2));
ok("D4 same long key, other step → other key", deriveIdempotencyKey(key(200), 2) !== deriveIdempotencyKey(key(200), 3));
ok("D5 a key with ':' or '#' (outside the client alphabet) is hashed, so it cannot impersonate the hashed form",
  deriveIdempotencyKey(`h:${"A".repeat(43)}`, 2).startsWith(HASHED_PREFIX) && deriveIdempotencyKey(`h:${"A".repeat(43)}`, 2) !== `h:${"A".repeat(43)}#2`
  && deriveIdempotencyKey("abcdefgh#2", 3) !== "abcdefgh#2#3");
ok("D6 a plain-form output never contains ':'; a hashed-form output always does", !deriveIdempotencyKey(key(36), 2).includes(":") && deriveIdempotencyKey(key(200), 2).includes(":"));

console.log("C — a derived key is never a client key");
let anyClient = false;
for (const v of [u, key(1), key(8), key(128), key(198), key(200), key(500)]) for (const step of ["2", "rel3"]) if (isClientKey(deriveIdempotencyKey(v, step))) anyClient = true;
ok("C1 no derived key matches IDEMPOTENCY_KEY_PATTERN or a UUIDv7 (it always has '#')", !anyClient);
ok("C2 the hashed prefix is outside the client alphabet", !IDEMPOTENCY_KEY_PATTERN.test(`${HASHED_PREFIX}aaaaaaaa`) && !UUID_V7.test(`${HASHED_PREFIX}aaaaaaaa`));

console.log("T — refusals");
ok("T1 step '' / '#' / ':' / 33 chars / '2#3' → throws", ["", "#", ":", "x".repeat(33), "2#3"].every((s) => throws(() => deriveIdempotencyKey(u, s))));
ok("T2 the step token pattern is the client alphabet, 1..32", DERIVED_STEP.test("rel2147483647") && !DERIVED_STEP.test("a:b"));
ok("T3 empty client key → throws", throws(() => deriveIdempotencyKey("", 2)));

console.log("S — every call site in the module derives through the helper");
const dir = path.join(process.cwd(), "lib/services/service-desk");
const offenders: string[] = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "idempotency-key.ts") continue;
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  // a template that glues '#' after a key (`${prepared.key}#…`, `${caseKey}#…`, `${key}#…`)
  if (/\$\{[A-Za-z_.]*[kK]ey\}#/.test(src) || /[kK]ey\s*\+\s*["'`]#/.test(src)) offenders.push(f);
}
ok("S1 no `${…key}#…` concatenation outside idempotency-key.ts", offenders.length === 0, offenders);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
