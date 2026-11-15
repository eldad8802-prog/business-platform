/**
 * Run: npx tsx lib/services/service-desk/qa-lists-core.test.ts
 *
 * Per-business QA lists (pure): parsing a list, version 1 from a built-in suggested template (copied) or own checks,
 * the next version against the current one (kept checks keep their keys, new ones get keys never used, NO_CHANGE),
 * results against any checklist (REQUIRED / optional, notes, unknown keys and values refused), the case's choice
 * (track QA mode, status, archived list, no change) and the journal payload (numbers only).
 */
import {
  QA_CHOICE_FIXED_STATUSES,
  QA_ITEM_KEY,
  caseQaMode,
  choicePayload,
  decideChoice,
  evaluateChecklist,
  listChecklistToken,
  parseListInput,
  planNewList,
  planRevision,
  type QaListInput,
} from "./qa-lists.core";
import { QA_TEMPLATES, QA_TEMPLATE_BY_ID, RETIRED_QA_TEMPLATES, TRACK_QA_TEMPLATES, evaluateQa, evaluateQaAgainst } from "./qa-templates";
import type { ServiceCaseStatus, ServiceTrackFacts } from "./contracts";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const field = (r: ReturnType<typeof parseListInput>) => (r.ok ? "OK" : r.field);
const input = (body: Record<string, unknown>, allowTemplate = true): QaListInput => {
  const r = parseListInput(body, { allowTemplate });
  if (!r.ok) throw new Error(`unexpected refusal ${r.field}`);
  return r.value;
};

// ── P: parsing ─────────────────────────────────────────────────────────────────────────────────────────────
const ONE = [{ label: "המערכת פועלת", required: true }];
ok("P1 a name and one check → accepted; the name and labels are trimmed",
  (() => { const r = parseListInput({ name: "  בדיקת סיום ", items: [{ label: " עובד ", required: false }] }, { allowTemplate: true }); return r.ok && r.value.name === "בדיקת סיום" && r.value.items![0].label === "עובד" && r.value.items![0].key === null && r.value.fromTemplate === null; })());
ok("P2 the name: missing, not a string, blank, 121 characters, a control character → refused (name); 120 → accepted",
  ["", "   ", undefined, 7, "א".repeat(121), "שם\nשני"].every((n) => field(parseListInput({ name: n, items: ONE }, { allowTemplate: true })) === "name")
    && field(parseListInput({ name: "א".repeat(120), items: ONE }, { allowTemplate: true })) === "OK");
ok("P3 the checks: missing without a template, empty, not an array, 101 → refused (items); 100 → accepted",
  field(parseListInput({ name: "n" }, { allowTemplate: true })) === "items" && field(parseListInput({ name: "n", items: [] }, { allowTemplate: true })) === "items"
    && field(parseListInput({ name: "n", items: {} }, { allowTemplate: true })) === "items"
    && field(parseListInput({ name: "n", items: Array.from({ length: 101 }, () => ({ label: "x", required: true })) }, { allowTemplate: true })) === "items"
    && field(parseListInput({ name: "n", items: Array.from({ length: 100 }, () => ({ label: "x", required: true })) }, { allowTemplate: true })) === "OK");
ok("P4 a check: not an object, an unknown field, a blank / 201-character / control-character label, a non-boolean required → refused with its index",
  field(parseListInput({ name: "n", items: ["x"] }, { allowTemplate: true })) === "items[0]"
    && field(parseListInput({ name: "n", items: [{ label: "x", required: true, extra: 1 }] }, { allowTemplate: true })) === "items[0]"
    && field(parseListInput({ name: "n", items: [{ label: "x", required: true }, { label: " ", required: true }] }, { allowTemplate: true })) === "items[1].label"
    && field(parseListInput({ name: "n", items: [{ label: "ב".repeat(201), required: true }] }, { allowTemplate: true })) === "items[0].label"
    && field(parseListInput({ name: "n", items: [{ label: "א\tב", required: true }] }, { allowTemplate: true })) === "items[0].label"
    && field(parseListInput({ name: "n", items: [{ label: "x", required: "yes" }] }, { allowTemplate: true })) === "items[0].required"
    && field(parseListInput({ name: "n", items: [{ label: "x" }] }, { allowTemplate: true })) === "items[0].required"
    && field(parseListInput({ name: "n", items: [{ label: "ב".repeat(200), required: false }] }, { allowTemplate: true })) === "OK");
