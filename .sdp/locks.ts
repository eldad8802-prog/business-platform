/**
 * Service Desk 1.2c / M2 — what can be proven TODAY, before the M2 migration exists (.sdp/lab.sh).
 *
 * Runs AS the real roles on a database with 1.2a + 1.2b applied and the inventory cluster under Production RLS:
 *
 *   A. M2's dependencies: the composite keys it will reference exist; the inventory / purchasing tables are under FORCE
 *      RLS; PurchaseOrder has NO (businessId, id) key (so M2 validates order links in a trigger, not an FK); the existing
 *      1.2b triggers serialise on the case row with FOR UPDATE and nothing takes FOR SHARE on it; M0 state (INFO).
 *   B. Lock semantics on the real rows, the facts M2's guards rest on:
 *      B1 an FK check (KEY SHARE) does NOT wait for a status update (NO KEY UPDATE) — the race a deferred check alone
 *         cannot close; B2/B3 FOR SHARE / FOR UPDATE do wait;
 *      B4 the planned "FOR SHARE in the part trigger" + 1.2b's FOR UPDATE triggers DEADLOCK (share → exclusive
 *         upgrade); B5 FOR UPDATE first (1.2b's convention) serialises without a deadlock;
 *      B6 a supplier return that locks the work before the case deadlocks with a part send that locks the case first;
 *         B7 the same two with the case locked first by both (the existing server duty) serialise.
 *   C. The cancel gap on 1.2a: a FIELD case may go straight to CANCELLED (terminal) — so CANCELLED is never evidence
 *      that parts are resolved; C4 / C5 (the parts side) run when the M2 tables exist and are PENDING otherwise.
 *   D. M0 (inventory session), reproduced in SQL only — no inventory code is touched: the read-modify-write of
 *      createMovement loses an update under concurrency; currentQuantity may be set negative; the atomic conditional
 *      update the contract asks for is exact under the same concurrency.
 *
 * Output: PASS / FAIL / INFO / PENDING. PENDING = cannot run before M2 exists — never counted as a pass.
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. Raw SQL only.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=24&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0, info = 0, pending = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function note(name: string, detail: string) { info++; console.log(`  [INFO] ${name} — ${detail}`); }
function later(name: string, why: string) { pending++; console.log(`  [PENDING] ${name} — ${why}`); }

type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => e.message);
}
const q = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>);
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, k = "n") => Number(rows(r)[0]?.[k] ?? NaN);
const succeeded = (r: unknown) => typeof r !== "string";
const LOCKED = /55P03|could not obtain lock|lock_not_available/i;
const DEADLOCK = /40P01|deadlock detected/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }
let keySeq = 0;
const ikey = () => `sdp-lab-key-${String(++keySeq).padStart(6, "0")}`;

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────
const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");
async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz);
  const user = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `${name}@lab.invalid`, biz);
  const supplier = await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz);
  return { biz, cust, user, supplier };
}
type B = Awaited<ReturnType<typeof business>>;
async function openCaseTx(tx: Tx, b: B, kind: "IN_SHOP" | "FIELD") {
  const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
    ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1 RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
    VALUES ($1, $2, $3::"ServiceCaseKind", $4, 'לא נדלק', now()) RETURNING id`, b.biz, n, kind, b.cust)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', '{}', $3)`, b.biz, id, ikey());
  return id;
}
async function caseMoveTx(tx: Tx, biz: number, caseId: number, set: string, action: string, type: string, from: string, to: string, outcome: string | null = null) {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET ${set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", false, false, $8::"ServiceOutcome", 'SYSTEM', '{}', $9)`,
    biz, caseId, v, type, action, from, to, outcome, ikey());
}
async function externalWork(b: B) {
  return inTx(runtime, b.biz, async (tx) => {
    const c = await openCaseTx(tx, b, "IN_SHOP");
    await caseMoveTx(tx, b.biz, c, `status = 'EXTERNAL'`, "SEND_TO_EXTERNAL", "external.sent", "OPEN", "EXTERNAL");
    const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "updatedAt")
      VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד', now()) RETURNING id`, b.biz, c, b.supplier, b.user)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'SENT', 'SENT', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, c, b.user, ikey());
    return { caseId: c, workId: w };
  });
}

/** Two transactions, each a list of steps, interleaved by explicit gates; returns each one's result or error. */
async function lockCase(tx: Tx, id: number, mode: string, nowait = false) {
  return tx.$queryRawUnsafe(`SELECT 1 FROM "ServiceCase" WHERE id = $1 ${mode}${nowait ? " NOWAIT" : ""}`, id);
}
async function lockWork(tx: Tx, id: number, mode: string) {
  return tx.$queryRawUnsafe(`SELECT 1 FROM "ServiceExternalWork" WHERE id = $1 ${mode}`, id);
}

