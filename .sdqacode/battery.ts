/**
 * Service Desk QA lists CODE — the per-business QA lists through the REAL service (createQaList, reviseQaList,
 * setQaListArchived, listQaLists, getQaList, chooseCaseQaList, recordQa, getCaseQa, runCaseAction) AS the runtime role, on
 * the M1 chain with migration 20261129090000 applied (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh, .sdqa/chain.sh).
 * Every write passes the database guards of the real migrations — the list / version / journal guards, the case's choice
 * guard and its deferred journal / completion triggers, the record / result guards, RLS. Synthetic only.
 *
 *   L  lists: from a built-in template (copied, all optional) or own checks; idempotent replay; revise (rename, add /
 *      remove, REQUIRED per check) → a new version, the old one unchanged; NO_CHANGE / stale revision / unknown key
 *      refused; archive / restore; the reads (list, one list, a version, history, use)
 *   C  the case's choice: journaled (qa.list_chosen, numbers only), replay, NO_CHANGE, archived, another business's list,
 *      QA OFF on the track, stale version, fixed once QA is passed
 *   Q  results: per check against the case's list version (REQUIRED blocks PASS_QA until it PASSES; notes stored);
 *      the case's QA view; a later revision of the list never reaches the case or its records
 *   M  track modes: OPTIONAL (a list never forces QA; qa: true goes through it), REQUIRED with an all-optional list,
 *      REQUIRED without a list (built-in template recorded per check), OFF (no list), a case opened without a list
 *   I  isolation  ·  X  erasure: service_qa_lists_erase_business() scrubs what the service wrote; the reads still work
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordQa, runCaseAction, type OpenCaseInput, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import {
  chooseCaseQaList, createQaList, getCaseQa, getQaList, listQaLists, reviseQaList, setQaListArchived, type QaListDetail,
} from "../lib/services/service-desk/qa-lists.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const key = () => uuidV7(new Date());
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
/** The service's answer: "OK" or the refusal (code + details), never a stack. */
async function tryIt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}:${JSON.stringify(e.details)}`;
    return `THROW:${(e as Error).message.replace(/\s+/g, " ").slice(-240)}`;
  }
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdqacode-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdqacode-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  // the general profile (every business, no category read) + T4 enabled by the owner
  await rtRows(b, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey", "profileOverrides") VALUES ($1, 1, now(), 'general', $2::jsonb) RETURNING "businessId"`,
    b, JSON.stringify({ enabledTracks: ["T4"] }));
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const open = async (z: Biz, input: Partial<OpenCaseInput>) =>
  (await openCase(z.p, { customerId: z.cust, problemDescription: "תקלה סינתטית", ...input }, { idempotencyKey: key() })).case;
async function row(z: Biz, id: number) {
  const r = (await own(z.b, `SELECT version, status::text status, "qaListId", "qaListVersion", "qaCompletedAt" IS NOT NULL done FROM "ServiceCase" WHERE id = $1`, id))[0];
  return { version: Number(r.version), status: String(r.status), listId: r.qaListId === null ? null : Number(r.qaListId), listVersion: r.qaListVersion === null ? null : Number(r.qaListVersion), done: r.done === true };
}
async function act(z: Biz, id: number, action: Record<string, unknown>): Promise<string> {
  const v = (await row(z, id)).version;
  return tryIt(() => runCaseAction(z.p, id, { action, expectedVersion: v }, { idempotencyKey: key() }));
}
async function walk(z: Biz, id: number, actions: Record<string, unknown>[]): Promise<string> {
  for (const a of actions) {
    const r = await act(z, id, a);
    if (r !== "OK") return `${String(a.type)}: ${r}`;
  }
  return "OK";
}
const TO_REPAIR = [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }];
const choose = async (z: Biz, id: number, listId: number | null, k = key()) => {
  const v = (await row(z, id)).version;
  return tryIt(() => chooseCaseQaList(z.p, id, { listId, expectedVersion: v }, { idempotencyKey: k }));
};
const qa = async (z: Biz, id: number, results: Record<string, unknown>) => {
  const v = (await row(z, id)).version;
  return tryIt(() => recordQa(z.p, id, { results, expectedVersion: v }, { idempotencyKey: key() }));
};
let last: QaListDetail | null = null;
async function create(z: Biz, body: Record<string, unknown>, k = key()): Promise<string> {
  return tryIt(async () => { last = await createQaList(z.p, body, { idempotencyKey: k }); });
}
const OWN = { name: "בדיקת התקנה שלנו", items: [{ label: "נבדקו חיבורים", required: true }, { label: "האתר נוקה", required: false }, { label: "הלקוח הודרך", required: true }] };

