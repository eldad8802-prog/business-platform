/**
 * ALL-FEATURE LEARNING COVERAGE — the coverage contract, checked without a database. Run:
 *   npx tsx lib/knowledge/coverage/feature-coverage.test.ts
 *
 * This is the drift guard: a business feature, a tenant model, a route family, a learning rule or a
 * sensor cannot enter the codebase without an explicit learning-coverage decision in
 * `feature-coverage.ts`, and nothing in that manifest may claim something that does not exist.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FEATURE_COVERAGE, INFRASTRUCTURE, LEARNING_EVENT_WRITERS, LEGACY_DIRECT_LEARNING_EVENT_WRITERS } from "./feature-coverage";
import { knowledgeCatalogue } from "../registry";
import { temporalCatalogue } from "../temporal/rules";
import { SENSORS } from "../../sensors/catalogue";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}
const root = process.cwd();
const dupes = (xs: readonly string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

/* ── 1. The manifest is well-formed: every non-learning class is a decision with a reason ── */
const keys = FEATURE_COVERAGE.map((f) => f.key);
ok("feature keys are unique", dupes(keys).length === 0, dupes(keys));
for (const f of FEATURE_COVERAGE) {
  if (!["LEARNS", "AGGREGATOR", "META"].includes(f.coverage)) {
    ok(`${f.key}: ${f.coverage} carries a reason (a decision, not an omission)`, (f.reason ?? "").length >= 20 || f.coverage === "GAP", f.reason);
  }
  // All-Feature Learning Coverage DoD, made permanent: a feature may never again sit undecided. A new
  // feature lands LEARNING, or with an explicit decision and its reason (BLOCKED, L0_ONLY, …).
  ok(`${f.key}: not GAP (every feature has a learning path or a recorded decision)`, f.coverage !== "GAP");
  if (f.coverage === "LEARNS") ok(`${f.key}: LEARNS names at least one active rule`, f.rules.length + f.temporalRules.length > 0);
  if (f.coverage === "CHANNEL") ok(`${f.key}: CHANNEL names the features it delivers into`, (f.channelOf ?? []).length > 0 && (f.channelOf ?? []).every((k) => keys.includes(k)), f.channelOf);
  if (f.coverage === "LEGACY_ALIAS") ok(`${f.key}: LEGACY_ALIAS points at an existing feature`, !!f.aliasOf && keys.includes(f.aliasOf));
}

/* ── 2. Rules ↔ features: every active rule belongs to exactly one feature; no claimed rule is invented ── */
const m4 = knowledgeCatalogue().map((r) => r.descriptor.ruleId);
const temporal = temporalCatalogue().map((r) => r.ruleId);
const claimedM4 = FEATURE_COVERAGE.flatMap((f) => f.rules);
const claimedT = FEATURE_COVERAGE.flatMap((f) => f.temporalRules);
ok("every M4 rule belongs to a feature", m4.every((r) => claimedM4.includes(r)), m4.filter((r) => !claimedM4.includes(r)));
ok("every temporal rule belongs to a feature", temporal.every((r) => claimedT.includes(r)), temporal.filter((r) => !claimedT.includes(r)));
ok("no rule is claimed by two features", dupes([...claimedM4, ...claimedT]).length === 0, dupes([...claimedM4, ...claimedT]));
ok("no feature claims an M4 rule that does not exist", claimedM4.every((r) => m4.includes(r)), claimedM4.filter((r) => !m4.includes(r)));
ok("no feature claims a temporal rule that does not exist", claimedT.every((r) => temporal.includes(r)), claimedT.filter((r) => !temporal.includes(r)));

/* ── 3. Tenant models ↔ features: a new tenant model cannot land without an owner ── */
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const models = new Map<string, boolean>();
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) models.set(m[1], /^\s+(businessId|issuingBusinessId)\s/m.test(m[2]));
const owned = [...FEATURE_COVERAGE.flatMap((f) => f.models), ...INFRASTRUCTURE.models];
const tenantModels = [...models].filter(([, t]) => t).map(([n]) => n);
ok("every tenant model is owned by a feature or declared infrastructure", tenantModels.every((m) => owned.includes(m)), tenantModels.filter((m) => !owned.includes(m)));
ok("no model is owned twice", dupes(owned).length === 0, dupes(owned));
ok("no manifest model is invented (each exists in schema.prisma)", owned.every((m) => models.has(m)), owned.filter((m) => !models.has(m)));

/* ── 4. Routes ↔ features: a new route family cannot land without an owner ── */
const dirs = (p: string) => { try { return readdirSync(join(root, p)).filter((n) => statSync(join(root, p, n)).isDirectory()); } catch { return []; } };
const apiSegs = dirs("app/api").map((d) => `api/${d}`);
const groups = dirs("app").filter((d) => d.startsWith("("));
const pageSegs = [...new Set([
  ...dirs("app").filter((d) => !d.startsWith("(") && d !== "api").map((d) => `page/${d}`),
  ...groups.flatMap((g) => dirs(`app/${g}`).map((d) => `page/${d}`)),
])];
const ownedRoutes = [...FEATURE_COVERAGE.flatMap((f) => f.routes), ...INFRASTRUCTURE.routes];
const allRoutes = [...apiSegs, ...pageSegs];
ok("every API route family is owned by a feature or declared infrastructure", apiSegs.every((r) => ownedRoutes.includes(r)), apiSegs.filter((r) => !ownedRoutes.includes(r)));
ok("every page route is owned by a feature or declared infrastructure", pageSegs.every((r) => ownedRoutes.includes(r)), pageSegs.filter((r) => !ownedRoutes.includes(r)));
ok("no route is owned twice", dupes(ownedRoutes).length === 0, dupes(ownedRoutes));
ok("no manifest route is invented (each exists under app/)", ownedRoutes.every((r) => allRoutes.includes(r)), ownedRoutes.filter((r) => !allRoutes.includes(r)));

