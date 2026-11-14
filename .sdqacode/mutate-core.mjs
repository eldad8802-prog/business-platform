// Service Desk QA lists — mutation run of the pure core (lib/services/service-desk/qa-lists.core.ts) against its unit
// test (qa-lists-core.test.ts). Each mutant is ONE textual change; the test must FAIL on every one (killed). The file is
// restored after each mutant (and on any error). No database, no network.
//
//   node .sdqacode/mutate-core.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const FILE = path.join(ROOT, "lib/services/service-desk/qa-lists.core.ts");
const TEST = path.join(ROOT, "lib/services/service-desk/qa-lists-core.test.ts");
const SRC = fs.readFileSync(FILE, "utf8");
const ONLY = process.argv[2] ? new Set(process.argv[2].split(",").map(Number)) : null; // e.g. 33 — rerun some mutants

const MUTANTS = [
  ["a text one character too long", "if (len(t) < 1 || len(t) > max || CONTROL.test(t)) return null;", "if (len(t) < 1 || len(t) > max + 1 || CONTROL.test(t)) return null;"],
  ["control characters allowed", "if (len(t) < 1 || len(t) > max || CONTROL.test(t)) return null;", "if (len(t) < 1 || len(t) > max) return null;"],
  ["101 checks", "body.items.length > QA_LIST_ITEMS_MAX)", "body.items.length > QA_LIST_ITEMS_MAX + 1)"],
  ["an empty list of checks", "body.items.length < 1 ||", ""],
  ["a duplicate key", "!QA_ITEM_KEY.test(r.key) || keys.has(r.key))", "!QA_ITEM_KEY.test(r.key))"],
  ["a key that is not a token", "|| !QA_ITEM_KEY.test(r.key) ||", "||"],
  ["required not a boolean", `if (typeof r.required !== "boolean") return { ok: false, field: \`items[\${i}].required\` };`, ""],
  ["an unknown field in a check", `for (const k of Object.keys(r)) if (k !== "key" && k !== "label" && k !== "required") return { ok: false, field: \`items[\${i}]\` };`, ""],
  ["a template on a revise", "if (!opts.allowTemplate || typeof body.fromTemplate", "if (typeof body.fromTemplate"],
  ["an unknown template id", " || !Object.prototype.hasOwnProperty.call(QA_TEMPLATE_BY_ID, body.fromTemplate)) {", ") {"],
  ["a fresh key may repeat a used one", "if (!used.has(k)) { used.add(k); return k; }", "{ used.add(k); return k; }"],
  ["the template's REQUIRED flags not copied", "(template as QaTemplate).items.map((i) => ({ key: i.key, label: i.label, required: i.required }))", "(template as QaTemplate).items.map((i) => ({ key: i.key, label: i.label, required: true }))"],
  ["the origin template not recorded", "return { ...planned(input.name, items), sourceTemplateId: input.fromTemplate };\n  }\n  const used", "return { ...planned(input.name, items), sourceTemplateId: null };\n  }\n  const used"],
  ["a removed key may come back", `for (const i of items) if (i.key !== null && !byKey.has(i.key)) return { ok: false, code: "UNKNOWN_ITEM_KEY" };`, ""],
  ["a fresh key may reuse an old version's key", "const used = new Set([...everUsedKeys, ...current.items.map((i) => i.key)]);", "const used = new Set([...current.items.map((i) => i.key)]);"],
  ["no change accepted", `if (!any) return { ok: false, code: "NO_CHANGE" };`, ""],
  ["a reorder is no change", `reordered: kept.map((i) => i.key).join("|") !== current.items.filter((i) => next.some((n) => n.key === i.key)).map((i) => i.key).join("|"),`, "reordered: false,"],
  ["a REQUIRED flip is no change", "requiredChanged: kept.filter((i) => byKey.get(i.key)!.required !== i.required).length,", "requiredChanged: 0,"],
  ["a relabel is no change", "relabeled: kept.filter((i) => byKey.get(i.key)!.label !== i.label).length,", "relabeled: 0,"],
  ["a rename is no change", "name: input.name !== current.name,", "name: false,"],
  ["an unknown result key accepted", "if (!byKey.has(key)) return { ok: false, field: `results.${key}`.slice(0, 60) };", ""],
  ["complete with a REQUIRED check missing", "completed: requiredFailed === 0 && requiredMissing === 0,", "completed: requiredFailed === 0,"],
  ["complete with a REQUIRED check failed", "completed: requiredFailed === 0 && requiredMissing === 0,", "completed: requiredMissing === 0,"],
  ["a built-in checklist complete with a check unrecorded", "(i.required || opts.everyCheckRecorded === true) && !given.has(i.key)", "i.required && !given.has(i.key)"],
  ["every checklist must be recorded in full (a list's optional checks would block)", "(i.required || opts.everyCheckRecorded === true) && !given.has(i.key)", "!given.has(i.key)"],
  ["an optional check counted as missing", "const requiredMissing = items.filter((i) => (i.required || opts.everyCheckRecorded === true) && !given.has(i.key)).length;", "const requiredMissing = items.filter((i) => (i.required || opts.everyCheckRecorded !== true) && !given.has(i.key)).length;"],
  ["an optional FAIL blocks", `const requiredFailed = out.filter((r) => r.required && r.result === "FAIL").length;`, `const requiredFailed = out.filter((r) => r.result === "FAIL").length;`],
  ["notes before the migration", "if (!opts.notes || !value || typeof value", "if (!value || typeof value"],
  ["a note too long", "if (len(t) > QA_NOTE_MAX) return", "if (len(t) > QA_NOTE_MAX + 1) return"],
  ["a blank note kept", `note = t === "" ? null : t;`, "note = t;"],
  ["no results accepted", `if (entries.length === 0) return { ok: false, field: "results" };`, ""],
  ["a value other than PASS / FAIL in the object", `if (v.result !== "PASS" && v.result !== "FAIL") return`, `if (v.result === undefined) return`],
  ["results not in the checklist's order", "const out: ItemResult[] = items.filter((i) => given.has(i.key)).map((i) => ({ key: i.key, required: i.required, ...given.get(i.key)! }));",
    "const out: ItemResult[] = [...given.keys()].map((k) => ({ key: k, required: byKey.get(k)!.required, ...given.get(k)! }));"],
  ["a choice past QA", `if (QA_CHOICE_FIXED_STATUSES.includes(input.status)) v.push("QA_LIST_FIXED");`, ""],
  ["WORK_DONE not fixed", `["READY", "WORK_DONE", "DELIVERED"`, `["READY", "DELIVERED"`],
  ["a list where QA is OFF", `if (input.mode === "OFF") v.push("QA_NOT_FOR_KIND");`, ""],
  ["an archived list", `if (input.target.archived) v.push("QA_LIST_ARCHIVED");`, ""],
  ["the same list at another version is no change", "input.current.listId === to.listId && input.current.listVersion === to.listVersion", "input.current.listId === to.listId"],
  ["no change accepted on the case", `if (same) v.push("NO_CHANGE");`, ""],
  ["the mode without a track", `kind === "IN_SHOP" ? "REQUIRED" : "OFF"`, `"REQUIRED"`],
  ["the track's mode ignored", "return track ? track.requirements.qa.mode : kind", "return kind"],
  ["the payload loses where it came from", "fromListId: from?.listId ?? null", "fromListId: null"],
  ["the checklist token", "`list:${listId}:v${version}`", "`list:${listId}`"],
];

function run() {
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), TEST], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CHECKPOINT_DISABLE: "1" } });
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout ?? "");
  return { status: r.status, passed: m ? Number(m[1]) : -1, failed: m ? Number(m[2]) : -1 };
}

let killed = 0;
try {
  const base = run();
  console.log(`ORIGINAL: ${base.passed} passed, ${base.failed} failed`);
  if (base.status !== 0 || base.failed !== 0) throw new Error("the original is not green");
  for (const [i, [label, from, to]] of MUTANTS.entries()) {
    if (ONLY && !ONLY.has(i + 1)) continue;
    if (!SRC.includes(from)) { console.log(`  [NOT FOUND] C${i + 1} ${label}`); continue; }
    fs.writeFileSync(FILE, SRC.replace(from, to));
    const r = run();
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`  [${dead ? "KILLED" : "SURVIVED"}] C${i + 1} ${label} (${r.failed} failed)`);
  }
} finally {
  fs.writeFileSync(FILE, SRC);
}
console.log(`\nmutants: ${MUTANTS.length}, killed ${killed}`);
