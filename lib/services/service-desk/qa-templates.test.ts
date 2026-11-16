/**
 * Run: npx tsx lib/services/service-desk/qa-templates.test.ts
 *
 * The built-in QA checklists (pure). Owner decision 2026-11-12: all seven built-in templates are SUGGESTIONS — no check
 * is required because it comes from the system; a built-in checklist completes when it was actually performed (every
 * check recorded, PASS or FAIL). The evaluator's REQUIRED semantics (a failed or missing required check keeps QA open;
 * optional checks never block) are kept and tested on a synthetic template and on the frozen retired v1 templates.
 */
import {
  QA_TEMPLATES, QA_TEMPLATE_BY_ID, QA_TEMPLATE_SUCCESSOR, RETIRED_QA_TEMPLATES, TRACK_QA_TEMPLATES,
  evaluateQa, evaluateQaAgainst, qaTemplateFor, qaTemplateForHistory, type QaTemplate,
} from "./qa-templates";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const every = (t: QaTemplate, v: "PASS" | "FAIL" = "PASS") => Object.fromEntries(t.items.map((i) => [i.key, v]));

// A synthetic template with REQUIRED checks (what a business list can define) — the evaluator's REQUIRED semantics.
const SYN: QaTemplate = {
  id: "SYNTHETIC.v1", kind: "IN_SHOP", everyCheckRecorded: false,
  items: [
    { key: "r_one", label: "חובה 1", required: true },
    { key: "r_two", label: "חובה 2", required: true },
    { key: "opt", label: "רשות", required: false },
  ],
};
const synReq = { r_one: "PASS", r_two: "PASS" };

ok("T1 one template per kind, keys as tokens, unique per template",
  (["IN_SHOP", "FIELD", "MAINTENANCE", "REMOTE"] as const).every((k) => QA_TEMPLATES[k].kind === k
    && QA_TEMPLATES[k].items.every((i) => /^[a-z_]{2,40}$/.test(i.key))
    && new Set(QA_TEMPLATES[k].items.map((i) => i.key)).size === QA_TEMPLATES[k].items.length));
{
  const e = evaluateQaAgainst(SYN, synReq);
  ok("T2 every REQUIRED check PASS (optional absent) → completed", e.ok && e.completed && e.counts.requiredMissing === 0 && e.counts.requiredFailed === 0);
}
{
  const e = evaluateQaAgainst(SYN, { ...synReq, r_one: "FAIL" });
  ok("T3 a REQUIRED check FAILED → not completed (requiredFailed 1)", e.ok && !e.completed && e.counts.requiredFailed === 1);
}
{
  const e = evaluateQaAgainst(SYN, { r_one: "PASS" });
  ok("T4 a REQUIRED check not recorded → not completed (requiredMissing 1)", e.ok && !e.completed && e.counts.requiredMissing === 1);
}
{
  const e = evaluateQaAgainst(SYN, { ...synReq, opt: "FAIL" });
  ok("T5 an optional check FAILED does not block", e.ok && e.completed && e.counts.failed === 1);
}
{
  // T2–T4 also hold on the frozen retired IN_SHOP.v1 content (history: what its stored results meant)
  const v1 = RETIRED_QA_TEMPLATES["IN_SHOP.v1"];
  const req = v1.items.filter((i) => i.required).map((i) => i.key);
  const all = Object.fromEntries(req.map((k) => [k, "PASS"]));
  const a = evaluateQaAgainst(v1, all), b = evaluateQaAgainst(v1, { ...all, [req[0]]: "FAIL" }), c = evaluateQaAgainst(v1, Object.fromEntries(req.slice(1).map((k) => [k, "PASS"])));
  ok("T5b the retired IN_SHOP.v1 keeps its meaning: required PASS → complete; one FAILED / missing → not",
    a.ok && a.completed && b.ok && !b.completed && b.counts.requiredFailed === 1 && c.ok && !c.completed && c.counts.requiredMissing === 1);
}
ok("T6 an unknown key → refused, never ignored", !evaluateQa("IN_SHOP", { ...every(QA_TEMPLATES.IN_SHOP), hacked: "PASS" }).ok);
ok("T7 a value other than PASS / FAIL → refused (true, 'pass', 'N/A')",
  !evaluateQa("IN_SHOP", { powers_on: true }).ok && !evaluateQa("IN_SHOP", { powers_on: "pass" }).ok && !evaluateQa("IN_SHOP", { powers_on: "N/A" }).ok);
