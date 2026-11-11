/**
 * Service Desk QA track defaults CODE — the business's default QA list per track through the REAL service
 * (getQaTrackDefaults, setQaTrackDefault, openCase with / without qaListId, and #1125's chooseCaseQaList, recordQa,
 * getCaseQa, the QA list commands, runCaseAction) AS the runtime role, on the QA lists lab with migration 20261130100000
 * applied (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh, .sdqa/chain.sh, .sdqad/chain.sh). Every write passes the
 * database guards of the real migrations. Synthetic only.
 *
 *   G  the defaults: the seven tracks read (revision 0, QA mode of the current profile), set / switch / clear, replay,
 *      key reuse, stale revision, NO_CHANGE, another business's list, an archived list, invalid input, racing writers
 *   O  the opening: the default's CURRENT version pinned (journaled CHOOSE_QA_LIST at version 2, "#2" key, source
 *      DEFAULT), replay, explicit override, explicit none, OFF track ignores it, REQUIRED without a default → the built-in
 *      template, a case without a track, refused explicit lists write nothing
 *   H  history: a new default / a new list version / an archive never touch an existing case; an archived default counts
 *      as none at the opening (and says so), restored it counts again; a case opened with a default runs its QA against
 *      the pinned version and can still change its list by #1125's rules
 *   I  isolation  ·  X  erasure: service_qa_track_defaults_erase_business() scrubs what the service wrote; reads work
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordQa, runCaseAction, type OpenCaseInput, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { chooseCaseQaList, createQaList, getCaseQa, reviseQaList, setQaListArchived } from "../lib/services/service-desk/qa-lists.service";
import { getQaTrackDefaults, setQaTrackDefault } from "../lib/services/service-desk/qa-track-defaults.service";

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
async function tryIt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}:${JSON.stringify(e.details)}`;
    return `THROW:${(e as Error).message.replace(/\s+/g, " ").slice(-240)}`;
  }
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdqadcode-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdqadcode-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  // the general profile (every business, no category read) + T4 enabled by the owner
  await rtRows(b, `INSERT INTO "ServiceSettings" ("businessId", version, "updatedAt", "serviceProfileKey", "profileOverrides") VALUES ($1, 1, now(), 'general', $2::jsonb) RETURNING "businessId"`,
    b, JSON.stringify({ enabledTracks: ["T4"] }));
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
type Opened = Awaited<ReturnType<typeof openCase>>;
const T1 = { track: "T1", subject: { displayName: "מכשיר סינתטי" } };
const T3 = { track: "T3", siteAddress: "רחוב סינתטי 3" };
const T4 = { track: "T4", serviceLocation: "FIELD_SITE", siteAddress: "אתר סינתטי" };
const T5 = { track: "T5", serviceLocation: "AT_BUSINESS" };
async function open(z: Biz, input: Partial<OpenCaseInput>, k = key()): Promise<Opened> {
  return openCase(z.p, { customerId: z.cust, problemDescription: "תקלה סינתטית", ...input }, { idempotencyKey: k });
}
const tryOpen = (z: Biz, input: Partial<OpenCaseInput>) => tryIt(() => open(z, input));
async function row(z: Biz, id: number) {
  const r = (await own(z.b, `SELECT version, status::text status, "qaListId", "qaListVersion", "qaCompletedAt" IS NOT NULL done FROM "ServiceCase" WHERE id = $1`, id))[0];
  return { version: Number(r.version), status: String(r.status), listId: r.qaListId === null ? null : Number(r.qaListId), listVersion: r.qaListVersion === null ? null : Number(r.qaListVersion), done: r.done === true };
}
const events = (z: Biz, id: number) => own(z.b, `SELECT seq, action::text a, "eventType"::text e, payload, "idempotencyKey" k FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq`, id);
async function act(z: Biz, id: number, action: Record<string, unknown>): Promise<string> {
  const v = (await row(z, id)).version;
  return tryIt(() => runCaseAction(z.p, id, { action, expectedVersion: v }, { idempotencyKey: key() }));
}
async function walk(z: Biz, id: number, actions: Record<string, unknown>[]): Promise<string> {
  for (const a of actions) { const r = await act(z, id, a); if (r !== "OK") return `${String(a.type)}: ${r}`; }
  return "OK";
}
const TO_QA = [{ type: "CHECK_IN" }, { type: "START_DIAGNOSIS" }, { type: "START_REPAIR" }, { type: "FINISH_REPAIR" }];
const choose = async (z: Biz, id: number, listId: number | null) => {
  const v = (await row(z, id)).version;
  return tryIt(() => chooseCaseQaList(z.p, id, { listId, expectedVersion: v }, { idempotencyKey: key() }));
};
const qa = async (z: Biz, id: number, results: Record<string, unknown>) => {
  const v = (await row(z, id)).version;
  return tryIt(() => recordQa(z.p, id, { results, expectedVersion: v }, { idempotencyKey: key() }));
};
const OWN = { name: "בדיקה שלנו", items: [{ label: "נבדק", required: true }, { label: "נוקה", required: false }] };
async function list(z: Biz, name = OWN.name): Promise<number> {
  return (await createQaList(z.p, { ...OWN, name }, { idempotencyKey: key() })).list.id;
}
const setD = (z: Biz, track: string, listId: number | null, expectedRevision: number, k = key()) =>
  tryIt(() => setQaTrackDefault(z.p, track, { listId, expectedRevision }, { idempotencyKey: k }));
const view = async (z: Biz, track: string) => (await getQaTrackDefaults(z.b)).tracks.find((v) => v.track === track)!;
const caseCount = async (z: Biz) => Number((await own(z.b, `SELECT count(*)::int n FROM "ServiceCase" WHERE "businessId" = $1`, z.b))[0].n);

async function main() {
  const A = await business("a");
  const B = await business("b");
  const L = await list(A, "בדיקת סיום");
  const L2 = await list(A, "בדיקה מקוצרת");
  const LB = await list(B, "של עסק אחר");

  console.log("G — the defaults");
  const g0 = await getQaTrackDefaults(A.b);
  ok("G1 seven tracks, none set (revision 0, NO_DEFAULT); each with the current profile's QA mode (T1 REQUIRED, T3 OPTIONAL, T5 OFF)",
    g0.available && g0.profileKey === "general" && g0.tracks.map((v) => v.track).join() === "T1,T2,T3,T4,T5,T6,T7"
      && g0.tracks.every((v) => v.revision === 0 && v.listId === null && !v.appliesAtOpening)
      && g0.tracks.find((v) => v.track === "T1")!.qaMode === "REQUIRED" && g0.tracks.find((v) => v.track === "T3")!.qaMode === "OPTIONAL"
      && g0.tracks.find((v) => v.track === "T5")!.qaMode === "OFF" && g0.tracks.find((v) => v.track === "T5")!.reason === "QA_OFF"
      && g0.tracks.find((v) => v.track === "T1")!.reason === "NO_DEFAULT", JSON.stringify(g0.tracks.map((v) => [v.track, v.qaMode, v.reason])));
  const k1 = key();
  const s1 = await setQaTrackDefault(A.p, "T1", { listId: L, expectedRevision: 0 }, { idempotencyKey: k1 });
  ok("G2 T1 → L: revision 1, the list's name and current version, applies at opening, who and when",
    !s1.replayed && s1.revision === 1 && s1.listId === L && s1.list?.name === "בדיקת סיום" && s1.list.currentVersion === 1 && s1.appliesAtOpening && s1.reason === "DEFAULT"
      && s1.changedByUserId === A.u && typeof s1.changedAt === "string", JSON.stringify(s1));
  ok("G3 the same key and body → the stored answer (replayed); the same key with another body → IDEMPOTENCY_KEY_REUSED",
    await (async () => { const r = await setQaTrackDefault(A.p, "T1", { listId: L, expectedRevision: 0 }, { idempotencyKey: k1 }); return r.replayed && r.revision === 1 && r.listId === L; })()
      && (await setD(A, "T1", L2, 0, k1)).startsWith("IDEMPOTENCY_KEY_REUSED") && (await setD(A, "T3", L, 0, k1)).startsWith("IDEMPOTENCY_KEY_REUSED"));
  ok("G4 a stale revision → VERSION_CONFLICT; the same list again → NO_CHANGE",
    (await setD(A, "T1", L2, 0)).startsWith("VERSION_CONFLICT") && (await setD(A, "T1", L, 1)).includes("NO_CHANGE"));
  ok("G5 another business's list → QA_LIST_NOT_FOUND (nothing written)",
    (await setD(A, "T2", LB, 0)).includes("QA_LIST_NOT_FOUND") && (await view(A, "T2")).revision === 0);
  const LX = await list(A, "בארכיון");
  await setQaListArchived(A.p, LX, { expectedRevision: 1, archived: true }, { idempotencyKey: key() });
  ok("G6 an archived list → QA_LIST_ARCHIVED", (await setD(A, "T2", LX, 0)).includes("QA_LIST_ARCHIVED"));
  ok("G7 invalid input names the field: track, listId, expectedRevision, an unknown field",
    (await setD(A, "T9", L, 0)).includes(`"field":"track"`) && (await tryIt(() => setQaTrackDefault(A.p, "T2", { listId: "1", expectedRevision: 0 }, { idempotencyKey: key() }))).includes(`"field":"listId"`)
      && (await tryIt(() => setQaTrackDefault(A.p, "T2", { listId: L, expectedRevision: -1 }, { idempotencyKey: key() }))).includes(`"field":"expectedRevision"`)
      && (await tryIt(() => setQaTrackDefault(A.p, "T2", { listId: L, expectedRevision: 0, x: 1 } as never, { idempotencyKey: key() }))).includes(`"field":"x"`)
      && (await tryIt(() => setQaTrackDefault(A.p, "T2", { listId: L, expectedRevision: 0 }, { idempotencyKey: "not-a-key" }))).startsWith("IDEMPOTENCY_KEY_INVALID"));
  const race = await Promise.all([setD(A, "T6", L, 0), setD(A, "T6", L2, 0), setD(A, "T6", L, 0)]);
  ok("G8 three writers of revision 0 at once: exactly one wins, the others VERSION_CONFLICT; one row",
    race.filter((r) => r === "OK").length === 1 && race.filter((r) => r.startsWith("VERSION_CONFLICT")).length === 2
      && Number((await own(A.b, `SELECT count(*)::int n FROM "ServiceQaTrackDefault" WHERE track = 'T6'`))[0].n) === 1, race.join(" | "));
  const kr = key();
  const same = await Promise.all([setD(A, "T7", L, 0, kr), setD(A, "T7", L, 0, kr)]);
  ok("G9 the same request twice at once: one write, one replay (no error)", same.every((r) => r === "OK") && (await view(A, "T7")).revision === 1, same.join(" | "));
  ok("G10 switch and clear: T6 → L2 (rev 2) → none (rev 3); clearing again → NO_CHANGE",
    (await setD(A, "T6", (await view(A, "T6")).listId === L ? L2 : L, 1)) === "OK" && (await setD(A, "T6", null, 2)) === "OK"
      && (await view(A, "T6")).listId === null && (await view(A, "T6")).revision === 3 && (await setD(A, "T6", null, 3)).includes("NO_CHANGE"));
  ok("G11 a default on a QA-OFF track (T5) is the business's choice: kept, but it does not apply (QA_OFF)",
    (await setD(A, "T5", L, 0)) === "OK" && !(await view(A, "T5")).appliesAtOpening && (await view(A, "T5")).reason === "QA_OFF");

  console.log("O — the opening");
  const k2 = key();
  const o1 = await open(A, T1, k2);
  const e1 = await events(A, o1.case.id);
  ok("O1 a T1 case opens naming the default's CURRENT version (L v1): case version 2, reason DEFAULT",
    o1.qaList?.reason === "DEFAULT" && o1.qaList.list?.listId === L && o1.qaList.list.listVersion === 1 && o1.case.version === 2
      && (await row(A, o1.case.id)).listId === L && (await row(A, o1.case.id)).listVersion === 1, JSON.stringify(o1.qaList));
  ok("O2 journaled: OPEN at seq 1, CHOOSE_QA_LIST / qa.list_chosen at seq 2 with the request key + #2, payload listId / version, source DEFAULT",
    e1.length === 2 && e1[0].a === "OPEN" && e1[1].a === "CHOOSE_QA_LIST" && e1[1].e === "qa.list_chosen" && e1[1].k === `${k2}#2`
      && (() => { const p = e1[1].payload as Record<string, unknown>; return p.listId === L && p.listVersion === 1 && p.fromListId === null && p.source === "DEFAULT" && p.atOpening === true; })(), JSON.stringify(e1));
  const r1 = await open(A, T1, k2);
  ok("O3 the same opening again → replayed: the same case, no new event, no new number", r1.replayed && r1.case.id === o1.case.id && (await events(A, o1.case.id)).length === 2);
  ok("O4 the same key with another qaListId → IDEMPOTENCY_KEY_REUSED", (await tryIt(() => open(A, { ...T1, qaListId: L2 }, k2))).startsWith("IDEMPOTENCY_KEY_REUSED"));
  const o2 = await open(A, { ...T1, qaListId: L2 });
  ok("O5 an explicit list overrides the default (L2 current version), reason EXPLICIT", o2.qaList?.reason === "EXPLICIT" && (await row(A, o2.case.id)).listId === L2
    && ((await events(A, o2.case.id))[1].payload as Record<string, unknown>).source === "EXPLICIT");
  const o3 = await open(A, { ...T1, qaListId: null });
  const v3 = await getCaseQa(A.b, o3.case.id);
  ok("O6 explicitly none overrides the default: no list, version 1, the built-in IN_SHOP.v1 checklist (T1 REQUIRED)",
    o3.qaList?.reason === "EXPLICIT_NONE" && o3.case.version === 1 && (await row(A, o3.case.id)).listId === null
      && v3.mode === "REQUIRED" && v3.checklist?.source === "TEMPLATE" && v3.checklist.templateId === "IN_SHOP.v1");
  const o4 = await open(A, T5);
  ok("O7 a QA-OFF track (T5) ignores its default: no list, reason QA_OFF, version 1", o4.qaList?.reason === "QA_OFF" && (await row(A, o4.case.id)).listId === null && o4.case.version === 1);
  const n0 = await caseCount(A);
  ok("O8 an explicit list on a QA-OFF track → QA_NOT_FOR_KIND; another business's list → QA_LIST_NOT_FOUND; an archived one → QA_LIST_ARCHIVED; nothing opened",
    (await tryOpen(A, { ...T5, qaListId: L })).includes("QA_NOT_FOR_KIND") && (await tryOpen(A, { ...T1, qaListId: LB })).includes("QA_LIST_NOT_FOUND")
      && (await tryOpen(A, { ...T1, qaListId: LX })).includes("QA_LIST_ARCHIVED") && (await caseCount(A)) === n0);
  ok("O9 an invalid qaListId → INVALID_INPUT naming it", (await tryOpen(A, { ...T1, qaListId: "5" })).includes(`"field":"qaListId"`));
  const o5 = await open(A, T4);
  const v5 = await getCaseQa(A.b, o5.case.id);
  ok("O10 a REQUIRED track without a default (T4): no list, NO_DEFAULT, the built-in INSTALLATION.v1 as before",
    o5.qaList?.reason === "NO_DEFAULT" && v5.checklist?.source === "TEMPLATE" && v5.checklist.templateId === "INSTALLATION.v1");
  const o6 = await open(A, { kind: "IN_SHOP" });
  ok("O11 a case without a track has no track default (NO_TRACK); an explicit list still allowed there (IN_SHOP REQUIRED)",
    o6.qaList?.reason === "NO_TRACK" && (await row(A, o6.case.id)).listId === null
      && (await open(A, { kind: "IN_SHOP", qaListId: L })).qaList?.reason === "EXPLICIT");

  console.log("H — history");
  const caseBefore = JSON.stringify(await row(A, o1.case.id));
  ok("H1 a new default (T1 → L2) never touches a case opened before: it still names L v1",
    (await setD(A, "T1", L2, 1)) === "OK" && JSON.stringify(await row(A, o1.case.id)) === caseBefore);
  ok("H2 the next T1 case names L2", (await row(A, (await open(A, T1)).case.id)).listId === L2);
  await setD(A, "T4", L, 0);
  const h3 = await open(A, T4);
  const rv = await reviseQaList(A.p, L, { expectedRevision: 1, name: "בדיקת סיום v2", items: [{ key: "i1_1", label: "נבדק", required: true }, { label: "צולם", required: true }] }, { idempotencyKey: key() });
  const h3b = await open(A, T4);
  ok("H3 a new version of the default list: the older case keeps v1; the next opening pins v2",
    rv.list.currentVersion === 2 && (await row(A, h3.case.id)).listVersion === 1 && (await row(A, h3b.case.id)).listVersion === 2 && (await row(A, o1.case.id)).listVersion === 1);
  await setD(A, "T3", L, 0);
  const h4 = await open(A, T3);
  const archived = await setQaListArchived(A.p, L, { expectedRevision: 2, archived: true }, { idempotencyKey: key() });
  const h4b = await open(A, T3);
  const vT3 = await view(A, "T3");
  ok("H4 the default list archived: the next T3 opening names none and says DEFAULT_ARCHIVED; the read shows it; earlier cases keep their version",
    archived.list.archived && h4b.qaList?.reason === "DEFAULT_ARCHIVED" && (await row(A, h4b.case.id)).listId === null
      && vT3.listId === L && vT3.reason === "DEFAULT_ARCHIVED" && !vT3.appliesAtOpening && vT3.list?.archived === true
      && (await row(A, h4.case.id)).listId === L && (await row(A, h3.case.id)).listVersion === 1, JSON.stringify(vT3));
  ok("H5 an archived default list still reads on the old case (getCaseQa: its pinned version, listArchived)", await (async () => {
    const v = await getCaseQa(A.b, h3.case.id); return v.checklist?.source === "LIST" && v.checklist.listVersion === 1 && v.checklist.listArchived;
  })());
  await setQaListArchived(A.p, L, { expectedRevision: 3, archived: false }, { idempotencyKey: key() });
  const h6 = await open(A, T3);
  ok("H6 restored: the default counts again (current version 2)", h6.qaList?.reason === "DEFAULT" && (await row(A, h6.case.id)).listVersion === 2);
  const qaPath = await walk(A, h3.case.id, TO_QA);
  ok("H7 a case opened with the default runs QA against its pinned v1: v1's REQUIRED check blocks, then PASS_QA",
    qaPath === "OK" && (await row(A, h3.case.id)).status === "QA" && (await act(A, h3.case.id, { type: "PASS_QA", outcome: "COMPLETED" })).includes("QA_INCOMPLETE")
      && (await qa(A, h3.case.id, { i1_2: "PASS" })) === "OK" && !(await row(A, h3.case.id)).done
      && (await qa(A, h3.case.id, { i1_1: "PASS" })) === "OK" && (await row(A, h3.case.id)).done
      && (await act(A, h3.case.id, { type: "PASS_QA", outcome: "COMPLETED" })) === "OK", qaPath);
  ok("H8 a case opened with the default may change its list by #1125's rules (another list; back to the template); past QA it is fixed",
    (await choose(A, h3b.case.id, L2)) === "OK" && (await row(A, h3b.case.id)).listId === L2 && (await choose(A, h3b.case.id, null)) === "OK"
      && (await choose(A, h3.case.id, L2)).includes("QA_LIST_FIXED"));

  console.log("I — isolation");
  ok("I1 B reads its own seven tracks, none of A's defaults", await (async () => {
    const g = await getQaTrackDefaults(B.b); return g.tracks.every((v) => v.revision === 0 && v.listId === null);
  })());
  ok("I2 B cannot make A's list its default; B's T1 opening names nothing of A", (await setD(B, "T1", L, 0)).includes("QA_LIST_NOT_FOUND")
    && (await open(B, T1)).qaList?.reason === "NO_DEFAULT");
  ok("I3 B's own default works for B only", (await setD(B, "T1", LB, 0)) === "OK" && (await row(B, (await open(B, T1)).case.id)).listId === LB
    && (await view(A, "T1")).listId === L2);

  console.log("X — erasure");
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  const n = Number((await rtRows(A.b, `SELECT public.service_qa_track_defaults_erase_business() AS n`))[0].n);
  const left = (await own(A.b, `SELECT count(*) FILTER (WHERE "actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL)::int dirty, count(*)::int total FROM "ServiceQaTrackDefault" WHERE "businessId" = $1`, A.b))[0];
  const after = await getQaTrackDefaults(A.b);
  ok("X1 who chose and the digests are blanked in place; the defaults still read (changedByUserId null)",
    n > 0 && Number(left.dirty) === 0 && Number(left.total) === n && after.tracks.find((v) => v.track === "T1")!.listId === L2
      && after.tracks.every((v) => v.changedByUserId === null), `${n} ${JSON.stringify(left)}`);
  ok("X2 nothing new for a business being deleted (BUSINESS_DELETING)", (await setD(A, "T2", L2, 0)).startsWith("BUSINESS_DELETING"));
  ok("X3 B untouched", Number((await own(B.b, `SELECT count(*)::int n FROM "ServiceQaTrackDefault" WHERE "actorUserId" IS NOT NULL`))[0].n) === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
