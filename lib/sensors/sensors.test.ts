/**
 * M5.5 · The sensor contract, checked without a database. Run:
 *   npx tsx lib/sensors/sensors.test.ts
 *
 * What these hold is the part of the contract that fails SILENTLY when broken: a sensor that names an
 * interpretation instead of an occurrence, a payload key that admits a customer's name, an actor that
 * nobody decided, a source that lies about origin. None of those throw in production. All of them
 * corrupt what the Business Brain later believes happened.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SENSORS, type SensorKey } from "./catalogue";
import { FORBIDDEN_KEY, MAX_STRING } from "./sensor.contract";
import { changedFields, validateSensorInput, type RecordSensorInput } from "./record-sensor";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const entries = Object.entries(SENSORS) as [SensorKey, (typeof SENSORS)[SensorKey]][];

/* ── The catalogue describes occurrences, never interpretations ─────────────────────── */
ok("the catalogue is not empty", entries.length >= 20, entries.length);
for (const [key, def] of entries) {
  ok(`${key}: key equals its eventType`, key === def.eventType);
  ok(`${key}: UPPER_SNAKE_CASE`, /^[A-Z][A-Z0-9_]+$/.test(def.eventType));
  ok(`${key}: names an occurrence (past tense), not an interpretation`,
    /(ED|_OPENED_MANUALLY|_TAKEOVER|_INGESTED|_DECIDED|_POSTED|_SETTLED)$/.test(def.eventType) &&
    !/(LIKELY|PROBABLY|QUALITY|INTENT|DEMAND|PRESSURE|SCORE|RISK|CHURNED)/.test(def.eventType),
    def.eventType);
  ok(`${key}: has a domain, an entity type and a version`,
    def.domain.length > 0 && def.entityType.length > 0 && Number.isInteger(def.version) && def.version >= 1);
  ok(`${key}: describes what occurred in one sentence`, def.describes.length > 20 && def.describes.length < 200);
  for (const k of def.payloadKeys) {
    ok(`${key}: payload key "${k}" is not personal data, free text or a secret`, !FORBIDDEN_KEY.test(k));
  }
  ok(`${key}: payload keys are unique`, new Set(def.payloadKeys).size === def.payloadKeys.length);
}
ok("event types are unique across the catalogue",
  new Set(entries.map(([, d]) => d.eventType)).size === entries.length);

/* ── The writer's refusals ───────────────────────────────────────────────────────────── */
const base: RecordSensorInput = {
  businessId: 7,
  sensor: "CUSTOMER_CREATED",
  entityId: 1,
  actor: { type: "OWNER_USER", userId: 3 },
  source: "OWNER_UI",
  payload: { origin: "UI" },
};
ok("a well-formed sensor passes", validateSensorInput(base) === null);
ok("an unknown sensor is refused",
  validateSensorInput({ ...base, sensor: "NOT_A_SENSOR" as SensorKey }) === "unknown_sensor");
ok("a non-positive tenant is refused", validateSensorInput({ ...base, businessId: 0 }) === "bad_business");
ok("OWNER_USER without a real user id is refused",
  validateSensorInput({ ...base, actor: { type: "OWNER_USER", userId: 0 } }) === "bad_actor");
ok("a SYSTEM actor may not claim the owner's UI",
  validateSensorInput({ ...base, actor: { type: "SYSTEM" } }) === "actor_source_mismatch");
ok("an INTEGRATION actor may not claim to be an import",
  validateSensorInput({ ...base, actor: { type: "INTEGRATION" }, source: "IMPORT" }) === "actor_source_mismatch");
ok("UNKNOWN stays UNKNOWN — accepted with an UNKNOWN source, never upgraded",
  validateSensorInput({ ...base, actor: { type: "UNKNOWN" }, source: "UNKNOWN" }) === null);
ok("a key outside the sensor's allowlist is refused",
  validateSensorInput({ ...base, payload: { origin: "UI", tier: "gold" } }) === "payload_key_not_allowed");
ok("a key that names personal data is refused even before the allowlist",
  validateSensorInput({ ...base, payload: { customerName: "x" } }) === "payload_key_forbidden");
ok("a paragraph is refused",
  validateSensorInput({ ...base, payload: { origin: "x".repeat(MAX_STRING + 1) } }) === "payload_string_too_long");
ok("an object value is refused (no smuggled blobs)",
  validateSensorInput({ ...base, payload: { origin: { a: 1 } as unknown as string } }) === "payload_value_not_scalar");
ok("an oversized list is refused",
  validateSensorInput({
    ...base, sensor: "INVENTORY_RECEIVING_POSTED", payload: { movementIds: Array.from({ length: 51 }, (_, i) => i) },
  }) === "payload_list_too_long");
ok("an empty idempotency key is refused", validateSensorInput({ ...base, idempotencyKey: "" }) === "idempotency_key_invalid");

/* ── changedFields reports names, in a canonical order, and only real changes ─────────── */
ok("changedFields: only what differs, sorted",
  JSON.stringify(changedFields({ b: 1, a: "x", c: null }, { a: "y", b: 1, c: undefined }, ["a", "b", "c"])) === '["a"]');
ok("changedFields: equal dates are not a change",
  changedFields({ d: new Date(5) }, { d: new Date(5) }, ["d"]).length === 0);
ok("changedFields: a field not submitted is not a change",
  changedFields({ a: 1 }, {}, ["a"]).length === 0);

/* ── Static: no sensor or audit payload in the product carries personal data ──────────── */
const root = join(__dirname, "..", "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const sources = [...walk(join(root, "lib")), ...walk(join(root, "app"))];
const offenders: string[] = [];
for (const file of sources) {
  const src = readFileSync(file, "utf8");
  // Every logAuditEvent / recordSensor call body, up to its closing of the argument object.
  for (const m of src.matchAll(/(logAuditEvent|recordSensor)\(\s*\{[\s\S]{0,1600}?\n\s*\}\s*(,|\))/g)) {
    const body = m[0];
    if (/\b(customerNameSnapshot|lostReason|qrValue|contentText|phone|email)\s*:/.test(body) ||
        /\btoken\s*:/.test(body)) {
      offenders.push(relative(root, file));
    }
  }
}
ok("no logAuditEvent/recordSensor payload carries a name snapshot, free-text reason, bearer token, message text, phone or email",
  offenders.length === 0, [...new Set(offenders)]);

/* ── Every recordSensor call states its actor and source explicitly ───────────────────── */
const undecided: string[] = [];
for (const file of sources) {
  const src = readFileSync(file, "utf8");
  if (file.includes(join("lib", "sensors"))) continue;
  for (const m of src.matchAll(/recordSensor\(\s*\{[\s\S]{0,1600}?\n\s*\}\s*(,|\))/g)) {
    // Either stated inline, or spread from a helper typed to return BOTH (e.g. `...importActor(id)`,
    // `...sensorWho(ctx)`), which the compiler then holds to the same contract.
    const inline = /\bactor\b/.test(m[0]) && /\bsource\b/.test(m[0]);
    const spread = /\.\.\.\s*\w+\(/.test(m[0]);
    if (!inline && !spread) undecided.push(relative(root, file));
  }
}
ok("every recordSensor call site decides actor AND source (no defaults exist to fall back on)",
  undecided.length === 0, undecided);

console.log(failed === 0 ? "\nM5.5 sensor contract: occurrences, decided, purpose-limited. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
