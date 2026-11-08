/**
 * Service Desk 1.2b PR-2 — account erasure of the work at an external supplier through the REAL adapter, as the
 * runtime role (.sdx/lab.sh --with-sdx, then .sdf/erasure-prereq.sh).
 *
 * `prismaAccountDeletionStore.purgeOperationalData()` is the code account deletion runs. It calls
 * public.service_external_erase_business() inside its purge transaction, next to service_erase_business()
 * (declared in DB_FUNCTION_ERASURES, proven statically by the erasure contract). This battery proves the same path
 * end to end on PostgreSQL, with the 1.2b migration applied as Production has it (guards, triggers, RLS, grants):
 *
 *   X1. a business that is not being deleted: the purge refuses and nothing changes;
 *   X2. the function cannot run (EXECUTE revoked) / is missing (renamed): the whole purge rolls back —
 *       users, staff, the 1.2a rows and the 1.2b rows exactly as before;
 *   X3. a business being deleted: every declared 1.2b column cleared (the work's six texts, the supplier reference,
 *       the sending / returning users; in the journal the actors, digests and the correction reason), erasedAt
 *       stamped, no row removed; supplier, amounts, dates, stages, results and versions stay;
 *   X4. another business's 1.2b rows are untouched;
 *   X5. the runtime still holds no DELETE on either 1.2b table; a second purge changes nothing;
 *   X6. regression: the 1.2a erasure and the user / staff erasures ran in the same purge.
 *
 * env: OWNER_URL (lab owner), DATABASE_URL = DIRECT_URL = the runtime login. Synthetic only.
 */
import { PrismaClient } from "@prisma/client";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const one = async (sql: string, ...a: unknown[]) => (await q(sql, ...a))[0] ?? {};
const n = async (sql: string, ...a: unknown[]) => Number((await one(sql, ...a)).n);
const purge = (biz: number) => prismaAccountDeletionStore.purgeOperationalData(biz).then(() => null, (e: Error) => e.message);
const H = (c: string) => c.repeat(64);
let keySeq = 0;
const ikey = (tag: string) => `sdx-erase-${tag}-${String(++keySeq).padStart(4, "0")}`;

async function business(name: string) {
  const biz = Number((await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name)).id);
  const user = Number((await one(`INSERT INTO "User" (email, name, "businessId", "updatedAt") VALUES ($1, 'בעל עסק', $2, now()) RETURNING id`, `${name}@lab.invalid`, biz)).id);
  const cust = Number((await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz)).id);
  const staff = Number((await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאית דנה', now()) RETURNING id`, biz)).id);
  const supplier = Number((await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz)).id);
  return { biz, user, cust, staff, supplier };
}
type B = Awaited<ReturnType<typeof business>>;

/** A case opened (1.1c) and moved to EXTERNAL with its case events — what a send does first. */
async function externalCase(tx: Tx, b: B, number: number, deviceId: number, tag: string) {
  const kase = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "staffMemberId", "problemDescription", "updatedAt")
    VALUES ($1, $2, 'IN_SHOP', $3, $4, $5, 'המסך לא נדלק ${tag}', now()) RETURNING id`, b.biz, number, b.cust, deviceId, b.staff)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, b.biz, kase, b.user, ikey(tag));
  await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'EXTERNAL', version = version + 1, "updatedAt" = now() WHERE id = $1`, kase);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
    VALUES ($1, $2, 2, 'external.sent', 'SEND_TO_EXTERNAL', 'OPEN', 'EXTERNAL', false, false, 'SYSTEM', '{}', $3)`, b.biz, kase, ikey(tag));
  return kase;
}

/** A send: the work (round 1, every free text, a request digest on its event) and its SENT event. */
async function send(tx: Tx, b: B, kase: number, tag: string) {
  const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "requestedWork", "conditionAtSend", "operationalNote", "expectedBackOn", "updatedAt")
    VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד ${tag}', 'החלפת מסך', 'סדק בפינה', 'שליח ביום ב', DATE '2026-11-20', now()) RETURNING id`, b.biz, kase, b.supplier, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "expectedBackOn", actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES ($1, $2, $3, 1, 'SENT', 'SENT', DATE '2026-11-20', 'OWNER_USER', $4, '{"round":1}', $5, $6, 'k1')`, b.biz, w, kase, b.user, ikey(tag), H("d"));
  return w;
}

/** A change of a work: the row (version + 1, kind) and its event, as task 1.3 will write them. */
async function change(tx: Tx, b: B, w: number, kind: string, set: string, ev: { amount?: number; previous?: number; reason?: string } = {}, tag = "c") {
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServiceExternalWork" SET ${set}, version = version + 1, "lastEventKind" = $2::"ServiceExternalWorkEventKind", "updatedAt" = now()
    WHERE id = $1 RETURNING version, "caseId", "progressStage"::text AS stage, "expectedBackOn"`, w, kind)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "amountAgorot", "previousAmountAgorot", "expectedBackOn", reason, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServiceExternalWorkEventKind", $6::"ServiceExternalProgress", $7, $8, $9::date, $10, 'OWNER_USER', $11, '{}', $12)`,
    b.biz, w, r.caseId, Number(r.version), kind, r.stage, ev.amount ?? null, ev.previous ?? null, r.expectedBackOn, ev.reason ?? null, b.user, ikey(tag));
}

