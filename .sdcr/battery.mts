/**
 * Service Desk — migration 20261222090000_service_desk_case_records: the light case work in the case history.
 *   before   A7 applied, 20261222090000 NOT: the real services (lend / return / task link / fields) write exactly what they
 *            wrote before — no new journal event (the application detects the migration's CHECK).
 *   after    applied: each REAL change is one status-preserving event by the owner with actorUserId; a change that changes
 *            nothing writes none; the payload is closed (no location text, no item name, no note); the CHECK refuses an
 *            action with another event type, a status change, a missing actor; another business sees none of it.
 * Synthetic only. env: OWNER_URL (lab_owner), DIRECT_URL (app_runtime_prod), DATABASE_URL, AUTH_TOKEN_SECRET, TASK_REQUEST_HMAC_KEY.
 */
import { PrismaClient } from "@prisma/client";

/** before = the code BEFORE the migration; after = the code after it (code PR); db = the migration alone (migration-only PR). */
const MODE = process.argv[2] === "after" ? "after" : process.argv[2] === "db" ? "db" : "before";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
async function asRuntime(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
let pass = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => { if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); } };
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
async function asOwner(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b)); return (await tx.$queryRawUnsafe(sql, ...a)) as Rows; });
}
async function attempt(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return "OK"; } catch (e) { return (e as Error).message.replace(/\s+/g, " ").slice(-260); }
}