async function main() {
  // ── A. dependencies ──────────────────────────────────────────────────────────────────────────────────────
  console.log("A. M2's dependencies on this database");
  const keys = ["InventoryItem_id_businessId_key", "InventoryMovement_id_businessId_key", "ServiceCase_businessId_id_key",
    "ServiceDevice_businessId_id_key", "ServiceQuote_businessId_caseId_version_key", "ServiceExternalWork_businessId_id_key"];
  ok(`A1 the six composite keys M2 references exist (${keys.length})`,
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY($1::text[])`, keys)) === keys.length);
  ok("A2 PurchaseOrder has no (businessId, id) key — M2 validates order links in a trigger, not an FK",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'PurchaseOrder' AND indexdef ILIKE '%UNIQUE%("businessId", id)%'`)) === 0);
  ok("A3 InventoryItem, InventoryMovement, PurchaseOrder, PurchaseOrderLine: RLS enabled + forced (as Production)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('InventoryItem','InventoryMovement','PurchaseOrder','PurchaseOrderLine') AND relrowsecurity AND relforcerowsecurity`)) === 4);
  ok("A4 1.2b is applied here (ServiceExternalWork exists) — M2's FK target",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'ServiceExternalWork' AND relnamespace = 'public'::regnamespace`)) === 1);
  const lockers = rows(await q(owner, null, `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
      AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR UPDATE' ORDER BY proname`)).map((r) => String(r.proname));
  const m2Here = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('ServicePart','ServicePartEvent') AND relnamespace = 'public'::regnamespace`)) === 2;
  const expectedLockers = ["service_external_work_insert_guard", "service_handover_no_open_external", ...(m2Here ? ["service_part_guard", "service_part_insert_guard"] : [])].sort();
  ok(`A5 the triggers that lock the case row take FOR UPDATE: the 1.2b send and handover guards${m2Here ? " + the two M2 part guards" : " (convention M2 follows)"}`,
    JSON.stringify(lockers) === JSON.stringify(expectedLockers), lockers.join(","));
  ok("A6 no existing function takes FOR SHARE on the case row",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR (SHARE|KEY SHARE)'`)) === 0);
  const hasReason = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_enum WHERE enumtypid = '"InventoryMovementReason"'::regtype AND enumlabel = 'SERVICE_PART'`));
  const hasCheck = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"InventoryItem"'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%currentQuantity%'`));
  note("A7 M0 (inventory session)", `SERVICE_PART reason ${hasReason ? "present" : "ABSENT"}; CHECK on currentQuantity ${hasCheck ? "present" : "ABSENT"}`);
  const m2 = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('ServicePart','ServicePartEvent') AND relnamespace = 'public'::regnamespace`));
  note("A8 M2 tables", m2 === 2 ? "present (20261115090000_service_parts) — C4 / C5 run below" : "absent (no M2 migration in this database) — .sdp/battery.ts reports its checks as PENDING");

  // ── B. lock semantics ──────────────────────────────────────────────────────────────────────────────────────
  console.log("B. lock semantics on the real case / work rows (runtime role, tenant context)");
  const L = await business("sdp-locks");
  const caseId = (await inTx(runtime, L.biz, (tx) => openCaseTx(tx, L, "IN_SHOP"))) as number;
  {
    const held = gate(), done = gate();
    const a = inTx(runtime, L.biz, async (tx) => { await lockCase(tx, caseId, "FOR NO KEY UPDATE"); held.open(); await done.p; return "held"; });
    await held.p;
    const keyShare = await inTx(runtime, L.biz, (tx) => lockCase(tx, caseId, "FOR KEY SHARE", true));
    const share = await inTx(runtime, L.biz, (tx) => lockCase(tx, caseId, "FOR SHARE", true));
    const upd = await inTx(runtime, L.biz, (tx) => lockCase(tx, caseId, "FOR UPDATE", true));
    done.open(); await a;
    ok("B1 an FK check's KEY SHARE does NOT wait for a status update in flight — a deferred check alone cannot close the close/add race", succeeded(keyShare), String(keyShare));
    ok("B2 FOR SHARE waits for it (NOWAIT refuses) — what closes the race", typeof share === "string" && LOCKED.test(share), String(share));
    ok("B3 FOR UPDATE waits for it as well", typeof upd === "string" && LOCKED.test(upd), String(upd));
  }
  {
    // B4: the plan's first draft — FOR SHARE in the part trigger — meets 1.2b's FOR UPDATE triggers in two transactions.
    const aShared = gate(), bShared = gate();
    const A = inTx(runtime, L.biz, async (tx) => { await lockCase(tx, caseId, "FOR SHARE"); aShared.open(); await bShared.p; await lockCase(tx, caseId, "FOR UPDATE"); return "A"; });
    const Bx = inTx(runtime, L.biz, async (tx) => { await aShared.p; await lockCase(tx, caseId, "FOR SHARE"); bShared.open(); await sleep(100); await lockCase(tx, caseId, "FOR UPDATE"); return "B"; });
    const [ra, rb] = await Promise.all([A, Bx]);
    const dead = [ra, rb].filter((r) => typeof r === "string" && DEADLOCK.test(r)).length;
    ok("B4 FOR SHARE first, then FOR UPDATE (1.2b's trigger lock), in two transactions: Postgres detects a DEADLOCK — so M2's part triggers must NOT take FOR SHARE",
      dead === 1 && [ra, rb].some((r) => r === "A" || r === "B"), `${ra} | ${rb}`);
  }
  {
    // B5: the correction — FOR UPDATE first, the lock 1.2b already takes.
    const aHeld = gate();
    let bWaited = 0;
    const A = inTx(runtime, L.biz, async (tx) => { await lockCase(tx, caseId, "FOR UPDATE"); aHeld.open(); await sleep(400); await lockCase(tx, caseId, "FOR UPDATE"); return "A"; });
    const Bx = inTx(runtime, L.biz, async (tx) => { await aHeld.p; const t = Date.now(); await lockCase(tx, caseId, "FOR UPDATE"); bWaited = Date.now() - t; await lockCase(tx, caseId, "FOR UPDATE"); return "B"; });
    const [ra, rb] = await Promise.all([A, Bx]);
    ok("B5 FOR UPDATE first in both (1.2b's convention): they serialise — no deadlock, the second waits for the first", ra === "A" && rb === "B" && bWaited >= 250, `${ra} | ${rb} | waited ${bWaited}ms`);
  }
  {
    const W = await business("sdp-work");
    const ew = (await externalWork(W)) as { caseId: number; workId: number } | string;
    ok("B6.0 fixture: a case at a supplier with its open work (1.2b triggers satisfied)", typeof ew !== "string", String(ew));
    if (typeof ew !== "string") {
      // R: a return that locks the work first, then the case. S: a part send — case first (FOR UPDATE), then the work (FOR SHARE).
      const rWork = gate(), sCase = gate();
      const R = inTx(runtime, W.biz, async (tx) => { await lockWork(tx, ew.workId, "FOR NO KEY UPDATE"); rWork.open(); await sCase.p; await lockCase(tx, ew.caseId, "FOR NO KEY UPDATE"); return "R"; });
      const S = inTx(runtime, W.biz, async (tx) => { await rWork.p; await lockCase(tx, ew.caseId, "FOR UPDATE"); sCase.open(); await sleep(100); await lockWork(tx, ew.workId, "FOR SHARE"); return "S"; });
      const [rr, rs] = await Promise.all([R, S]);
      ok("B6 a supplier return that locks the WORK before the CASE deadlocks with a part send (case → work): the return path must lock the case first",
        [rr, rs].filter((r) => typeof r === "string" && DEADLOCK.test(r)).length === 1, `${rr} | ${rs}`);
      // R': the existing server duty — lock the case row first — then the work.
      const rCase = gate();
      const R2 = inTx(runtime, W.biz, async (tx) => { await lockCase(tx, ew.caseId, "FOR UPDATE"); rCase.open(); await sleep(300); await lockWork(tx, ew.workId, "FOR NO KEY UPDATE"); return "R"; });
      const S2 = inTx(runtime, W.biz, async (tx) => { await rCase.p; await lockCase(tx, ew.caseId, "FOR UPDATE"); await lockWork(tx, ew.workId, "FOR SHARE"); return "S"; });
      const [r2, s2] = await Promise.all([R2, S2]);
      ok("B7 with the case locked first by both (SERVICE_COMMAND_SERVER_DUTIES: \"lock the case row … before evaluating\"): they serialise, no deadlock",
        r2 === "R" && s2 === "S", `${r2} | ${s2}`);
    }
  }

  // ── C. the cancel gap ──────────────────────────────────────────────────────────────────────────────────────
  console.log("C. CLOSED / CANCELLED / cancel request on 1.2a, and what M2 must not read into them");
  const C = await business("sdp-cancel");
  const field = await inTx(runtime, C.biz, async (tx) => {
    const id = await openCaseTx(tx, C, "FIELD");
    await caseMoveTx(tx, C.biz, id, `status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now()`, "CANCEL", "case.cancelled", "OPEN", "CANCELLED", "CANCELLED");
    return id;
  });
  ok("C1 the database accepts a FIELD case going straight to CANCELLED (terminal) — the documented gap: nothing about parts is implied", succeeded(field), String(field));
  const held = await inTx(runtime, C.biz, async (tx) => {
    const id = await openCaseTx(tx, C, "IN_SHOP");
    await caseMoveTx(tx, C.biz, id, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'הלקוח ויתר'`, "CANCEL", "case.cancelled", "OPEN", "READY", "CANCELLED");
    return id;
  });
  ok("C2 a held item's cancel is READY + outcome CANCELLED — not CLOSED; the close comes later through DELIVERED (where M2's guard acts)", succeeded(held), String(held));
  const st = rows(await q(owner, null, `SELECT status::text s FROM "ServiceCase" WHERE id = ANY($1::int[]) ORDER BY id`, [field, held].filter((x) => typeof x === "number")));
  ok("C3 neither cancel produced CLOSED (M2's close guard fires only on CLOSED, so it never blocks a cancel request)", st.length === 2 && st.every((r) => r.s !== "CLOSED"), JSON.stringify(st));
  if (!m2Here) {
    later("C4 a CANCELLED case with an ISSUED part is reported unresolved by the parts query (and CANCELLED is not read as 'parts handled')", "needs ServicePart (M2)");
    later("C5 CLOSE of a DELIVERED case with an open part is refused at COMMIT; a cancel request (case at a supplier) with an open part is not", "needs ServicePart (M2)");
  } else {
    const addPart = async (tx: Tx, caseId: number) => {
      const p = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "lastEventKind", "updatedAt")
        VALUES ($1, $2, 'NON_STOCK', 'NEEDED', 'בורג', 1, 'ADDED', now()) RETURNING id`, C.biz, caseId)) as Rows)[0].id);
      await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, payload, "idempotencyKey")
        VALUES ($1, $2, $3, 1, 'ADDED', 'NEEDED', 1, 'SYSTEM', '{}', $4)`, C.biz, p, caseId, ikey());
      return p;
    };
    const markOrdered = async (tx: Tx, p: number, caseId: number) => {
      await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'ON_ORDER', "lastEventKind" = 'ORDER_LINKED', version = version + 1, "updatedAt" = now() WHERE id = $1`, p);
      await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, payload, "idempotencyKey")
        VALUES ($1, $2, $3, 2, 'ORDER_LINKED', 'NEEDED', 'ON_ORDER', 1, 'SYSTEM', '{}', $4)`, C.biz, p, caseId, ikey());
    };
    // C4: a FIELD case with an open (ON_ORDER) part goes straight to CANCELLED — allowed (the guard acts on CLOSED only); the
    // unresolved-parts query still reports it: CANCELLED never means "parts handled".
    const c4 = await inTx(runtime, C.biz, async (tx) => {
      const id = await openCaseTx(tx, C, "FIELD"); const p = await addPart(tx, id); await markOrdered(tx, p, id);
      await caseMoveTx(tx, C.biz, id, `status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now()`, "CANCEL", "case.cancelled", "OPEN", "CANCELLED", "CANCELLED");
      return id;
    });
    const unresolved = num(await q(runtime, C.biz, `SELECT count(*)::int AS n FROM "ServicePart" p JOIN "ServiceCase" c ON c.id = p."caseId"
      WHERE c.id = $1 AND c.status = 'CANCELLED' AND p.state IN ('NEEDED','ON_ORDER','RESERVED','ISSUED')`, c4));
    ok("C4 a CANCELLED case with an open part is accepted and the parts query reports it unresolved (CANCELLED is not read as 'parts handled')",
      succeeded(c4) && unresolved === 1, `${c4} unresolved=${unresolved}`);
    // C5: a DELIVERED case with an open part — the CLOSE is refused at COMMIT.
    const delivered = await inTx(runtime, C.biz, async (tx) => {
      const id = await openCaseTx(tx, C, "IN_SHOP"); await addPart(tx, id);
      await caseMoveTx(tx, C.biz, id, `status = 'READY', outcome = 'REPAIRED', "readyAt" = now()`, "FINISH_REPAIR", "repair.finished", "OPEN", "READY", "REPAIRED");
      await caseMoveTx(tx, C.biz, id, `status = 'DELIVERED', "deliveredAt" = now()`, "DELIVER", "case.delivered", "READY", "DELIVERED", "REPAIRED");
      return id;
    });
    // The cancel request exists only on a case at a supplier (1.2a CHECK cancel_request_only_external): with an open part it passes.
    const ext = (await externalWork(C)) as { caseId: number; workId: number } | string;
    const request = typeof ext === "string" ? ext : await inTx(runtime, C.biz, async (tx) => {
      await addPart(tx, ext.caseId);
      const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET "cancellationRequested" = true, "cancelReason" = 'הלקוח ביקש לבטל', "cancelledAt" = now(), version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, ext.caseId)) as Rows)[0].version);
      await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
        VALUES ($1, $2, $3, 'case.cancellation_requested', 'CANCEL', 'EXTERNAL', 'EXTERNAL', false, true, 'SYSTEM', '{"reasonRecorded":true,"itemAtSupplier":true}', $4)`, C.biz, ext.caseId, v, ikey());
    });
    const close = typeof delivered !== "number" ? delivered : await inTx(runtime, C.biz, (tx) =>
      caseMoveTx(tx, C.biz, delivered, `status = 'CLOSED', "closedAt" = now()`, "CLOSE", "case.closed", "DELIVERED", "CLOSED", "REPAIRED"));
    ok("C5 CLOSE of a DELIVERED case with an open part is refused at COMMIT (SERVICE_CASE_PARTS_OPEN); a cancel request (case at a supplier) with an open part is not",
      succeeded(delivered) && succeeded(request) && typeof close === "string" && /SERVICE_CASE_PARTS_OPEN/.test(close), `${delivered} | ${request} | ${close}`);
  }

  // ── D. M0, reproduced in SQL ───────────────────────────────────────────────────────────────────────────────
  console.log("D. M0 (inventory) — the createMovement read-modify-write, reproduced in SQL; no inventory code touched");
  const I = await business("sdp-inventory");
  const item = async (qty: number) => num(await q(runtime, I.biz, `INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך iPhone 14', 'UNIT', $2, now()) RETURNING id AS n`, I.biz, qty));
  {
    const id = await item(5);
    const aRead = gate(), bRead = gate(), aDone = gate();
    const A = inTx(runtime, I.biz, async (tx) => {
      const qn = Number(((await tx.$queryRawUnsafe(`SELECT "currentQuantity" q FROM "InventoryItem" WHERE id = $1`, id)) as Rows)[0].q);
      aRead.open(); await bRead.p;
      await tx.$executeRawUnsafe(`UPDATE "InventoryItem" SET "currentQuantity" = $2 WHERE id = $1`, id, qn - 1);
      return qn;
    });
    const Bx = inTx(runtime, I.biz, async (tx) => {
      await aRead.p;
      const qn = Number(((await tx.$queryRawUnsafe(`SELECT "currentQuantity" q FROM "InventoryItem" WHERE id = $1`, id)) as Rows)[0].q);
      bRead.open(); await aDone.p;
      await tx.$executeRawUnsafe(`UPDATE "InventoryItem" SET "currentQuantity" = $2 WHERE id = $1`, id, qn - 2);
      return qn;
    });
    await A; aDone.open(); await Bx;
    const final = num(await q(runtime, I.biz, `SELECT "currentQuantity" AS n FROM "InventoryItem" WHERE id = $1`, id));
    ok("D1 BUG REPRODUCED: two concurrent read-modify-write movements (−1, −2) on 5 end at 3, not 2 — one update is lost (M0 must fix)", final === 3, `final ${final}`);
  }
  {
    const id = await item(1);
    const neg = await q(runtime, I.biz, `UPDATE "InventoryItem" SET "currentQuantity" = -1 WHERE id = $1 RETURNING "currentQuantity" AS n`, id);
    ok("D2 BUG REPRODUCED: nothing in the database refuses a negative currentQuantity (M0 must add the CHECK)", num(neg) === -1, String(neg));
  }
  {
    // The contract's recommended shape — an atomic conditional update — under the same concurrency.
    const id = await item(5);
    const step = (d: number) => inTx(runtime, I.biz, (tx) => tx.$queryRawUnsafe(`UPDATE "InventoryItem" SET "currentQuantity" = "currentQuantity" + $2
      WHERE id = $1 AND "currentQuantity" + $2 >= 0 RETURNING "currentQuantity" - $2 AS before, "currentQuantity" AS after`, id, d) as Promise<Rows>);
    const res = await Promise.all(Array.from({ length: 20 }, () => step(-1)));
    const won = res.filter((r) => rows(r).length === 1).length;
    const final = num(await q(runtime, I.biz, `SELECT "currentQuantity" AS n FROM "InventoryItem" WHERE id = $1`, id));
    const befores = res.flatMap((r) => rows(r).map((x) => Number(x.before))).sort((a, b) => b - a);
    ok("D3 the contract's atomic conditional update: 20 concurrent −1 on 5 → exactly 5 succeed, final 0, never negative", won === 5 && final === 0, `won ${won} final ${final}`);
    ok("D4 …and each success saw a distinct before-quantity (5,4,3,2,1) — the movement's before/after would be exact", JSON.stringify(befores) === JSON.stringify([5, 4, 3, 2, 1]), JSON.stringify(befores));
  }
  {
    const other = await business("sdp-inventory-b");
    const id = await item(5);
    const cross = await q(runtime, other.biz, `UPDATE "InventoryItem" SET "currentQuantity" = 0 WHERE id = $1 RETURNING id AS n`, id);
    ok("D5 under the Production RLS another business cannot touch the item (0 rows)", rows(cross).length === 0, String(cross));
  }

  console.log(`\n${pass} passed, ${failures.length} failed, ${info} info, ${pending} pending (pending = needs the M2 tables; not a pass)`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
