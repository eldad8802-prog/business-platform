/**
 * Service Desk 1.2c / M2 — the migration battery, READY TO RUN, NOT YET RUN: the M2 migration does not exist.
 *
 * Every check is written against the approved M2 design (Claude Doc "Service Desk 1.2c — תכנון M2", §1–§11 and the
 * owner decisions M2‑1 … M2‑3; M2‑4 not approved) and the M1 core contracts (lib/services/service-desk/parts.*).
 * While "ServicePart" / "ServicePartEvent" are absent the battery prints every check as PENDING and exits 0 — a
 * PENDING is never a pass. With the tables present it runs them AS the real roles and fails on any FAIL.
 *
 * Design facts the checks pin (the M2 migration must match them, or this file changes with it):
 *   - tables "ServicePart", "ServicePartEvent"; RLS enabled + forced; policies SELECT/INSERT/UPDATE (part) and
 *     SELECT/INSERT (journal); no DELETE, no ALL; app_runtime arw / ar;
 *   - UNIQUE issueMovementId, returnMovementId; UNIQUE (businessId, partId, seq); UNIQUE (businessId, idempotencyKey);
 *   - composite FKs to ServiceCase, ServiceDevice, InventoryItem(id, businessId), InventoryMovement(id, businessId),
 *     ServiceQuote(businessId, caseId, version), ServiceExternalWork, ServicePart (split parent);
 *   - order links validated by a trigger under PurchaseOrder RLS (error SERVICE_PART_ORDER_INVALID);
 *   - part triggers lock the case row FOR UPDATE (NOT FOR SHARE — .sdp/locks.ts B4 proves FOR SHARE deadlocks with
 *     1.2b's FOR UPDATE triggers);
 *   - deferred guards: no silent change (ServicePart_has_event), close with open parts (SERVICE_CASE_PARTS_OPEN, M2‑2),
 *     supplier return with an ISSUED part of that work (SERVICE_EXTERNAL_PARTS_UNRESOLVED, M2‑1), split reconciliation;
 *   - erasure service_parts_erase_business(): name + sku of parts without an inventory item, reason, note, users,
 *     digests (M2‑3); the only SECURITY DEFINER.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. Raw SQL only.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=24&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

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
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const succeeded = (r: unknown) => typeof r !== "string";
const UNIQUE = /unique constraint|duplicate key|23505/i, FK = /foreign key|23503/i, CHECK = /check constraint|23514/i;
const DENIED = /permission denied|row-level security/i;
let keySeq = 0;
const ikey = () => `sdp-m2-key-${String(++keySeq).padStart(6, "0")}`;

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────────────
const one = async (sql: string, ...a: unknown[]) => num(await q(owner, null, sql, ...a), "id");
async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz);
  const user = await one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `${name}@lab.invalid`, biz);
  const supplier = await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה', now()) RETURNING id`, biz);
  const item = await one(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך iPhone 14', 'UNIT', 10, now()) RETURNING id`, biz);
  return { biz, cust, user, supplier, item };
}
type B = Awaited<ReturnType<typeof business>>;
async function openCaseTx(tx: Tx, b: B) {
  const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
    ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1 RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
    VALUES ($1, $2, 'IN_SHOP', $3, 'מסך', now()) RETURNING id`, b.biz, n, b.cust)) as Rows)[0].id);
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
/** A part line with its first event (ADDED), as one transaction would write it. */
async function addPartTx(tx: Tx, b: B, caseId: number, o: { source?: string; itemId?: number | null; name?: string; qty?: number } = {}) {
  const source = o.source ?? "STOCK";
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", quantity, "unitType", "lastEventKind", "createdByUserId", "updatedAt")
    VALUES ($1, $2, $3::"ServicePartSource", 'NEEDED', $4, $5, $6, 'UNIT', 'ADDED', $7, now()) RETURNING id`,
    b.biz, caseId, source, source === "STOCK" ? (o.itemId ?? b.item) : null, o.name ?? "מסך iPhone 14", o.qty ?? 1, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'ADDED', NULL, 'NEEDED', $4, 'OWNER_USER', $5, '{}', $6)`, b.biz, id, caseId, o.qty ?? 1, b.user, ikey());
  return id;
}
async function movePartTx(tx: Tx, b: B, partId: number, caseId: number, kind: string, from: string, to: string, set = "", movementId: number | null = null) {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServicePart" SET state = $2::"ServicePartState", "lastEventKind" = $3::"ServicePartEventKind", version = version + 1, "updatedAt" = now()${set ? ", " + set : ""}
    WHERE id = $1 RETURNING version`, partId, to, kind)) as Rows)[0].version);
  const qty = Number(((await tx.$queryRawUnsafe(`SELECT quantity FROM "ServicePart" WHERE id = $1`, partId)) as Rows)[0].quantity);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "movementId", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServicePartEventKind", $6::"ServicePartState", $7::"ServicePartState", $8, $9, 'OWNER_USER', $10, '{}', $11)`,
    b.biz, partId, caseId, v, kind, from, to, qty, movementId, b.user, ikey());
}
async function movementTx(tx: Tx, b: B, delta: number, reason: string, type: string) {
  return Number(((await tx.$queryRawUnsafe(`INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", reason, "quantityDelta", "quantityBefore", "quantityAfter")
    VALUES ($1, $2, $3::"InventoryMovementType", $4::"InventoryMovementReason", $5, 10, 10 + $5) RETURNING id`, b.biz, b.item, type, reason, delta)) as Rows)[0].id);
}