ok("P5 a key: a token is kept; not a token, a number or a duplicate → refused",
  (() => { const r = parseListInput({ name: "n", items: [{ key: "works", label: "x", required: true }] }, { allowTemplate: true }); return r.ok && r.value.items![0].key === "works"; })()
    && field(parseListInput({ name: "n", items: [{ key: "Works", label: "x", required: true }] }, { allowTemplate: true })) === "items[0].key"
    && field(parseListInput({ name: "n", items: [{ key: "1a", label: "x", required: true }] }, { allowTemplate: true })) === "items[0].key"
    && field(parseListInput({ name: "n", items: [{ key: 5, label: "x", required: true }] }, { allowTemplate: true })) === "items[0].key"
    && field(parseListInput({ name: "n", items: [{ key: "a", label: "x", required: true }, { key: "a", label: "y", required: true }] }, { allowTemplate: true })) === "items[1].key");
ok("P6 a template: a known id alone → accepted (checks to copy); an unknown id → refused; on a revise it is not accepted",
  (() => { const r = parseListInput({ name: "n", fromTemplate: "VEHICLE.v1" }, { allowTemplate: true }); return r.ok && r.value.items === null && r.value.fromTemplate === "VEHICLE.v1"; })()
    && field(parseListInput({ name: "n", fromTemplate: "BAKERY.v1" }, { allowTemplate: true })) === "fromTemplate"
    && field(parseListInput({ name: "n", fromTemplate: "toString" }, { allowTemplate: true })) === "fromTemplate"
    && field(parseListInput({ name: "n", fromTemplate: "VEHICLE.v1", items: ONE }, { allowTemplate: false })) === "fromTemplate");
ok("P7b a retired template (IN_SHOP.v1 / FIELD.v1 / MAINTENANCE.v1, the old REQUIRED checks) cannot be copied → fromTemplate",
  Object.keys(RETIRED_QA_TEMPLATES).length === 3 && Object.keys(RETIRED_QA_TEMPLATES).every((id) => field(parseListInput({ name: "n", fromTemplate: id }, { allowTemplate: true })) === "fromTemplate"));

// ── N: version 1 ───────────────────────────────────────────────────────────────────────────────────────────
for (const id of [...Object.values(QA_TEMPLATES).map((t) => t.id), ...Object.keys(TRACK_QA_TEMPLATES)]) {
  const v = planNewList(input({ name: "מהתבנית", fromTemplate: id }));
  const t = [...Object.values(QA_TEMPLATES), ...Object.values(TRACK_QA_TEMPLATES)].find((x) => x.id === id)!;
  ok(`N1 from ${id}: its checks copied (keys, labels, REQUIRED flags), the origin recorded`,
    v.sourceTemplateId === id && JSON.stringify(v.items) === JSON.stringify(t.items.map((i) => ({ key: i.key, label: i.label, required: i.required })))
      && v.requiredCount === t.items.filter((i) => i.required).length);
}
ok("N2 every built-in template (all 7, owner 2026-11-12) copies as all-optional (the business then decides per check)",
  Object.keys(QA_TEMPLATE_BY_ID).length === 7
    && Object.keys(QA_TEMPLATE_BY_ID).every((id) => { const v = planNewList(input({ name: "n", fromTemplate: id })); return v.requiredCount === 0 && v.items.every((i) => i.required === false); }));
{
  // owner requirement 3: copy IN_SHOP.v2, then the business marks two checks REQUIRED, removes one, adds one, reorders
  const v1 = planNewList(input({ name: "בדיקת מעבדה", fromTemplate: "IN_SHOP.v2" }));
  const [a, b, c, d, e] = v1.items;
  const r = planRevision(v1, input({ name: "בדיקת מעבדה", items: [{ ...b, required: true }, { ...a, required: true }, c, e, { label: "צולם לפני מסירה", required: false }] }, false), 2, []);
  ok("N2b a copied built-in list: the business marks checks REQUIRED, removes / adds / reorders → a new version with its own flags",
    v1.requiredCount === 0 && r.ok && r.version.requiredCount === 2 && r.changes.requiredChanged === 2 && r.changes.removed === 1 && r.changes.added === 1 && r.changes.reordered
      && r.version.items[0].key === b.key && r.version.items[0].required && !r.version.items.some((i) => i.key === d.key), JSON.stringify(r));
}
const own = planNewList(input({ name: "שלי", items: [{ label: "א", required: true }, { key: "b", label: "ב", required: false }, { label: "ג", required: true }] }));
ok("N3 own checks: keys kept or fresh (i1_n, never colliding), order kept, REQUIRED counted, no origin",
  JSON.stringify(own.items.map((i) => i.key)) === JSON.stringify(["i1_1", "b", "i1_2"]) && own.requiredCount === 2 && own.sourceTemplateId === null && own.name === "שלי");