async function main() {
  const A = await business("a");
  const B = await business("b");

  console.log("L — lists");
  ok("L1 a list copied from the suggested VEHICLE.v1 template → version 1, its five checks, all optional, origin recorded",
    (await create(A, { name: "בדיקת רכב", fromTemplate: "VEHICLE.v1" })) === "OK" && last!.list.currentVersion === 1 && last!.version.items.length === 5
      && last!.version.items.every((i) => !i.required) && last!.list.sourceTemplateId === "VEHICLE.v1" && last!.history.length === 1 && last!.history[0].action === "CREATE"
      && last!.usage.allCases === 0, JSON.stringify(last?.list));
  const VEH = last!.list.id;
  const k1 = key();
  ok("L2 own checks → keys i1_1.., REQUIRED as chosen (2 of 3)",
    (await create(A, OWN, k1)) === "OK" && last!.version.items.map((i) => i.key).join() === "i1_1,i1_2,i1_3" && last!.list.requiredCount === 2);
  const L = last!.list.id;
  ok("L3 the same key and body → the stored answer (replayed, same list); the same key with another body → IDEMPOTENCY_KEY_REUSED",
    await (async () => { const r = await createQaList(A.p, OWN, { idempotencyKey: k1 }); return r.replayed && r.list.id === L; })()
      && (await create(A, { ...OWN, name: "אחר" }, k1)).startsWith("IDEMPOTENCY_KEY_REUSED"));
  ok("L4 invalid bodies → INVALID_INPUT naming the field (name, items, a label, an unknown template)",
    (await create(A, { name: " ", items: OWN.items })).includes(`"field":"name"`) && (await create(A, { name: "x" })).includes(`"field":"items"`)
      && (await create(A, { name: "x", items: [{ label: "", required: true }] })).includes(`"field":"items[0].label"`)
      && (await create(A, { name: "x", fromTemplate: "BAKERY.v1" })).includes(`"field":"fromTemplate"`));
  const rev = (listId: number, body: Record<string, unknown>, k = key()) => tryIt(async () => { last = await reviseQaList(A.p, listId, body, { idempotencyKey: k }); });
  const cur = await getQaList(A.b, L);
  const items1 = cur.version.items.map((i) => ({ key: i.key, label: i.label, required: i.required }));
  ok("L5 a stale revision → VERSION_CONFLICT; the same content → REFUSED NO_CHANGE; a key not in the version → UNKNOWN_ITEM_KEY",
    (await rev(L, { expectedRevision: 9, name: OWN.name, items: items1 })).startsWith("VERSION_CONFLICT")
      && (await rev(L, { expectedRevision: 1, name: OWN.name, items: items1 })).includes("NO_CHANGE")
      && (await rev(L, { expectedRevision: 1, name: OWN.name, items: [{ key: "nope", label: "x", required: true }] })).includes("UNKNOWN_ITEM_KEY"));
  // the case below names version 1 before the revision (Q4 proves history)
  const early = await open(A, { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 1" });
  ok("L6 a case names version 1", (await choose(A, early.id, L)) === "OK" && (await row(A, early.id)).listVersion === 1);
  const v2items = [{ key: "i1_1", label: "נבדקו חיבורים", required: false }, { key: "i1_3", label: "הלקוח הודרך ואישר", required: true }, { label: "צולם התיעוד", required: true }];
  ok("L7 revise: renamed, a check removed, one added, REQUIRED flipped, one relabelled → version 2 (REVISE journaled)",
    (await rev(L, { expectedRevision: 1, name: "בדיקת התקנה v2", items: v2items })) === "OK" && last!.list.currentVersion === 2 && last!.list.revision === 2
      && last!.version.items.map((i) => i.key).join() === "i1_1,i1_3,i2_1" && last!.history.map((h) => h.action).join() === "CREATE,REVISE");
  const old = await getQaList(A.b, L, { version: 1 });
  ok("L8 version 1 is still readable unchanged (its three checks, labels, flags); the list shows both versions and its use",
    old.version.version === 1 && JSON.stringify(old.version.items.map((i) => [i.key, i.label, i.required])) === JSON.stringify(items1.map((i) => [i.key, i.label, i.required]))
      && old.versions.length === 2 && old.usage.openCases === 1);
  ok("L9 archive → hidden from the default list, shown with includeArchived; revising it → QA_LIST_ARCHIVED; archiving twice → NO_CHANGE; restore",
    (await tryIt(() => setQaListArchived(A.p, VEH, { expectedRevision: 1, archived: true }, { idempotencyKey: key() }))) === "OK"
      && !(await listQaLists(A.b)).lists.some((l) => l.id === VEH) && (await listQaLists(A.b, { includeArchived: true })).lists.some((l) => l.id === VEH && l.archived)
      && (await rev(VEH, { expectedRevision: 2, name: "x", items: [{ label: "x", required: true }] })).includes("QA_LIST_ARCHIVED")
      && (await tryIt(() => setQaListArchived(A.p, VEH, { expectedRevision: 2, archived: true }, { idempotencyKey: key() }))).includes("NO_CHANGE"));
  ok("L10 listQaLists: available, active lists with their current name and counts", await (async () => {
    const r = await listQaLists(A.b); const l = r.lists.find((x) => x.id === L);
    return r.available && l?.name === "בדיקת התקנה v2" && l.currentVersion === 2 && l.itemCount === 3 && l.requiredCount === 2;
  })());

  console.log("C — the case's choice");
  const t1 = await open(A, { track: "T1", subject: { displayName: "מכשיר סינתטי" } });
  const ck = key();
  ok("C1 a T1 case (QA REQUIRED) names the list → its current version 2, one journaled version",
    (await choose(A, t1.id, L, ck)) === "OK" && (await row(A, t1.id)).listVersion === 2 && (await row(A, t1.id)).version === 2);
  const ev = (await own(A.b, `SELECT action::text a, "eventType"::text e, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, t1.id))[0];
  ok("C2 the event: CHOOSE_QA_LIST / qa.list_chosen, numbers only", ev.a === "CHOOSE_QA_LIST" && ev.e === "qa.list_chosen"
    && (() => { const p = ev.payload as Record<string, unknown>; return Object.keys(p).sort().join() === "fromListId,fromListVersion,listId,listVersion" && p.listId === L && p.listVersion === 2 && p.fromListId === null && p.fromListVersion === null; })(), JSON.stringify(ev));
  ok("C3 the same request again → replayed (nothing new); the same list again → NO_CHANGE",
    await (async () => { const r = await chooseCaseQaList(A.p, t1.id, { listId: L, expectedVersion: 1 }, { idempotencyKey: ck }); return r.replayed && r.qaList?.listVersion === 2; })()
      && (await choose(A, t1.id, L)).includes("NO_CHANGE"));
  ok("C4 an archived list → QA_LIST_ARCHIVED; another business's list → QA_LIST_NOT_FOUND; a stale version → VERSION_CONFLICT",
    (await choose(A, t1.id, VEH)).includes("QA_LIST_ARCHIVED")
      && (await (async () => { await create(B, OWN); return choose(A, t1.id, last!.list.id); })()).includes("QA_LIST_NOT_FOUND")
      && (await tryIt(() => chooseCaseQaList(A.p, t1.id, { listId: null, expectedVersion: 1 }, { idempotencyKey: key() }))).startsWith("VERSION_CONFLICT"));
  const LB = last!.list.id;
  const t5 = await open(A, { track: "T5", serviceLocation: "AT_BUSINESS" });
  ok("C5 a track with QA OFF (T5) names no list → QA_NOT_FOR_KIND; clearing nothing → NO_CHANGE",
    (await choose(A, t5.id, L)).includes("QA_NOT_FOR_KIND") && (await choose(A, t5.id, null)).includes("NO_CHANGE"));
  ok("C6 a legacy case without a track: IN_SHOP (REQUIRED) may name a list; FIELD (no QA) may not; opening never needs one",
    await (async () => {
      const a = await open(A, { kind: "IN_SHOP" }); const f = await open(A, { kind: "FIELD" });
      return (await choose(A, a.id, L)) === "OK" && (await choose(A, f.id, L)).includes("QA_NOT_FOR_KIND") && (await row(A, f.id)).status === "OPEN";
    })());
  ok("C7 back to the built-in template (null) → journaled; the case names no list", (await choose(A, t1.id, null)) === "OK" && (await row(A, t1.id)).listId === null);

  console.log("Q — results");
  const t4 = await open(A, { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 2" });
  const path = [await choose(A, t4.id, L), await walk(A, t4.id, [...TO_REPAIR, { type: "FINISH_REPAIR" }])];
  ok("Q1 T4 (REQUIRED) with the list → QA", path.every((s) => s === "OK") && (await row(A, t4.id)).status === "QA", path.join(" | "));
  ok("Q2 a key of the built-in template is not a check of the list → INVALID_INPUT", (await qa(A, t4.id, { installed_as_ordered: "PASS" })).includes("results.installed_as_ordered"));
  ok("Q3 only the optional check PASS → recorded, not complete; PASS_QA refused (QA_INCOMPLETE)",
    (await qa(A, t4.id, { i1_1: "PASS" })) === "OK" && !(await row(A, t4.id)).done && (await act(A, t4.id, { type: "PASS_QA", outcome: "COMPLETED" })).includes("QA_INCOMPLETE"));
  ok("Q4 a REQUIRED check FAILED with a note → recorded, not complete",
    (await qa(A, t4.id, { i1_3: "PASS", i2_1: { result: "FAIL", note: "  חסר צילום של הלוח  " } })) === "OK" && !(await row(A, t4.id)).done);
  ok("Q5 every REQUIRED check PASS → complete; PASS_QA → WORK_DONE",
    (await qa(A, t4.id, { i1_3: "PASS", i2_1: { result: "PASS", note: "צולם" } })) === "OK" && (await row(A, t4.id)).done
      && (await act(A, t4.id, { type: "PASS_QA", outcome: "COMPLETED" })) === "OK" && (await row(A, t4.id)).status === "WORK_DONE");
  const view = await getCaseQa(A.b, t4.id);
  ok("Q6 the case's QA view: REQUIRED, the list's version 2 with labels, three records newest first, each check's result / flag / note",
    view.mode === "REQUIRED" && view.completed && view.checklist?.source === "LIST" && view.checklist.listVersion === 2 && view.checklist.items.length === 3
      && view.records.length === 3 && view.records[0].completed && !view.records[1].completed && view.records[1].counts.requiredFailed === 1
      && view.records[1].results.find((r) => r.key === "i2_1")?.note === "חסר צילום של הלוח" && view.records[1].results.find((r) => r.key === "i2_1")?.label === "צולם התיעוד"
      && view.records[2].counts.requiredMissing === 2 && !view.canRecord && !view.canChooseList, JSON.stringify(view).slice(0, 400));
  ok("Q7 past QA the choice is fixed → QA_LIST_FIXED", (await choose(A, t4.id, null)).includes("QA_LIST_FIXED"));
  // history: the early case named version 1; record against it, then revise the list again
  await walk(A, early.id, [...TO_REPAIR, { type: "FINISH_REPAIR" }]);
  const e1 = await qa(A, early.id, { i1_1: "PASS", i1_2: "FAIL", i1_3: "PASS" });
  const before = JSON.stringify((await getCaseQa(A.b, early.id)).records);
  const v3 = await rev(L, { expectedRevision: 2, name: "בדיקת התקנה v3", items: [{ key: "i1_3", label: "שונה לגמרי", required: false }] });
  const afterView = await getCaseQa(A.b, early.id);
  ok("Q8 a later revision (v3) never reaches a case on v1: it still names v1, its checklist and its records (labels, flags) are byte-identical",
    e1 === "OK" && v3 === "OK" && afterView.checklist?.source === "LIST" && afterView.checklist.listVersion === 1 && afterView.checklist.listCurrentVersion === 3
      && JSON.stringify(afterView.records) === before && afterView.checklist.items.map((i) => i.label).join() === items1.map((i) => i.label).join(), `${e1} ${v3}`);
  ok("Q9 … and its QA completes against v1's own REQUIRED checks", afterView.completed && (await act(A, early.id, { type: "PASS_QA", outcome: "COMPLETED" })) === "OK");

  console.log("M — track modes");
  const t3 = await open(A, { track: "T3", siteAddress: "רחוב סינתטי 3" });
  await choose(A, t3.id, L);
  ok("M1 OPTIONAL (T3) with a list: FINISH_REPAIR without qa skips QA (a list never forces it) → WORK_DONE",
    (await walk(A, t3.id, [...TO_REPAIR, { type: "FINISH_REPAIR", outcome: "REPAIRED" }])) === "OK" && (await row(A, t3.id)).status === "WORK_DONE");
  const t3b = await open(A, { track: "T3", siteAddress: "רחוב סינתטי 4" });
  ok("M2 OPTIONAL with qa: true → QA against the list (v3: one optional check) → PASS_QA",
    (await choose(A, t3b.id, L)) === "OK" && (await walk(A, t3b.id, [...TO_REPAIR, { type: "FINISH_REPAIR", qa: true }])) === "OK"
      && (await qa(A, t3b.id, { i1_3: "PASS" })) === "OK" && (await act(A, t3b.id, { type: "PASS_QA", outcome: "REPAIRED" })) === "OK");
  const t4b = await open(A, { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 5" });
  await choose(A, t4b.id, L); // v3: all optional
  ok("M3 REQUIRED with an all-optional list still goes through QA: PASS_QA refused until a result is recorded, then allowed",
    (await walk(A, t4b.id, [...TO_REPAIR, { type: "FINISH_REPAIR" }])) === "OK" && (await row(A, t4b.id)).status === "QA"
      && (await act(A, t4b.id, { type: "PASS_QA", outcome: "COMPLETED" })).includes("QA_INCOMPLETE")
      && (await qa(A, t4b.id, { i1_3: "FAIL" })) === "OK" && (await act(A, t4b.id, { type: "PASS_QA", outcome: "COMPLETED" })) === "OK");
  const t4c = await open(A, { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי 6" });
  await walk(A, t4c.id, [...TO_REPAIR, { type: "FINISH_REPAIR" }]);
  const tr = await qa(A, t4c.id, { system_tested: { result: "PASS", note: "נבדק" } });
  const trv = await getCaseQa(A.b, t4c.id);
  ok("M4 REQUIRED without a list: the built-in INSTALLATION.v1 (as before), recorded per check with its label and note",
    tr === "OK" && trv.checklist?.source === "TEMPLATE" && trv.checklist.templateId === "INSTALLATION.v1" && trv.records.length === 1
      && trv.records[0].templateId === "INSTALLATION.v1" && trv.records[0].results[0].label === "המערכת נבדקה בהפעלה מלאה" && trv.records[0].results[0].note === "נבדק", `${tr} ${JSON.stringify(trv.records)}`);
  ok("M5 a QA OFF track's view: mode OFF, no checklist, nothing to choose or record", await (async () => {
    const v = await getCaseQa(A.b, t5.id); return v.mode === "OFF" && v.checklist === null && !v.canChooseList && !v.canRecord;
  })());

  console.log("I — isolation");
  ok("I1 B sees none of A's lists; A's list is NOT_FOUND for B; B cannot revise or archive it",
    !(await listQaLists(B.b, { includeArchived: true })).lists.some((l) => l.id === L) && (await tryIt(() => getQaList(B.b, L))).startsWith("NOT_FOUND")
      && (await tryIt(() => reviseQaList(B.p, L, { expectedRevision: 3, name: "x", items: [{ label: "x", required: true }] }, { idempotencyKey: key() }))).startsWith("NOT_FOUND")
      && (await tryIt(() => setQaListArchived(B.p, L, { expectedRevision: 3, archived: true }, { idempotencyKey: key() }))).startsWith("NOT_FOUND"));
  ok("I2 B's case cannot name A's list; A's case QA is NOT_FOUND for B", await (async () => {
    const c = await open(B, { track: "T1", subject: { displayName: "x" } });
    return (await choose(B, c.id, L)).includes("QA_LIST_NOT_FOUND") && (await choose(B, c.id, LB)) === "OK" && (await tryIt(() => getCaseQa(B.b, t4.id))).startsWith("NOT_FOUND");
  })());

  console.log("X — erasure");
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  const n = Number((await rtRows(A.b, `SELECT public.service_qa_lists_erase_business() AS n`))[0].n);
  const left = (await own(A.b, `SELECT (SELECT count(*) FROM "ServiceQaListVersion" WHERE "businessId" = $1 AND name IS NOT NULL)::int v,
      (SELECT count(*) FROM "ServiceQaListItem" WHERE "businessId" = $1 AND label IS NOT NULL)::int i,
      (SELECT count(*) FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1 AND note IS NOT NULL)::int r,
      (SELECT count(*) FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1)::int rn`, A.b))[0];
  const after = await getCaseQa(A.b, t4.id);
  ok("X1 names, labels and notes blanked in place; the results stay; the case's QA view still reads (labels null)",
    n > 0 && Number(left.v) === 0 && Number(left.i) === 0 && Number(left.r) === 0 && Number(left.rn) >= 10
      && after.records.length === 3 && after.records[1].results.every((r) => r.note === null) && after.checklist?.source === "LIST" && after.checklist.items.every((i) => i.label === null),
    `${n} ${JSON.stringify(left)}`);
  ok("X2 nothing new for a business being deleted (BUSINESS_DELETING)", (await create(A, OWN)).startsWith("BUSINESS_DELETING"));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