/** Two external works of one business, written as the runtime in its tenant context: one returned, one still out. */
async function externalData(b: B, tag: string) {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${b.biz}', true)`);
    const dev = async (s: string) => Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceDevice" ("businessId", "customerId", category, brand, model, "serialNumber", "serialNormalized", description, "updatedAt")
      VALUES ($1, $2, 'phone', 'Samsung', 'A54', 'SN ${s}', 'SN${s}', 'כחול סדוק', now()) RETURNING id`, b.biz, b.cust)) as Rows)[0].id);
    const c1 = await externalCase(tx, b, 1, await dev(`${tag}1`), tag);
    const c2 = await externalCase(tx, b, 2, await dev(`${tag}2`), tag);
    const w1 = await send(tx, b, c1, tag);
    await change(tx, b, w1, "PROGRESS", `"progressStage" = 'RECEIVED_BY_SUPPLIER', "supplierReference" = 'RMA-${tag.toUpperCase()}-77'`, {}, tag);
    await change(tx, b, w1, "COST_ESTIMATED", `"estimatedCostAgorot" = 12000`, { amount: 12000 }, tag);
    await change(tx, b, w1, "COST_FINAL", `"finalCostAgorot" = 13000`, { amount: 13000 }, tag);
    await change(tx, b, w1, "COST_FINAL_CORRECTED", `"finalCostAgorot" = 13500`, { amount: 13500, previous: 13000, reason: `טעות הקלדה של דנה ${tag}` }, tag);
    await change(tx, b, w1, "RETURNED", `state = 'RETURNED', "returnedAt" = now(), "returnedByUserId" = ${b.user}, "returnResult" = 'REPAIRED',
      "workPerformed" = 'הוחלף מסך', "unresolvedIssue" = 'שריטה בגב', "followUpRequired" = true, "receivedByStaffMemberId" = ${b.staff}`, {}, tag);
    const w2 = await send(tx, b, c2, tag);
    return { c1, c2, w1, w2 };
  });
}

/** Everything erasure may touch, as one comparable snapshot (owner view, all rows). */
async function snapshot(biz: number) {
  return JSON.stringify(await q(`SELECT
      (SELECT json_agg(json_build_object('e', email, 'n', name) ORDER BY id) FROM "User" WHERE "businessId" = $1) AS users,
      (SELECT json_agg("displayName" ORDER BY id) FROM "StaffMember" WHERE "businessId" = $1) AS staff,
      (SELECT json_agg(row_to_json(c) ORDER BY id) FROM "ServiceCase" c WHERE "businessId" = $1) AS cases,
      (SELECT json_agg(row_to_json(d) ORDER BY id) FROM "ServiceDevice" d WHERE "businessId" = $1) AS devices,
      (SELECT json_agg(row_to_json(e) ORDER BY id) FROM "ServiceCaseEvent" e WHERE "businessId" = $1) AS events,
      (SELECT json_agg(row_to_json(w) ORDER BY id) FROM "ServiceExternalWork" w WHERE "businessId" = $1) AS works,
      (SELECT json_agg(row_to_json(j) ORDER BY id) FROM "ServiceExternalWorkEvent" j WHERE "businessId" = $1) AS journal`, biz));
}

async function main() {
  const X = await business("sdx-erase-x"), Y = await business("sdx-erase-y");
  const xs = await externalData(X, "x");
  await externalData(Y, "y");
  ok("0.1 synthetic external works for two businesses (one returned, one at the supplier), written as the runtime",
    await n(`SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "businessId" IN ($1, $2)`, X.biz, Y.biz) === 4
    && await n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1`, X.biz) === 7);

  // X1 — not being deleted
  const before = await snapshot(X.biz);
  const x1 = await purge(X.biz);
  ok("X1 a business that is not being deleted: the purge refuses", x1 !== null, String(x1));
  ok("X1 … and nothing changed (users, staff, 1.2a rows, works, journal)", (await snapshot(X.biz)) === before);

  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, X.biz);

  // X2 — the 1.2b function cannot run, or is missing: the WHOLE purge rolls back
  await x(`REVOKE EXECUTE ON FUNCTION public.service_external_erase_business() FROM app_runtime`);
  const x2a = await purge(X.biz);
  await x(`GRANT EXECUTE ON FUNCTION public.service_external_erase_business() TO app_runtime`);
  ok("X2 EXECUTE revoked: the purge fails", x2a !== null && /permission denied|service_external_erase_business/i.test(x2a), String(x2a));
  ok("X2 … and rolls back whole: users, staff, the 1.2a erasure and the works as before", (await snapshot(X.biz)) === before);
  await x(`ALTER FUNCTION public.service_external_erase_business() RENAME TO service_external_erase_business_away`);
  const x2b = await purge(X.biz);
  await x(`ALTER FUNCTION public.service_external_erase_business_away() RENAME TO service_external_erase_business`);
  ok("X2 the function missing: the purge fails", x2b !== null && /does not exist|service_external_erase_business/i.test(x2b), String(x2b));
  ok("X2 … and rolls back whole", (await snapshot(X.biz)) === before);

  // X3 — the real erasure
  const ySnap = await snapshot(Y.biz);
  const rowCount = (biz: number) => n(`SELECT (SELECT count(*) FROM "ServiceExternalWork" WHERE "businessId" = $1)
      + (SELECT count(*) FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1) AS n`, biz);
  const rowsBefore = await rowCount(X.biz);
  const x3 = await purge(X.biz);
  ok("X3 a business being deleted: the purge succeeds", x3 === null, String(x3));
  const w1 = await one(`SELECT "sendReason" a, "requestedWork" b, "conditionAtSend" c, "operationalNote" d, "supplierReference" r, "workPerformed" wp,
      "unresolvedIssue" ui, "sentByUserId" su, "returnedByUserId" ru, "erasedAt" IS NOT NULL e, "supplierId" s, state::text st, "progressStage"::text ps,
      "returnResult"::text rr, "estimatedCostAgorot" ec, "finalCostAgorot" fc, "expectedBackOn"::text eb, "followUpRequired" fu, "receivedByStaffMemberId" rs,
      version v, "lastEventKind"::text k, currency cur FROM "ServiceExternalWork" WHERE id = $1`, xs.w1);
  ok("X3 returned work: the six texts, the supplier reference and both users cleared; erasedAt stamped",
    [w1.a, w1.b, w1.c, w1.d, w1.r, w1.wp, w1.ui, w1.su, w1.ru].every((v) => v === null) && w1.e === true, JSON.stringify(w1));
  ok("X3 returned work: supplier, state, stage, result, costs, date, follow-up, receiving staff, version and kind kept",
    Number(w1.s) === X.supplier && w1.st === "RETURNED" && w1.ps === "RECEIVED_BY_SUPPLIER" && w1.rr === "REPAIRED" && Number(w1.ec) === 12000
    && Number(w1.fc) === 13500 && w1.eb === "2026-11-20" && w1.fu === true && Number(w1.rs) === X.staff && Number(w1.v) === 6 && w1.k === "RETURNED" && w1.cur === "ILS",
    JSON.stringify(w1));
  const w2 = await one(`SELECT "sendReason" a, "requestedWork" b, "conditionAtSend" c, "operationalNote" d, "sentByUserId" su, "erasedAt" IS NOT NULL e, state::text st, version v
      FROM "ServiceExternalWork" WHERE id = $1`, xs.w2);
  ok("X3 work still at the supplier: texts and user cleared, erasedAt stamped; AT_SUPPLIER / version 1 kept",
    [w2.a, w2.b, w2.c, w2.d, w2.su].every((v) => v === null) && w2.e === true && w2.st === "AT_SUPPLIER" && Number(w2.v) === 1, JSON.stringify(w2));
  const j = await one(`SELECT count(*)::int n,
      count(*) FILTER (WHERE "actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL OR reason IS NOT NULL OR "erasedAt" IS NULL)::int leftover,
      count(*) FILTER (WHERE kind = 'COST_FINAL_CORRECTED' AND "amountAgorot" = 13500 AND "previousAmountAgorot" = 13000)::int corr,
      string_agg(kind::text || ':' || seq, ',' ORDER BY "workId", seq) seqs
    FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1`, X.biz);
  ok("X3 journal: actors, digests and the correction reason cleared on every event; erasedAt stamped",
    Number(j.n) === 7 && Number(j.leftover) === 0, JSON.stringify(j));
  ok("X3 journal: kinds, seqs and the correction's amounts kept",
    Number(j.corr) === 1 && j.seqs === "SENT:1,PROGRESS:2,COST_ESTIMATED:3,COST_FINAL:4,COST_FINAL_CORRECTED:5,RETURNED:6,SENT:1", JSON.stringify(j));
  ok("X3 no 1.2b row removed (erased in place)", (await rowCount(X.biz)) === rowsBefore);

  // X4 — the other business
  ok("X4 business Y's rows (1.2a and 1.2b) are untouched", (await snapshot(Y.biz)) === ySnap);

  // X5 — no DELETE for the runtime; a second purge changes nothing
  ok("X5 the runtime holds no DELETE on either 1.2b table",
    await n(`SELECT count(*)::int AS n FROM unnest(ARRAY['ServiceExternalWork','ServiceExternalWorkEvent']) t
      WHERE has_table_privilege('app_runtime', format('public.%I', t), 'DELETE')`) === 0);
  const after = await snapshot(X.biz);
  const x5 = await purge(X.biz);
  const again = JSON.parse(await snapshot(X.biz))[0], was = JSON.parse(after)[0];
  ok("X5 a second purge succeeds and changes no 1.2b row",
    x5 === null && JSON.stringify(again.works) === JSON.stringify(was.works) && JSON.stringify(again.journal) === JSON.stringify(was.journal), String(x5));

  // X6 — regression: the purge's other erasures ran in the same transaction
  const c = await one(`SELECT "problemDescription" p, "erasedAt" IS NOT NULL e, status::text s FROM "ServiceCase" WHERE id = $1`, xs.c1);
  ok("X6 regression: the 1.2a erasure ran in the same purge (case text cleared, EXTERNAL kept)", c.p === null && c.e === true && c.s === "EXTERNAL", JSON.stringify(c));
  const u = await one(`SELECT email e FROM "User" WHERE id = $1`, X.user);
  const s = await one(`SELECT "displayName" dn, "erasedAt" IS NOT NULL e FROM "StaffMember" WHERE id = $1`, X.staff);
  ok("X6 regression: the user is anonymised and the staff member blanked by the same purge",
    u.e !== "sdx-erase-x@lab.invalid" && s.dn === "" && s.e === true, JSON.stringify({ u, s }));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch(async (e) => {
  console.error(e);
  await owner.$disconnect();
  await runtime.$disconnect();
  process.exit(1);
});