ok("T8 no results / an array / null → refused", !evaluateQa("IN_SHOP", {}).ok && !evaluateQa("IN_SHOP", []).ok && !evaluateQa("IN_SHOP", null).ok);
ok("T9 a FIELD key is not valid on an IN_SHOP case", !evaluateQa("IN_SHOP", { site_left_clean: "PASS" }).ok);
const full = evaluateQa("IN_SHOP", every(QA_TEMPLATES.IN_SHOP));
ok("T10 the stored checklist is tokens only and small", full.ok && JSON.stringify(full.checklist).length < 1024 && Object.values(full.checklist.results).every((v) => v === "PASS" || v === "FAIL"));

// Owner decisions 2026-11-11 / 2026-11-12: ALL SEVEN built-in templates (in-shop, field, maintenance, remote, vehicle,
// installation, exchange) — 30 checks (13 + 17) — are suggestions: every check optional, so none must PASS.
const builtIns = Object.values(QA_TEMPLATE_BY_ID);
const builtInItems = builtIns.flatMap((t) => t.items);
ok("T11 seven built-in templates hold exactly 30 checks (13 older + 17 newer)", builtIns.length === 7 && builtInItems.length === 30, `${builtIns.length} templates, ${builtInItems.length} checks`);
ok("T11b the current ids: IN_SHOP.v2, FIELD.v2, MAINTENANCE.v2, REMOTE.v1, VEHICLE.v1, INSTALLATION.v1, EXCHANGE.v1",
  builtIns.map((t) => t.id).sort().join(",") === "EXCHANGE.v1,FIELD.v2,INSTALLATION.v1,IN_SHOP.v2,MAINTENANCE.v2,REMOTE.v1,VEHICLE.v1");
ok("T12 every built-in check is optional (required: false) — 30 of 30", builtInItems.every((i) => i.required === false) && builtInItems.filter((i) => !i.required).length === 30);
ok("T12b every built-in template completes by being performed (everyCheckRecorded), never by a category", builtIns.every((t) => t.everyCheckRecorded === true));
ok("T13 every built-in template: every check recorded with every one FAILED → completed (no check must PASS)",
  builtIns.every((t) => { const e = evaluateQaAgainst(t, every(t, "FAIL")); return e.ok && e.completed && e.counts.requiredFailed === 0 && e.counts.requiredMissing === 0 && e.counts.failed === t.items.length; }));
ok("T13b every built-in template: one check left unrecorded → NOT completed (REQUIRED QA means the checklist was performed)",
  builtIns.every((t) => { const r = every(t); delete r[t.items[t.items.length - 1].key]; const e = evaluateQaAgainst(t, r); return e.ok && !e.completed && e.counts.recorded === t.items.length - 1 && e.counts.requiredMissing === 1 && e.counts.requiredFailed === 0; }));
ok("T13c a single recorded result never completes a built-in checklist",
  builtIns.every((t) => { const e = evaluateQaAgainst(t, { [t.items[0].key]: "PASS" }); return e.ok && !e.completed; }));
ok("T13d through the kind / track entry points: IN_SHOP / FIELD / MAINTENANCE (kind) and every track template by id",
  (["IN_SHOP", "FIELD", "MAINTENANCE"] as const).every((k) => { const e = evaluateQa(k, every(QA_TEMPLATES[k], "FAIL")); return e.ok && e.completed && e.template === QA_TEMPLATES[k].id; })
  && builtIns.every((t) => { const e = evaluateQa(t.kind, every(t), t.id); return e.ok && e.completed && e.template === t.id; }));