/* ── 5. Sensors: every sensor is owned once, and its learning role is true ── */
const sensorEntries = Object.values(SENSORS);
const ownedSensors = FEATURE_COVERAGE.flatMap((f) => f.sensors);
ok("every catalogue sensor is owned by exactly one feature", sensorEntries.every((s) => ownedSensors.filter((o) => o === s.eventType).length === 1),
  sensorEntries.filter((s) => ownedSensors.filter((o) => o === s.eventType).length !== 1).map((s) => s.eventType));
ok("no manifest sensor is invented", ownedSensors.every((o) => sensorEntries.some((s) => s.eventType === o)), ownedSensors.filter((o) => !sensorEntries.some((s) => s.eventType === o)));
const rulesById = new Map<string, { evidenceSensors?: readonly string[] }>([
  ...knowledgeCatalogue().map((r) => [r.descriptor.ruleId, r.descriptor] as const),
  ...temporalCatalogue().map((r) => [r.ruleId, r] as const),
]);
for (const s of sensorEntries) {
  ok(`${s.eventType}: time semantics decided`, s.timeSemantics === "ACTION_TIME" || s.timeSemantics === "INGESTION_TIME");
  const l = s.learning;
  if (l.role === "OBSERVATION_SOURCE") {
    ok(`${s.eventType}: OBSERVATION_SOURCE names its consuming rules`, l.consumedBy.length > 0);
    for (const r of l.consumedBy) {
      ok(`${s.eventType}: consumer ${r} exists`, rulesById.has(r));
      ok(`${s.eventType}: consumer ${r} declares this sensor in its evidence`, (rulesById.get(r)?.evidenceSensors ?? []).includes(s.eventType));
    }
    ok(`${s.eventType}: an observation source used for learning carries ACTION_TIME`, s.timeSemantics === "ACTION_TIME");
  } else if (l.role === "LEDGER_DUPLICATE") {
    ok(`${s.eventType}: LEDGER_DUPLICATE names real ledger models`, l.ledger.length > 0 && l.ledger.every((m) => models.has(m)), l.ledger);
  } else {
    ok(`${s.eventType}: AUDIT_ONLY says why`, l.reason.length >= 20, l.reason);
  }
}
// The reverse: a rule that declares a sensor must be named by it.
for (const [id, r] of rulesById) for (const ev of r.evidenceSensors ?? []) {
  const s = sensorEntries.find((x) => x.eventType === ev);
  ok(`${id}: declared sensor ${ev} lists it as a consumer`, !!s && s.learning.role === "OBSERVATION_SOURCE" && s.learning.consumedBy.includes(id));
}

/* ── 6. LearningEvent is written only by the governed writers (plus the closed legacy set) ── */
const allowed = new Set<string>([...LEARNING_EVENT_WRITERS, ...LEGACY_DIRECT_LEARNING_EVENT_WRITERS]);
const writers: string[] = [];
const walk = (d: string): void => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (!["node_modules", ".next"].includes(n)) walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(n) || /\.test\.|\.verify\./.test(n)) continue;
    const src = readFileSync(p, "utf8");
    if (/learningEvent\.(create|createMany|upsert)\s*\(|INSERT\s+INTO\s+"LearningEvent"/.test(src)) writers.push(relative(root, p).replace(/\\/g, "/"));
  }
};
walk(join(root, "lib")); walk(join(root, "app"));
ok("LearningEvent is written only by recordSensor / logAuditEvent (and the closed legacy set)", writers.every((w) => allowed.has(w)), writers.filter((w) => !allowed.has(w)));

/* ── Report ── */
const by = (c: string) => FEATURE_COVERAGE.filter((f) => f.coverage === c).map((f) => f.key);
const classes = [...new Set(FEATURE_COVERAGE.map((f) => f.coverage))];
console.log(`\nCANONICAL BUSINESS FEATURES = ${FEATURE_COVERAGE.length}`);
for (const c of classes) console.log(`  ${c.padEnd(22)} ${by(c).length}  ${by(c).join(", ")}`);
const roles = (r: string) => sensorEntries.filter((s) => s.learning.role === r).length;
console.log(`SENSORS = ${sensorEntries.length}  OBSERVATION_SOURCE=${roles("OBSERVATION_SOURCE")} LEDGER_DUPLICATE=${roles("LEDGER_DUPLICATE")} AUDIT_ONLY=${roles("AUDIT_ONLY")}`);
console.log(`OPEN GAP = ${by("GAP").length} (milestone Definition of Done: 0)`);
console.log(failed === 0 ? "\nLearning coverage contract: every feature decided, nothing invented. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
