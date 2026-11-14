// Service Desk QA track defaults — mutation run of the pure core (lib/services/service-desk/qa-track-defaults.core.ts)
// against its unit test (qa-track-defaults-core.test.ts). Each mutant is ONE textual change; the test must FAIL on every
// one (killed). The file is restored after each mutant (and on any error). No database, no network.
//
//   node .sdqadcode/mutate-core.mjs [n,n,…]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const FILE = path.join(ROOT, "lib/services/service-desk/qa-track-defaults.core.ts");
const TEST = path.join(ROOT, "lib/services/service-desk/qa-track-defaults-core.test.ts");
const SRC = fs.readFileSync(FILE, "utf8");
const ONLY = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : null;

const MUTANTS = [
  ["a track outside T1–T7", "(SERVICE_TRACKS as readonly string[]).includes(v)", "v.length > 0"],
  ["an unknown body field ignored", `for (const k of Object.keys(body)) if (k !== "listId" && k !== "expectedRevision") return { ok: false, field: k.slice(0, 40) };`, ""],
  ["listId 0 accepted", `if (listId === undefined || (listId !== null && !isPositiveInt(listId)))`, `if (listId === undefined || (listId !== null && !isNonNegativeInt(listId)))`],
  ["a negative / fractional revision", `if (!isNonNegativeInt(body.expectedRevision)) return { ok: false, field: "expectedRevision" };`, `if (typeof body.expectedRevision !== "number") return { ok: false, field: "expectedRevision" };`],
  ["a list not found in the business accepted", `if (!input.target || !input.target.found) v.push("QA_LIST_NOT_FOUND");`, `if (!input.target) v.push("QA_LIST_NOT_FOUND");`],
  ["an archived list as a default", `else if (input.target.archived) v.push("QA_LIST_ARCHIVED");`, ""],
  ["the same default again accepted", `if (currentList === input.listId) v.push("NO_CHANGE");`, ""],
  ["null at the opening = the default", `if (v === null) return { ok: true, value: { kind: "NONE" } };`, `if (v === null) return { ok: true, value: { kind: "DEFAULT" } };`],
  ["explicit none ignored", `if (r.kind === "NONE") return { ok: true, to: null, reason: "EXPLICIT_NONE" };`, ""],
  ["an explicit list where QA is OFF", `    if (input.mode === "OFF") v.push("QA_NOT_FOR_KIND");\n`, ""],
  ["an explicit list read under another id trusted", `if (!l || l.listId !== r.listId) v.push("QA_LIST_NOT_FOUND");`, `if (!l) v.push("QA_LIST_NOT_FOUND");`],
  ["an explicit archived list", `else if (l.archived) v.push("QA_LIST_ARCHIVED");`, ""],
  ["the migrations' absence ignored", `if (!input.available.lists || !input.available.defaults) return`, `if (false) return`],
  ["a default without a track", `if (input.track === null) return { ok: true, to: null, reason: "NO_TRACK" };`, ""],
  ["a default where QA is OFF", `if (input.mode === "OFF") return { ok: true, to: null, reason: "QA_OFF" };`, ""],
  ["an archived default applied", `if (d.archived) return { ok: true, to: null, reason: "DEFAULT_ARCHIVED" };`, ""],
  ["not the CURRENT version pinned", `to: { listId: d.listId, listVersion: d.currentVersion }, reason: "DEFAULT"`, `to: { listId: d.listId, listVersion: 1 }, reason: "DEFAULT"`],
  ["the source token fixed", "atOpening: true, source: reason", `atOpening: true, source: "DEFAULT"`],
  ["the payload without #1124's from fields", "fromListId: null, fromListVersion: null, atOpening", "atOpening"],
  ["the view ignores QA OFF", `  if (mode === "OFF") return "QA_OFF";\n  if (listId === null`, `  if (listId === null`],
  ["the view ignores an archived list", `if (list.archived) return "DEFAULT_ARCHIVED";`, ""],
];

let killed = 0, run = 0;
try {
  const base = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), TEST], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CHECKPOINT_DISABLE: "1" } });
  if (base.status !== 0) { console.log("the original is not green — stop\n" + base.stdout.slice(-400)); process.exit(1); }
  for (const [i, [label, from, to]] of MUTANTS.entries()) {
    if (ONLY && !ONLY.has(i + 1)) continue;
    if (!SRC.includes(from)) { console.log(`  [NOT FOUND] M${i + 1} ${label}`); continue; }
    run++;
    fs.writeFileSync(FILE, SRC.replace(from, to));
    const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), TEST], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CHECKPOINT_DISABLE: "1" } });
    const dead = r.status !== 0;
    if (dead) killed++;
    const fails = (r.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6, 40));
    console.log(`  [${dead ? "KILLED" : "SURVIVED"}] M${i + 1} ${label}${dead ? ` — ${fails.slice(0, 2).join(" | ") || "error"}` : ""}`);
  }
} finally {
  fs.writeFileSync(FILE, SRC);
}
console.log(`\nmutants: ${run}, killed ${killed}`);