ok("T14 the two reworded checks: replaced parts are documented, the remote health check is recorded (no customer confirmation)",
  TRACK_QA_TEMPLATES["VEHICLE.v1"].items.some((i) => i.key === "replaced_parts_handled") && !TRACK_QA_TEMPLATES["VEHICLE.v1"].items.some((i) => i.key === "replaced_parts_kept")
  && QA_TEMPLATES.REMOTE.items.some((i) => i.key === "health_check_recorded") && !QA_TEMPLATES.REMOTE.items.some((i) => i.key === "customer_confirmed_working"));

// History: the retired v1 content is frozen, never offered, never used to judge a new result.
const retired = Object.values(RETIRED_QA_TEMPLATES);
ok("T15 the retired v1 templates keep exactly the 10 REQUIRED checks they had (IN_SHOP 4, FIELD 3, MAINTENANCE 3)",
  retired.length === 3 && retired.flatMap((t) => t.items).filter((i) => i.required).length === 10
  && RETIRED_QA_TEMPLATES["IN_SHOP.v1"].items.filter((i) => i.required).map((i) => i.key).join(",") === "powers_on,original_fault_resolved,no_new_damage,accessories_returned"
  && RETIRED_QA_TEMPLATES["FIELD.v1"].items.filter((i) => i.required).map((i) => i.key).join(",") === "original_fault_resolved,system_tested,site_left_clean"
  && RETIRED_QA_TEMPLATES["MAINTENANCE.v1"].items.filter((i) => i.required).map((i) => i.key).join(",") === "checklist_tasks_done,system_tested,site_left_clean");
ok("T16 a v2 template has the same keys, labels and order as its v1 — only the REQUIRED flags changed",
  Object.entries(QA_TEMPLATE_SUCCESSOR).every(([v1, v2]) => {
    const a = RETIRED_QA_TEMPLATES[v1], b = QA_TEMPLATE_BY_ID[v2];
    return a.kind === b.kind && a.items.map((i) => `${i.key}|${i.label}`).join(";") === b.items.map((i) => `${i.key}|${i.label}`).join(";");
  }));
ok("T17 a retired id is never offered: not in QA_TEMPLATE_BY_ID (no track names it, no list copies it)",
  Object.keys(RETIRED_QA_TEMPLATES).every((id) => !Object.prototype.hasOwnProperty.call(QA_TEMPLATE_BY_ID, id)));
ok("T18 a snapshot that still names a v1 id is judged, for a NEW result, by its successor (suggested)",
  Object.entries(QA_TEMPLATE_SUCCESSOR).every(([v1, v2]) => qaTemplateFor(RETIRED_QA_TEMPLATES[v1].kind, v1)?.id === v2)
  && (() => { const e = evaluateQa("IN_SHOP", every(QA_TEMPLATES.IN_SHOP, "FAIL"), "IN_SHOP.v1"); return e.ok && e.completed && e.template === "IN_SHOP.v2"; })());
ok("T19 reading history: a v1 id resolves to its frozen content, a current id to itself, an unknown id to nothing",
  qaTemplateForHistory("IN_SHOP.v1") === RETIRED_QA_TEMPLATES["IN_SHOP.v1"] && qaTemplateForHistory("VEHICLE.v1") === TRACK_QA_TEMPLATES["VEHICLE.v1"]
  && qaTemplateForHistory("NOPE.v1") === null && qaTemplateForHistory("constructor") === null);
ok("T20 an unknown track template id is refused (never a fallback), also a prototype name",
  !evaluateQa("IN_SHOP", { powers_on: "PASS" }, "NOPE.v9").ok && qaTemplateFor("IN_SHOP", "toString") === null && qaTemplateFor("IN_SHOP", "__proto__") === null);

console.log(`\nqa-templates: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