// ── the battery ────────────────────────────────────────────────────────────────────────────────────────────
type Check = { id: string; title: string; run: (ctx: Ctx) => Promise<boolean | [boolean, string]> };
type Ctx = { A: B; Bz: B };
const checks: Check[] = [];
const def = (id: string, title: string, run: Check["run"]) => checks.push({ id, title, run });

// 1. structure
def("1.1", "two tables, RLS enabled + forced", async () =>
  num(await q(owner, null, `SELECT count(*)::int n FROM pg_class WHERE relname IN ('ServicePart','ServicePartEvent') AND relrowsecurity AND relforcerowsecurity`)) === 2);
def("1.2", "five per-operation policies, none for DELETE or ALL", async () => {
  const r = rows(await q(owner, null, `SELECT p.polcmd::text c FROM pg_policy p JOIN pg_class t ON t.oid = p.polrelid WHERE t.relname IN ('ServicePart','ServicePartEvent')`));
  return r.length === 5 && r.every((x) => x.c !== "d" && x.c !== "*");
});
def("1.3", "app_runtime: arw on ServicePart, exactly ar on the journal", async () =>
  num(await q(owner, null, `SELECT count(*)::int n FROM pg_class WHERE (relname = 'ServicePart' AND relacl::text LIKE '%app_runtime=arw/%') OR (relname = 'ServicePartEvent' AND relacl::text LIKE '%app_runtime=ar/%')`)) === 2);
def("1.4", "UNIQUE issueMovementId and returnMovementId", async () =>
  num(await q(owner, null, `SELECT count(*)::int n FROM pg_indexes WHERE tablename = 'ServicePart' AND indexdef LIKE '%UNIQUE%' AND (indexdef LIKE '%"issueMovementId"%' OR indexdef LIKE '%"returnMovementId"%')`)) === 2);
def("1.5", "the only SECURITY DEFINER is service_parts_erase_business, search_path ends in pg_temp, not PUBLIC", async () => {
  const r = rows(await q(owner, null, `SELECT proname, prosecdef, array_to_string(proconfig, ',') cfg, has_function_privilege('public', oid, 'EXECUTE') pub FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND (proname LIKE 'service_part%' OR proname LIKE 'service_case_parts%' OR proname LIKE 'service_external_parts%')`));
  return r.length > 0 && r.every((x) => String(x.cfg).endsWith("pg_temp") && !x.pub) && r.filter((x) => x.prosecdef).map((x) => x.proname).join() === "service_parts_erase_business";
});
def("1.6", "the part triggers lock the case FOR UPDATE and never FOR SHARE (locks.ts B4)", async () =>
  num(await q(owner, null, `SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'service_part%' AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR (SHARE|KEY SHARE)'`)) === 0
  && num(await q(owner, null, `SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'service_part%' AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR UPDATE'`)) >= 1);

