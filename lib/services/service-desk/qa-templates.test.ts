/**
 * Run: npx tsx lib/services/service-desk/qa-templates.test.ts
 *
 * P3 — the base QA checklists (pure): three templates, one per kind; QA completes only when every required item is
 * PASS; a failed or missing required item keeps it open; optional items never block; unknown keys / values refused.
 */
import { QA_TEMPLATES, evaluateQa } from "./qa-templates";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const all = (kind: "IN_SHOP" | "FIELD" | "MAINTENANCE", v: "PASS" | "FAIL" = "PASS", only?: "required") =>
  Object.fromEntries(QA_TEMPLATES[kind].items.filter((i) => !only || i.required).map((i) => [i.key, v]));

ok("T1 one template per kind, each with required items and keys as tokens",
  (["IN_SHOP", "FIELD", "MAINTENANCE"] as const).every((k) => QA_TEMPLATES[k].kind === k && QA_TEMPLATES[k].items.some((i) => i.required)
    && QA_TEMPLATES[k].items.every((i) => /^[a-z_]{2,40}$/.test(i.key))
    && new Set(QA_TEMPLATES[k].items.map((i) => i.key)).size === QA_TEMPLATES[k].items.length));
for (const k of ["IN_SHOP", "FIELD", "MAINTENANCE"] as const) {
  const e = evaluateQa(k, all(k, "PASS", "required"));
  ok(`T2 ${k}: every required item PASS (optional absent) → completed`, e.ok && e.completed && e.counts.requiredMissing === 0 && e.counts.requiredFailed === 0);
}
const req = QA_TEMPLATES.IN_SHOP.items.filter((i) => i.required).map((i) => i.key);
const oneFailed = { ...all("IN_SHOP", "PASS", "required"), [req[0]]: "FAIL" };
const f1 = evaluateQa("IN_SHOP", oneFailed);
ok("T3 a required item FAILED → not completed (requiredFailed 1)", f1.ok && !f1.completed && f1.counts.requiredFailed === 1);
const missing = Object.fromEntries(Object.entries(all("IN_SHOP", "PASS", "required")).filter(([k]) => k !== req[1]));
const m1 = evaluateQa("IN_SHOP", missing);
ok("T4 a required item not recorded → not completed (requiredMissing 1)", m1.ok && !m1.completed && m1.counts.requiredMissing === 1);
const optFail = evaluateQa("IN_SHOP", { ...all("IN_SHOP", "PASS", "required"), cleaned: "FAIL" });
ok("T5 an optional item FAILED does not block", optFail.ok && optFail.completed && optFail.counts.failed === 1);
ok("T6 an unknown key → refused, never ignored", !evaluateQa("IN_SHOP", { ...all("IN_SHOP"), hacked: "PASS" }).ok);
ok("T7 a value other than PASS / FAIL → refused (true, 'pass', 'N/A')",
  !evaluateQa("IN_SHOP", { powers_on: true }).ok && !evaluateQa("IN_SHOP", { powers_on: "pass" }).ok && !evaluateQa("IN_SHOP", { powers_on: "N/A" }).ok);
ok("T8 no results / an array / null → refused", !evaluateQa("IN_SHOP", {}).ok && !evaluateQa("IN_SHOP", []).ok && !evaluateQa("IN_SHOP", null).ok);
ok("T9 a FIELD key is not valid on an IN_SHOP case", !evaluateQa("IN_SHOP", { site_left_clean: "PASS" }).ok);
const full = evaluateQa("IN_SHOP", all("IN_SHOP"));
ok("T10 the stored checklist is tokens only and small", full.ok && JSON.stringify(full.checklist).length < 1024 && Object.values(full.checklist.results).every((v) => v === "PASS" || v === "FAIL"));

console.log(`\nqa-templates: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