const clash = planNewList(input({ name: "n", items: [{ key: "i1_1", label: "א", required: true }, { label: "ב", required: true }] }));
ok("N4 a fresh key never repeats a key the request named", clash.items[1].key === "i1_2" && clash.items.every((i) => QA_ITEM_KEY.test(i.key)));
ok("N5 the template's items with own checks: the given checks win, the template is only the origin",
  (() => { const v = planNewList(input({ name: "n", fromTemplate: "IN_SHOP.v2", items: ONE })); return v.items.length === 1 && v.sourceTemplateId === "IN_SHOP.v2"; })());

// ── R: the next version ────────────────────────────────────────────────────────────────────────────────────
const CUR = { name: "בדיקה", items: [{ key: "a", label: "א", required: true }, { key: "b", label: "ב", required: false }, { key: "c", label: "ג", required: true }] };
const rev = (items: unknown[], name = "בדיקה", used: string[] = []) => planRevision(CUR, input({ name, items }, false), 2, used);
ok("R1 the same name, checks, labels, flags and order → NO_CHANGE",
  (() => { const r = rev(CUR.items); return !r.ok && r.code === "NO_CHANGE"; })());
ok("R2 renamed only → a new version (name changed)", (() => { const r = rev(CUR.items, "חדש"); return r.ok && r.changes.name && r.version.name === "חדש"; })());
ok("R3 a check added (no key) → a fresh key i2_n; added 1",
  (() => { const r = rev([...CUR.items, { label: "ד", required: false }]); return r.ok && r.changes.added === 1 && r.version.items[3].key === "i2_1"; })());
ok("R4 a check removed → removed 1, the rest keep their keys",
  (() => { const r = rev([CUR.items[0], CUR.items[2]]); return r.ok && r.changes.removed === 1 && r.version.items.map((i) => i.key).join() === "a,c" && !r.changes.reordered; })());
ok("R5 REQUIRED flipped → requiredChanged 1, requiredCount follows",
  (() => { const r = rev([{ ...CUR.items[0], required: false }, CUR.items[1], CUR.items[2]]); return r.ok && r.changes.requiredChanged === 1 && r.version.requiredCount === 1; })());
ok("R6 relabelled → relabeled 1 (same key)", (() => { const r = rev([{ ...CUR.items[0], label: "א מעודכן" }, CUR.items[1], CUR.items[2]]); return r.ok && r.changes.relabeled === 1 && r.version.items[0].key === "a"; })());
ok("R7 reordered only → a new version (reordered)", (() => { const r = rev([CUR.items[2], CUR.items[0], CUR.items[1]]); return r.ok && r.changes.reordered && r.changes.added === 0 && r.changes.removed === 0; })());
ok("R8 a key that is not in the current version (e.g. a removed check) → UNKNOWN_ITEM_KEY", (() => { const r = rev([{ key: "zz", label: "x", required: true }]); return !r.ok && r.code === "UNKNOWN_ITEM_KEY"; })());
ok("R9 a fresh key never reuses a key the list ever used (older versions included)",
  (() => { const r = rev([...CUR.items, { label: "ד", required: true }, { label: "ה", required: true }], "בדיקה", ["i2_1"]); return r.ok && r.version.items[3].key === "i2_2" && r.version.items[4].key === "i2_3"; })());
ok("R10 a removal and a re-add of the same text is a NEW check (new key), not the old one",
  (() => { const r = rev([CUR.items[0], CUR.items[1], { label: "ג", required: true }]); return r.ok && r.changes.added === 1 && r.changes.removed === 1 && r.version.items[2].key !== "c"; })());
ok("R11 the current version is never modified by planning (input objects untouched)", JSON.stringify(CUR.items[0]) === JSON.stringify({ key: "a", label: "א", required: true }));

// ── E: results ─────────────────────────────────────────────────────────────────────────────────────────────
const CL = [{ key: "a", required: true }, { key: "b", required: false }, { key: "c", required: true }];
const ev = (r: unknown, notes = true) => evaluateChecklist(CL, r, { notes });
ok("E1 every REQUIRED check PASS (optional absent) → completed; results in checklist order",
  (() => { const e = ev({ c: "PASS", a: "PASS" }); return e.ok && e.completed && e.results.map((x) => x.key).join() === "a,c" && e.counts.requiredMissing === 0 && e.counts.items === 3 && e.counts.recorded === 2; })());