// 2. isolation
def("2.1", "business B cannot read business A's part lines", async ({ A, Bz }) => {
  const c = await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A)) as number;
  await inTx(runtime, A.biz, (tx) => addPartTx(tx, A, c));
  return num(await q(runtime, Bz.biz, `SELECT count(*)::int n FROM "ServicePart" WHERE "businessId" = $1`, A.biz)) === 0;
});
def("2.2", "a part of business B cannot reference A's case, item or movement (composite FK / RLS)", async ({ A, Bz }) => {
  const c = await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A)) as number;
  const r1 = await inTx(runtime, Bz.biz, (tx) => addPartTx(tx, Bz, c));
  const cB = await inTx(runtime, Bz.biz, (tx) => openCaseTx(tx, Bz)) as number;
  const r2 = await inTx(runtime, Bz.biz, (tx) => addPartTx(tx, Bz, cB, { itemId: A.item }));
  return [refused(r1, new RegExp(`${FK.source}|${DENIED.source}|SERVICE_PART`, "i")) && refused(r2, new RegExp(`${FK.source}|${DENIED.source}`, "i")), `${r1} | ${r2}`];
});
def("2.3", "no tenant context: nothing visible, nothing writable", async ({ A }) => {
  const r = await q(runtime, null, `SELECT count(*)::int n FROM "ServicePart"`);
  return num(r) === 0 && refused(await inTx(runtime, null, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "lastEventKind", "updatedAt") VALUES ($1, 1, 'NON_STOCK', 'NEEDED', 'x', 1, 'ADDED', now())`, A.biz)), DENIED);
});
def("2.4", "an order link to another business's purchase order is refused (trigger under PurchaseOrder RLS)", async ({ A, Bz }) => {
  const po = await one(`INSERT INTO "PurchaseOrder" ("businessId", status, "updatedAt") VALUES ($1, 'CONFIRMED', now()) RETURNING id`, Bz.biz);
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
    await movePartTx(tx, A, p, c, "ORDER_LINKED", "NEEDED", "ON_ORDER", `"purchaseOrderId" = ${po}`);
  });
  return [refused(r, /SERVICE_PART_ORDER_INVALID/), String(r)];
});
def("2.5", "DELETE and TRUNCATE are refused to the runtime", async ({ A }) =>
  refused(await q(runtime, A.biz, `DELETE FROM "ServicePart"`), DENIED) && refused(await q(runtime, A.biz, `TRUNCATE "ServicePartEvent"`), DENIED));

// 3. journal + no silent change + idempotency
def("3.1", "a part change without its event fails at COMMIT (no silent change)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'RESERVED', "lastEventKind" = 'RESERVED', version = version + 1 WHERE id = $1`, p);
  });
  return typeof r === "string";
});
def("3.2", "the journal is append-only (UPDATE / DELETE refused)", async ({ A }) =>
  refused(await q(runtime, A.biz, `UPDATE "ServicePartEvent" SET payload = '{}'`), /SERVICE_PART|append|denied/i)
  && refused(await q(runtime, A.biz, `DELETE FROM "ServicePartEvent"`), DENIED));
def("3.3", "the same idempotency key twice is refused (one event, one effect)", async ({ A }) => {
  const c = await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A)) as number;
  const p = await inTx(runtime, A.biz, (tx) => addPartTx(tx, A, c)) as number;
  const k = ikey();
  const ins = (seq: number) => inTx(runtime, A.biz, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'RESERVED', "lastEventKind" = 'RESERVED', version = version + 1 WHERE id = $1`, p);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, payload, "idempotencyKey") VALUES ($1, $2, $3, $4, 'RESERVED', 'NEEDED', 'RESERVED', 1, 'OWNER_USER', '{}', $5)`, A.biz, p, c, seq, k);
  });
  return succeeded(await ins(2)) && refused(await ins(3), UNIQUE);
});
def("3.4", "the event payload refuses free text (journal alphabet CHECK)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A);
    const p = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "lastEventKind", "updatedAt") VALUES ($1, $2, 'NON_STOCK', 'NEEDED', 'x', 1, 'ADDED', now()) RETURNING id`, A.biz, c)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, payload, "idempotencyKey") VALUES ($1, $2, $3, 1, 'ADDED', 'NEEDED', 1, 'OWNER_USER', '{"note":"הלקוח דני כהן 050-1234567"}', $4)`, A.biz, p, c, ikey());
  });
  return refused(r, CHECK);
});