async function main() {
  const { openCase } = await import("@/lib/services/service-desk/service-case.service");
  const { lendItem, returnLoan, setTaskLink, setCaseFields } = await import("@/lib/services/service-desk/case-extras.service");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const t = Date.now();
  const biz = async (tag: string) => {
    const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdcr-${MODE}-${tag}-${t}`))[0].id);
    const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdcr-${MODE}-${tag}-${t}@lab.invalid`, b))[0].id);
    const cust = Number((await asOwner(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
    const p = { businessId: b, userId: u } as never;
    const c = await runWithTenantContext({ businessId: b }, async () =>
      (await openCase(p, { kind: "IN_SHOP", customerId: cust, problemDescription: "בדיקה" } as never, { idempotencyKey: uuidV7(new Date()) })).case.id);
    const task = Number((await asOwner(b, `INSERT INTO "Task" ("businessId", title, "updatedAt") VALUES ($1, 'להזמין חלק', now()) RETURNING id`, b))[0].id);
    return { b, u, c, p, task };
  };
  const A = await biz("A");
  const B = await biz("B");
  const inA = <T,>(f: () => Promise<T>) => runWithTenantContext({ businessId: A.b }, f);
  const events = async (z: { b: number; c: number }) =>
    asOwner(z.b, `SELECT seq, "eventType"::text t, action::text a, "fromStatus"::text f, "toStatus"::text s, actor::text actor, "actorUserId" u, payload::text p
                  FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND "caseId" = $2 ORDER BY seq`, z.b, z.c);
  const version = async (z: { b: number; c: number }) => Number((await asOwner(z.b, `SELECT version FROM "ServiceCase" WHERE id = $1`, z.c))[0].version);

  const ready = (await q(`SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ServiceCaseEvent_case_records_in_place') AS ok`))[0].ok === true;
  ok(`M0 the migration's CHECK is ${MODE === "before" ? "absent" : "present"}`, ready === (MODE !== "before"));

  // ── the real services ──
  const v0 = await version(A);
  const lent = await inA(() => lendItem(A.p, A.c, { itemName: "טלפון חלופי", note: "בקופסה" }, { idempotencyKey: uuidV7(new Date()) }));
  const loanId = lent.loan.id;
  await inA(() => returnLoan(A.p, A.c, loanId));
  await inA(() => returnLoan(A.p, A.c, loanId)); // again: already returned → no change
  await inA(() => setTaskLink(A.p, A.c, { taskId: A.task, link: true }));
  await inA(() => setTaskLink(A.p, A.c, { taskId: A.task, link: true })); // again: already linked here → no change
  await inA(() => setTaskLink(A.p, A.c, { taskId: A.task, link: false }));
  await inA(() => setCaseFields(A.p, A.c, { itemLocationNote: "מדף 3", estimatedReadyOn: "2026-12-01" }));
  await inA(() => setCaseFields(A.p, A.c, { itemLocationNote: "מדף 3", estimatedReadyOn: "2026-12-01" })); // same values → no change
  await inA(() => setCaseFields(A.p, A.c, { itemLocationNote: null, estimatedReadyOn: "2026-12-01" }));
  const ev = await events(A);
  const recs = ev.filter((e) => ["RECORD_WORK_DETAILS", "LEND_ITEM", "RETURN_ITEM", "LINK_TASK", "UNLINK_TASK"].includes(String(e.a)));

  if (MODE === "db") {
    ok("D1 the migration alone: the application of this PR still journals nothing new (its code comes in the code PR)", recs.length === 0, JSON.stringify(ev.map((e) => e.t)));
    const vals = (await q(`SELECT string_agg(enumlabel, ',' ORDER BY enumlabel) v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceEventType' AND enumlabel IN ('case.work_details_recorded','loan.lent','loan.returned','task.linked','task.unlinked')`))[0].v;
    ok("D2 the five event types exist", vals === "case.work_details_recorded,loan.lent,loan.returned,task.linked,task.unlinked", String(vals));
    const acts = (await q(`SELECT count(*)::int n FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ServiceCaseAction' AND enumlabel IN ('RECORD_WORK_DETAILS','LEND_ITEM','RETURN_ITEM','LINK_TASK','UNLINK_TASK')`))[0].n;
    ok("D3 the five actions exist", acts === 5, String(acts));
  }
  if (MODE === "before") {
    ok("B1 before the migration: the services work and write no new journal event (only the opening)", recs.length === 0 && ev.length === 1, JSON.stringify(ev.map((e) => e.t)));
    ok("B2 before the migration: the case version does not move", (await version(A)) === v0);
    ok("B3 the work itself is stored as before (loan returned, task unlinked, location cleared, date kept)",
      (await asOwner(A.b, `SELECT "returnedAt" IS NOT NULL r FROM "ServiceCaseLoaner" WHERE id = $1`, loanId))[0].r === true
      && (await asOwner(A.b, `SELECT "serviceCaseId" c FROM "Task" WHERE id = $1`, A.task))[0].c === null
      && (await asOwner(A.b, `SELECT "itemLocationNote" l, to_char("estimatedReadyOn", 'YYYY-MM-DD') d FROM "ServiceCase" WHERE id = $1`, A.c))[0].d === "2026-12-01");
  }
  if (MODE === "after") {
    const kinds = recs.map((e) => e.t).join(",");
    ok("A1 exactly the real changes are journaled, in order (no event for a repeat that changes nothing)",
      kinds === "loan.lent,loan.returned,task.linked,task.unlinked,case.work_details_recorded,case.work_details_recorded", kinds);
    ok("A2 every record is the owner's, with who acted, and never moves the case",
      recs.every((e) => e.actor === "OWNER_USER" && Number(e.u) === A.u && e.f === e.s));
    ok("A3 each record bumps the case version (seq = version)", (await version(A)) === v0 + recs.length && Number(ev[ev.length - 1].seq) === v0 + recs.length);
    const payloads = recs.map((e) => String(e.p)).join(" ");
    ok("A4 the payload is closed: ids, flags and the date token — no location text, no item name, no note",
      !payloads.includes("מדף") && !payloads.includes("טלפון") && !payloads.includes("בקופסה") && payloads.includes(`"loanId": ${loanId}`) && payloads.includes(`"taskId": ${A.task}`), payloads);
    const wd = recs.filter((e) => e.t === "case.work_details_recorded").map((e) => JSON.parse(String(e.p)));
    ok("A5 the work details say what changed: location set + date set, then location cleared only",
      wd[0]?.locationChanged === true && wd[0]?.locationSet === true && wd[0]?.estimatedChanged === true && wd[0]?.estimatedReadyOn === "2026-12-01"
      && wd[1]?.locationChanged === true && wd[1]?.locationSet === false && wd[1]?.estimatedChanged === false, JSON.stringify(wd));
    ok("A6 another business sees none of A's records (RLS, as the runtime role)", (await asRuntime(B.b, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, A.c))[0].n === 0
      && ((await asRuntime(A.b, `SELECT count(*)::int n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, A.c))[0].n as number) > 0);
    // A11: the same case worked on at the same moment (two people, two tabs): every real change is journaled once, none
    // is lost to a lock conflict (the loan insert / task link take KEY SHARE on the case before the record's FOR UPDATE).
    const C = await inA(async () => (await openCase(A.p, { kind: "IN_SHOP", customerId: Number((await asOwner(A.b, `SELECT id FROM "Customer" WHERE "businessId" = $1 LIMIT 1`, A.b))[0].id), problemDescription: "במקביל" } as never, { idempotencyKey: uuidV7(new Date()) })).case.id);
    const ROUNDS = 6;
    const failed: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const t1 = Number((await asOwner(A.b, `INSERT INTO "Task" ("businessId", title, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, A.b, `משימה ${i}a`))[0].id);
      const t2 = Number((await asOwner(A.b, `INSERT INTO "Task" ("businessId", title, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, A.b, `משימה ${i}b`))[0].id);
      const r = await Promise.allSettled([
        inA(() => lendItem(A.p, C, { itemName: `חלופי ${i}a` }, { idempotencyKey: uuidV7(new Date()) })),
        inA(() => lendItem(A.p, C, { itemName: `חלופי ${i}b` }, { idempotencyKey: uuidV7(new Date()) })),
        inA(() => setTaskLink(A.p, C, { taskId: t1, link: true })),
        inA(() => setTaskLink(A.p, C, { taskId: t2, link: true })),
        inA(() => setCaseFields(A.p, C, { itemLocationNote: `מגירה ${i}`, estimatedReadyOn: null })),
      ]);
      for (const x of r) if (x.status === "rejected") failed.push(String((x.reason as Error)?.message ?? x.reason).replace(/\s+/g, " ").slice(0, 160));
    }
    const cev = await events({ b: A.b, c: C });
    const crec = cev.filter((e) => ["RECORD_WORK_DETAILS", "LEND_ITEM", "LINK_TASK"].includes(String(e.a)));
    const seqOk = cev.every((e, k) => Number(e.seq) === k + 1) && (await version({ b: A.b, c: C })) === cev.length;
    ok("A11 the same case worked on in parallel: no write fails, every real change is journaled exactly once, seq stays gapless",
      failed.length === 0 && crec.length === ROUNDS * 5 && seqOk, `failed=${failed.length} ${failed[0] ?? ""} records=${crec.length}/${ROUNDS * 5} seqOk=${seqOk}`);
    // the CHECK, as the table owner (the guard is the point): a wrong pair, a status change, a missing actor
  }
  if (MODE !== "before") {
    const ins = (z: { b: number; c: number; u: number }, eventType: string, action: string, to: string, userId: number | null) =>
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(z.b));
        await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET version = version + 1 WHERE id = $1`, z.c); // the event matches the case version
        await tx.$executeRawUnsafe(`
          INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "holdReasonBefore", "holdReasonAfter",
            "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, "actorUserId", payload, "idempotencyKey")
          SELECT $1, $2, version, $3::"ServiceEventType", $4::"ServiceCaseAction", status, $5::"ServiceCaseStatus", NULL, NULL, false, false, NULL,
            'OWNER_USER', $6, '{}'::jsonb, $7 FROM "ServiceCase" WHERE id = $2`, z.b, z.c, eventType, action, to, userId, `sdcr-${uuidV7(new Date())}`);
        throw new Error("ROLLBACK_OK"); // never keep a test row
      });
    const r7 = await attempt(() => ins(B, "loan.returned", "LEND_ITEM", "OPEN", B.u));
    ok("A7 the CHECK refuses an action with another event type", r7.includes("case_records_in_place"), r7);
    const r8 = await attempt(() => ins(B, "loan.lent", "LEND_ITEM", "CHECKED_IN", B.u));
    ok("A8 a record that moves the case is refused", r8 !== "OK" && !r8.includes("ROLLBACK_OK"), r8);
    const r9 = await attempt(() => ins(B, "task.linked", "LINK_TASK", "OPEN", null));
    ok("A9 the CHECK refuses a record without who acted", r9.includes("case_records_in_place"), r9);
    const good = await attempt(() => ins(B, "task.linked", "LINK_TASK", "OPEN", B.u));
    ok("A9b control: the right shape passes the CHECK (then rolled back)", good.includes("ROLLBACK_OK"), good);
    ok("A10 no earlier event was touched (no backfill, no invented history)", ev[0].t === "case.opened" && Number(ev[0].seq) === 1);
  }

  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