ok("E2 a REQUIRED check FAIL → not completed (requiredFailed 1)", (() => { const e = ev({ a: "FAIL", c: "PASS" }); return e.ok && !e.completed && e.counts.requiredFailed === 1 && e.counts.failed === 1; })());
ok("E3 a REQUIRED check missing → not completed (requiredMissing 1)", (() => { const e = ev({ a: "PASS", b: "PASS" }); return e.ok && !e.completed && e.counts.requiredMissing === 1 && e.counts.passed === 2; })());
ok("E4 an optional FAIL never blocks", (() => { const e = ev({ a: "PASS", b: "FAIL", c: "PASS" }); return e.ok && e.completed && e.counts.failed === 1 && e.counts.requiredFailed === 0; })());
ok("E5 all checks optional: one PASS completes it", (() => { const e = evaluateChecklist([{ key: "x", required: false }], { x: "PASS" }, { notes: false }); return e.ok && e.completed; })());
ok("E6 a note (trimmed; blank = none) is kept per check with its REQUIRED flag",
  (() => { const e = ev({ a: { result: "FAIL", note: "  חסר בורג " }, b: { result: "PASS", note: "  " }, c: "PASS" }); return e.ok && e.results[0].note === "חסר בורג" && e.results[0].required && e.results[1].note === null && !e.results[1].required; })());
ok("E7 a note of 501 characters / not a string → refused; 500 accepted",
  !ev({ a: { result: "PASS", note: "א".repeat(501) } }).ok && !ev({ a: { result: "PASS", note: 5 } }).ok && ev({ a: { result: "PASS", note: "א".repeat(500) } }).ok);
ok("E8 notes not allowed (before the migration): the object form is refused", !ev({ a: { result: "PASS" } }, false).ok && ev({ a: "PASS" }, false).ok);
ok("E9 an unknown key, a value other than PASS / FAIL, an unknown field in the object → refused",
  !ev({ zz: "PASS" }).ok && !ev({ a: "pass" }).ok && !ev({ a: true }).ok && !ev({ a: { result: "N/A" } }).ok && !ev({ a: { result: "PASS", by: 1 } }).ok && !ev({ a: ["PASS"] }).ok);
ok("E10 no results, an array or null → refused (results)",
  (() => { const r = [ev({}), ev([]), ev(null)]; return r.every((x) => !x.ok && x.field === "results"); })());
ok("E11 the refusal names the field (results.<key>, results.<key>.note)",
  (() => { const a = ev({ zz: "PASS" }); const b = ev({ a: { result: "PASS", note: 1 } }); return !a.ok && a.field === "results.zz" && !b.ok && b.field === "results.a.note"; })());
for (const k of ["IN_SHOP", "FIELD", "MAINTENANCE", "REMOTE"] as const) {
  const t = QA_TEMPLATES[k];
  const r = Object.fromEntries(t.items.map((i, n) => [i.key, n === 0 ? "FAIL" : "PASS"]));
  const a = evaluateQa(k, r);
  const b = evaluateChecklist(t.items, r, { notes: false, everyCheckRecorded: t.everyCheckRecorded });
  ok(`E12 ${k}: the built-in template judged by the new evaluator = evaluateQa (completed and every count)`,
    a.ok && b.ok && a.completed === b.completed && JSON.stringify(a.counts) === JSON.stringify(b.counts));
}
ok("E13 every built-in template (7): every check recorded, all FAIL → complete; one left out → not; both evaluators agree",
  Object.values(QA_TEMPLATE_BY_ID).every((t) => {
    const all = Object.fromEntries(t.items.map((i) => [i.key, "FAIL"]));
    const part = Object.fromEntries(t.items.slice(1).map((i) => [i.key, "PASS"]));
    const [a1, b1, a2, b2] = [evaluateQaAgainst(t, all), evaluateChecklist(t.items, all, { notes: true, everyCheckRecorded: true }), evaluateQaAgainst(t, part), evaluateChecklist(t.items, part, { notes: true, everyCheckRecorded: true })];
    return a1.ok && b1.ok && a2.ok && b2.ok && a1.completed && b1.completed && !a2.completed && !b2.completed && JSON.stringify(a2.counts) === JSON.stringify(b2.counts);
  }));
ok("E14 a business list never needs every check: without everyCheckRecorded an all-optional list completes with one result",
  (() => { const e = evaluateChecklist([{ key: "x", required: false }, { key: "y", required: false }], { x: "FAIL" }, { notes: false }); return e.ok && e.completed; })());