// 4. movements, duplicates, split
def("4.1", "one movement cannot be linked to two parts (UNIQUE issueMovementId)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A);
    const m = await movementTx(tx, A, -1, "MANUAL_REMOVE", "OUT");
    for (const _ of [1, 2]) { const p = await addPartTx(tx, A, c); await movePartTx(tx, A, p, c, "ISSUED", "NEEDED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL'`, m); }
  });
  return refused(r, new RegExp(`${UNIQUE.source}|SERVICE_PART`, "i"));
});
def("4.2", "a movement of another item, sign or reason is refused (movement matches part)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
    const m = await movementTx(tx, A, 1, "SUPPLIER_PURCHASE", "IN");
    await movePartTx(tx, A, p, c, "ISSUED", "NEEDED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL'`, m);
  });
  return refused(r, /SERVICE_PART_MOVEMENT/);
});
def("4.3", "a split child must be RETURNED; INSTALLED / WRITTEN_OFF children are refused (M2‑4 not approved)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const parent = await addPartTx(tx, A, c, { qty: 3 });
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", quantity, "unitType", "splitFromPartId", "lastEventKind", "updatedAt")
      VALUES ($1, $2, 'STOCK', 'INSTALLED', $3, 'x', 1, 'UNIT', $4, 'INSTALLED', now())`, A.biz, c, A.item, parent);
  });
  return refused(r, new RegExp(`${CHECK.source}|SERVICE_PART`, "i"));
});
def("4.4", "split quantities must reconcile with the issue movement (3 = 2 + 1 passes, 3 ≠ 1 + 1 fails at COMMIT)", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("4.5", "a cost change without COST_CORRECTED is refused; NONE with a value and an included-in-supplier cost are refused", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);

// 5. M2‑2 close guard and M2‑1 supplier-return guard (incl. races)
def("5.1", "CLOSE with an open part is refused at COMMIT (SERVICE_CASE_PARTS_OPEN); every open state separately", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("5.2", "a cancel request with an ISSUED part is NOT refused (READY + CANCELLED, or cancellationRequested)", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("5.3", "race: close vs add-part in two orders — never a CLOSED case with an open part", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("5.4", "supplier return with an ISSUED part of that work is refused at COMMIT; resolved in the same transaction it passes", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("5.5", "race: part send vs supplier return in two orders — never a RETURNED work with an ISSUED part", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("5.6", "deadlock rule: both sides lock the case first → serialised, no 40P01 (locks.ts B5/B7 on the real guards)", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);

// 6. erasure, atomicity, regression
def("6.1", "erasure (M2‑3): name + sku of parts without an item blanked, item names kept, texts/users/digests null, other business untouched", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("6.2", "a failed transaction (movement written, part update refused) leaves no movement and no part change", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);
def("6.3", "1.2a and 1.2b batteries pass unchanged on the M2 database (run .sdf / .sdx batteries)", async () => [false, "written together with the M2 migration (PR-1) — not implemented yet"]);

async function main() {
  const present = num(await q(owner, null, `SELECT count(*)::int n FROM pg_class WHERE relname IN ('ServicePart','ServicePartEvent') AND relnamespace = 'public'::regnamespace`)) === 2;
  if (!present) {
    console.log("M2 tables are absent (no M2 migration in this database). Every check is PENDING — none of them is a pass.\n");
    for (const c of checks) console.log(`  [PENDING] ${c.id} ${c.title}`);
    console.log(`\n0 passed, 0 failed, ${checks.length} pending`);
    await owner.$disconnect(); await runtime.$disconnect();
    return;
  }
  const ctx: Ctx = { A: await business("sdp-m2-a"), Bz: await business("sdp-m2-b") };
  let pass = 0; const failures: string[] = [];
  for (const c of checks) {
    let res: boolean | [boolean, string];
    try { res = await c.run(ctx); } catch (e) { res = [false, (e as Error).message]; }
    const [okv, detail] = Array.isArray(res) ? res : [res, ""];
    if (okv) { pass++; console.log(`  [PASS] ${c.id} ${c.title}`); } else { failures.push(c.id); console.log(`  [FAIL] ${c.id} ${c.title}${detail ? " — " + detail : ""}`); }
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