// ── C: the case's choice ───────────────────────────────────────────────────────────────────────────────────
const L = { listId: 7, currentVersion: 3, archived: false };
const choice = (o: Partial<Parameters<typeof decideChoice>[0]>) => decideChoice({ status: "QA", mode: "REQUIRED", current: null, target: L, ...o });
const viol = (d: ReturnType<typeof decideChoice>) => (d.ok ? [] : d.violations);
ok("C1 a case in QA (REQUIRED) names a list → its CURRENT version", (() => { const d = choice({}); return d.ok && d.to?.listId === 7 && d.to.listVersion === 3; })());
for (const s of ["OPEN", "SCHEDULED", "CHECKED_IN", "DIAGNOSING", "QUOTE_PENDING", "IN_REPAIR", "EXTERNAL", "QA"] as ServiceCaseStatus[]) {
  ok(`C2 ${s}: before QA is passed → allowed`, choice({ status: s }).ok);
}
for (const s of ["READY", "WORK_DONE", "DELIVERED", "CLOSED", "CANCELLED", "ABANDONED"] as ServiceCaseStatus[]) {
  ok(`C3 ${s}: past QA → QA_LIST_FIXED (the same six statuses as service_case_qa_list_guard)`, viol(choice({ status: s })).includes("QA_LIST_FIXED"));
}
ok("C3b the fixed statuses are exactly those six", QA_CHOICE_FIXED_STATUSES.length === 6);
ok("C4 OPTIONAL → allowed; OFF → QA_NOT_FOR_KIND", choice({ mode: "OPTIONAL" }).ok && viol(choice({ mode: "OFF" })).includes("QA_NOT_FOR_KIND"));
ok("C5 OFF: clearing a list (back to none) is allowed", (() => { const d = choice({ mode: "OFF", current: { listId: 7, listVersion: 2 }, target: null }); return d.ok && d.to === null; })());
ok("C6 an archived list → QA_LIST_ARCHIVED", viol(choice({ target: { ...L, archived: true } })).includes("QA_LIST_ARCHIVED"));
ok("C7 the same list at the same version → NO_CHANGE; none → none → NO_CHANGE",
  viol(choice({ current: { listId: 7, listVersion: 3 } })).includes("NO_CHANGE") && viol(choice({ current: null, target: null })).includes("NO_CHANGE"));
ok("C8 the same list at a newer version → allowed (the newer version is taken)", (() => { const d = choice({ current: { listId: 7, listVersion: 2 } }); return d.ok && d.to?.listVersion === 3; })());
ok("C9 another list → allowed; clearing → allowed", choice({ current: { listId: 8, listVersion: 3 } }).ok && choice({ current: { listId: 7, listVersion: 3 }, target: null }).ok);
ok("C10 every violation is reported at once (CLOSED + OFF + archived)",
  (() => { const v = viol(choice({ status: "CLOSED", mode: "OFF", target: { ...L, archived: true } })); return v.length === 3; })());
const track = (mode: "REQUIRED" | "OPTIONAL" | "OFF") => ({ requirements: { qa: { mode, template: null } } }) as unknown as ServiceTrackFacts;
ok("C11 the mode: a track's snapshot wins; without one IN_SHOP REQUIRED, on-site OFF (the core's rule)",
  caseQaMode("FIELD", track("OPTIONAL")) === "OPTIONAL" && caseQaMode("IN_SHOP", track("OFF")) === "OFF" && caseQaMode("IN_SHOP", null) === "REQUIRED"
    && caseQaMode("FIELD", null) === "OFF" && caseQaMode("MAINTENANCE", null) === "OFF" && caseQaMode("REMOTE", null) === "OFF");
const pl = choicePayload({ listId: 1, listVersion: 2 }, { listId: 3, listVersion: 4 });
ok("C12 the journal payload: numbers and null only, the guard's two keys present",
  JSON.stringify(pl) === JSON.stringify({ listId: 3, listVersion: 4, fromListId: 1, fromListVersion: 2 })
    && JSON.stringify(choicePayload(null, null)) === JSON.stringify({ listId: null, listVersion: null, fromListId: null, fromListVersion: null }));
ok("C13 the checklist token fits the journal's token rule", /^[A-Za-z0-9_:.-]{0,64}$/.test(listChecklistToken(2147483647, 2147483647)) && listChecklistToken(12, 3) === "list:12:v3");

console.log(`\nqa-lists-core: ${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
