/**
 * Service Desk 1.2c / M2 — migration 20261115090000_service_parts, AS the real roles (.sdp/lab.sh <db> --with-m2).
 *
 * Every check pins the approved M2 design (Claude Doc "Service Desk 1.2c — תכנון M2"; owner decisions M2‑1 … M2‑3,
 * M2‑4 not approved) and the M1 core contracts (lib/services/service-desk/parts.*):
 *   1. Structure: two tables ENABLE + FORCE RLS, five per-operation policies, explicit grants, functions with
 *      search_path … pg_temp last, one SECURITY DEFINER (the erasure), part triggers lock the case FOR UPDATE.
 *   2. Isolation: reads, writes and references across businesses (case, item, movement, order), no tenant context.
 *   3. Journal: no silent change, append-only, idempotency, closed payload.
 *   4. Movements, duplicates, split (ק‑4), costs (ק‑9).
 *   5. M2‑2 close guard and M2‑1 supplier-return guard, with their races, and the deadlock rule.
 *   6. Erasure (M2‑3), atomicity, 1.2a / 1.2b objects unchanged.
 * While "ServicePart" / "ServicePartEvent" are absent every check prints PENDING (never a pass) and the run exits 0.
 * The issue / return checks need the M0 enum value SERVICE_PART: the lab adds it (.sdp/lab.sh --m0-sim) — that
 * simulates the inventory session's M0 in the lab only; nothing here writes inventory code.
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
const DENIED = /permission denied|row-level security/i, DEADLOCK = /40P01|deadlock detected/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }
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
const closeTx = (tx: Tx, b: B, c: number, from = "OPEN") => caseMoveTx(tx, b.biz, c, `status = 'CLOSED', outcome = 'REPAIRED', "closedAt" = now()`, "CLOSE", "case.closed", from, "CLOSED", "REPAIRED");
/** A part line with its first event (ADDED). */
async function addPartTx(tx: Tx, b: B, caseId: number, o: { source?: string; itemId?: number | null; name?: string; sku?: string | null; qty?: number } = {}) {
  const source = o.source ?? "STOCK";
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", "skuSnapshot", quantity, "unitType", "lastEventKind", "createdByUserId", "updatedAt")
    VALUES ($1, $2, $3::"ServicePartSource", 'NEEDED', $4, $5, $6, $7, 'UNIT', 'ADDED', $8, now()) RETURNING id`,
    b.biz, caseId, source, source === "STOCK" ? (o.itemId ?? b.item) : null, o.name ?? "מסך iPhone 14", o.sku ?? null, o.qty ?? 1, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'ADDED', NULL, 'NEEDED', $4, 'OWNER_USER', $5, '{"source":"STOCK"}', $6)`, b.biz, id, caseId, o.qty ?? 1, b.user, ikey());
  return id;
}
/** One change of a part line + its event, as one service step writes them. */
async function movePartTx(tx: Tx, b: B, partId: number, kind: string, to: string, set = "", ev: { movementId?: number | null; amount?: number | null; previous?: number | null; reason?: string | null; key?: string } = {}) {
  const before = String(((await tx.$queryRawUnsafe(`SELECT state::text s FROM "ServicePart" WHERE id = $1`, partId)) as Rows)[0].s);
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServicePart" SET state = $2::"ServicePartState", "lastEventKind" = $3::"ServicePartEventKind", version = version + 1, "updatedAt" = now()${set ? ", " + set : ""}
    WHERE id = $1 RETURNING version, quantity, "caseId"`, partId, to, kind)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "movementId", "amountAgorot", "previousAmountAgorot", reason, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServicePartEventKind", $6::"ServicePartState", $7::"ServicePartState", $8, $9, $10, $11, $12, 'OWNER_USER', $13, '{}', $14)`,
    b.biz, partId, r.caseId, Number(r.version), kind, before, to, Number(r.quantity), ev.movementId ?? null, ev.amount ?? null, ev.previous ?? null, ev.reason ?? null, b.user, ev.key ?? ikey());
  return Number(r.version);
}
async function movementTx(tx: Tx, b: B, delta: number, reason: string, type: string) {
  return Number(((await tx.$queryRawUnsafe(`INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", reason, "quantityDelta", "quantityBefore", "quantityAfter")
    VALUES ($1, $2, $3::"InventoryMovementType", $4::"InventoryMovementReason", $5, 10, 10 + $5) RETURNING id`, b.biz, b.item, type, reason, delta)) as Rows)[0].id);
}
/** NEEDED → ISSUED with its OUT SERVICE_PART movement and a captured cost. */
async function issueTx(tx: Tx, b: B, partId: number, qty: number, cost = 12_050) {
  const m = await movementTx(tx, b, -qty, "SERVICE_PART", "OUT");
  await movePartTx(tx, b, partId, "ISSUED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = ${cost}, "costSource" = 'LAST_PURCHASE'`, { movementId: m });
  return m;
}
/** Partial return: the line keeps `rest`, a child holds `returned` as RETURNED with its IN RETURN movement. */
async function splitTx(tx: Tx, b: B, partId: number, rest: number, returned: number) {
  await movePartTx(tx, b, partId, "SPLIT", "ISSUED", `quantity = ${rest}`);
  const m = await movementTx(tx, b, returned, "RETURN", "IN");
  const p = ((await tx.$queryRawUnsafe(`SELECT "caseId", "inventoryItemId", "unitCostAgorot", "costSource"::text cs, "customerUnitPriceAgorot", "nameSnapshot" FROM "ServicePart" WHERE id = $1`, partId)) as Rows)[0];
  const child = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", quantity, "unitType", "returnMovementId", "splitFromPartId", "unitCostAgorot", "costSource", "customerUnitPriceAgorot", "lastEventKind", "closedAt", "updatedAt")
    VALUES ($1, $2, 'STOCK', 'RETURNED', $3, $4, $5, 'UNIT', $6, $7, $8, $9::"ServicePartCostSource", $10, 'RETURNED', now(), now()) RETURNING id`,
    b.biz, p.caseId, p.inventoryItemId, p.nameSnapshot, returned, m, partId, p.unitCostAgorot, p.cs, p.customerUnitPriceAgorot)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "movementId", actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'RETURNED', 'ISSUED', 'RETURNED', $4, $5, 'OWNER_USER', '{"splitFromParent":true}', $6)`, b.biz, child, p.caseId, returned, m, ikey());
  return child;
}
/** A case at a supplier with its open work (1.2b). */
async function externalTx(tx: Tx, b: B) {
  const c = await openCaseTx(tx, b);
  await caseMoveTx(tx, b.biz, c, `status = 'EXTERNAL'`, "SEND_TO_EXTERNAL", "external.sent", "OPEN", "EXTERNAL");
  const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "updatedAt")
    VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד', now()) RETURNING id`, b.biz, c, b.supplier, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'SENT', 'SENT', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, c, b.user, ikey());
  return { c, w };
}
async function workReturnTx(tx: Tx, b: B, workId: number) {
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServiceExternalWork" SET state = 'RETURNED', "returnedAt" = now(), "returnResult" = 'REPAIRED', version = version + 1, "lastEventKind" = 'RETURNED', "updatedAt" = now()
    WHERE id = $1 RETURNING version, "caseId", "progressStage"::text AS stage`, workId)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, 'RETURNED', $5::"ServiceExternalProgress", 'OWNER_USER', '{}', $6)`, b.biz, workId, r.caseId, Number(r.version), r.stage, ikey());
}
const lockCaseTx = (tx: Tx, c: number) => tx.$queryRawUnsafe(`SELECT 1 FROM "ServiceCase" WHERE id = $1 FOR UPDATE`, c);

// ── the battery ────────────────────────────────────────────────────────────────────────────────────────────
type Check = { id: string; title: string; run: (ctx: Ctx) => Promise<boolean | [boolean, string]> };
type Ctx = { A: B; Bz: B };
const checks: Check[] = [];
const def = (id: string, title: string, run: Check["run"]) => checks.push({ id, title, run });
const OPEN_STATES = ["NEEDED", "ON_ORDER", "RESERVED", "ISSUED"];

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
  return [r.length === 11 && r.every((x) => String(x.cfg).endsWith("pg_temp") && !x.pub) && r.filter((x) => x.prosecdef).map((x) => x.proname).join() === "service_parts_erase_business", JSON.stringify(r.map((x) => x.proname))];
});
def("1.6", "the part triggers lock the case FOR UPDATE and never FOR SHARE (locks.ts B4)", async () =>
  num(await q(owner, null, `SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'service_part%' AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR (SHARE|KEY SHARE)'`)) === 0
  && num(await q(owner, null, `SELECT count(*)::int n FROM pg_proc WHERE proname IN ('service_part_insert_guard','service_part_guard') AND prosrc ~ 'FROM "ServiceCase"[^;]*FOR UPDATE'`)) === 2);

// 2. isolation
def("2.1", "business B cannot read business A's part lines", async ({ A, Bz }) => {
  await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); await addPartTx(tx, A, c); });
  return num(await q(runtime, Bz.biz, `SELECT count(*)::int n FROM "ServicePart" WHERE "businessId" = $1`, A.biz)) === 0
    && num(await q(runtime, A.biz, `SELECT count(*)::int n FROM "ServicePart"`)) >= 1;
});
def("2.2", "a part of business B cannot reference A's case or A's item (insert guard / composite FK)", async ({ A, Bz }) => {
  const c = (await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A))) as number;
  const r1 = await inTx(runtime, Bz.biz, (tx) => addPartTx(tx, Bz, c));
  const r2 = await inTx(runtime, Bz.biz, async (tx) => { const cB = await openCaseTx(tx, Bz); return addPartTx(tx, Bz, cB, { itemId: A.item }); });
  return [refused(r1, /SERVICE_PART_CASE_INVALID|foreign key/i) && refused(r2, FK), `${r1} | ${r2}`];
});
def("2.3", "no tenant context: nothing visible, nothing writable", async ({ A }) => {
  const r = await q(runtime, null, `SELECT count(*)::int n FROM "ServicePart"`);
  const w = await inTx(runtime, null, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, "nameSnapshot", quantity, "updatedAt") VALUES ($1, 1, 'NON_STOCK', 'x', 1, now())`, A.biz));
  return [num(r) === 0 && refused(w, new RegExp(`${DENIED.source}|SERVICE_PART_CASE_INVALID`, "i")), String(w)];
});
def("2.4", "an order link to another business's purchase order is refused (trigger under PurchaseOrder RLS); its own passes", async ({ A, Bz }) => {
  const po = await one(`INSERT INTO "PurchaseOrder" ("businessId", status, "updatedAt") VALUES ($1, 'CONFIRMED', now()) RETURNING id`, Bz.biz);
  const own = await one(`INSERT INTO "PurchaseOrder" ("businessId", status, "updatedAt") VALUES ($1, 'CONFIRMED', now()) RETURNING id`, A.biz);
  const bad = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c); await movePartTx(tx, A, p, "ORDER_LINKED", "ON_ORDER", `"purchaseOrderId" = ${po}`); });
  const good = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c); await movePartTx(tx, A, p, "ORDER_LINKED", "ON_ORDER", `"purchaseOrderId" = ${own}, "expectedOn" = DATE '2026-11-20'`); });
  return [refused(bad, /SERVICE_PART_ORDER_INVALID/) && succeeded(good), `${bad} | ${good}`];
});
def("2.5", "DELETE and TRUNCATE are refused to the runtime", async ({ A }) =>
  refused(await q(runtime, A.biz, `DELETE FROM "ServicePart"`), DENIED) && refused(await q(runtime, A.biz, `TRUNCATE "ServicePartEvent"`), DENIED));

// 3. journal + no silent change + idempotency
def("3.1", "a part change without its event fails at COMMIT (no silent change)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'RESERVED', "lastEventKind" = 'RESERVED', version = version + 1 WHERE id = $1`, p);
  });
  return [refused(r, /SERVICE_PART_SILENT_CHANGE/), String(r)];
});
def("3.2", "the journal is append-only (runtime UPDATE / DELETE denied; even the owner's UPDATE refused)", async ({ A }) =>
  refused(await q(runtime, A.biz, `UPDATE "ServicePartEvent" SET payload = '{}'`), DENIED)
  && refused(await q(runtime, A.biz, `DELETE FROM "ServicePartEvent"`), DENIED)
  && refused(await q(owner, null, `UPDATE "ServicePartEvent" SET payload = '{}'`), /SERVICE_PART_EVENT_APPEND_ONLY/));
def("3.3", "the same idempotency key twice is refused (one event, one effect)", async ({ A }) => {
  const c = (await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A))) as number;
  const p = (await inTx(runtime, A.biz, (tx) => addPartTx(tx, A, c))) as number;
  const k = ikey();
  const first = await inTx(runtime, A.biz, (tx) => movePartTx(tx, A, p, "RESERVED", "RESERVED", "", { key: k }));
  const again = await inTx(runtime, A.biz, (tx) => movePartTx(tx, A, p, "RELEASED", "NEEDED", "", { key: k }));
  const state = rows(await q(owner, null, `SELECT state::text s, version FROM "ServicePart" WHERE id = $1`, p))[0];
  return [succeeded(first) && refused(again, UNIQUE) && state.s === "RESERVED" && Number(state.version) === 2, `${again} ${JSON.stringify(state)}`];
});
def("3.4", "the event payload refuses free text (journal alphabet CHECK)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A);
    const p = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, "nameSnapshot", quantity, "updatedAt") VALUES ($1, $2, 'NON_STOCK', 'בורג', 1, now()) RETURNING id`, A.biz, c)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, payload, "idempotencyKey") VALUES ($1, $2, $3, 1, 'ADDED', 'NEEDED', 1, 'OWNER_USER', '{"note":"הלקוח דני כהן 050-1234567"}', $4)`, A.biz, p, c, ikey());
  });
  return refused(r, CHECK);
});

// 4. movements, duplicates, split, costs
def("4.1", "one movement cannot be linked to two parts (UNIQUE issueMovementId)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A);
    const m = await movementTx(tx, A, -1, "SERVICE_PART", "OUT");
    for (let i = 0; i < 2; i++) { const p = await addPartTx(tx, A, c); await movePartTx(tx, A, p, "ISSUED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL'`, { movementId: m }); }
  });
  return [refused(r, UNIQUE), String(r)];
});
def("4.2", "a movement of another sign / reason / quantity is refused (movement matches part); the right one passes", async ({ A }) => {
  const wrongReason = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
    const m = await movementTx(tx, A, 1, "SUPPLIER_PURCHASE", "IN");
    await movePartTx(tx, A, p, "ISSUED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL'`, { movementId: m });
  });
  const wrongQty = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c, { qty: 2 });
    const m = await movementTx(tx, A, -1, "SERVICE_PART", "OUT");
    await movePartTx(tx, A, p, "ISSUED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL'`, { movementId: m });
  });
  const right = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c, { qty: 2 }); return issueTx(tx, A, p, 2); });
  return [refused(wrongReason, /SERVICE_PART_MOVEMENT_MISMATCH/) && refused(wrongQty, /SERVICE_PART_MOVEMENT_MISMATCH/) && succeeded(right), `${wrongReason} | ${wrongQty} | ${right}`];
});
def("4.3", "a split child must be RETURNED; an INSTALLED child is refused (M2‑4 not approved)", async ({ A }) => {
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const parent = await addPartTx(tx, A, c, { qty: 3 });
    await issueTx(tx, A, parent, 3);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", quantity, "unitType", "splitFromPartId", "unitCostAgorot", "costSource", "lastEventKind", "closedAt", "updatedAt")
      VALUES ($1, $2, 'STOCK', 'INSTALLED', $3, 'מסך iPhone 14', 1, 'UNIT', $4, 12050, 'LAST_PURCHASE', 'INSTALLED', now(), now())`, A.biz, c, A.item, parent);
  });
  return [refused(r, new RegExp(`${CHECK.source}|SERVICE_PART_SPLIT_INVALID`, "i")), String(r)];
});
def("4.4", "split quantities reconcile with the issue movement: 3 = 2 + 1 passes; 3 ≠ 1 + 1 fails at COMMIT; the child cannot be returned again", async ({ A }) => {
  let parentId = 0, childId = 0;
  const good = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); parentId = await addPartTx(tx, A, c, { qty: 3 });
    await issueTx(tx, A, parentId, 3); childId = await splitTx(tx, A, parentId, 2, 1);
  });
  const bad = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c, { qty: 3 });
    await issueTx(tx, A, p, 3); await splitTx(tx, A, p, 1, 1);
  });
  const twice = await inTx(runtime, A.biz, async (tx) => {
    const m = await movementTx(tx, A, 1, "RETURN", "IN");
    await movePartTx(tx, A, childId, "RETURNED", "RETURNED", `"returnMovementId" = ${m}`, { movementId: m });
  });
  const fam = rows(await q(owner, null, `SELECT quantity, state::text s FROM "ServicePart" WHERE id IN ($1, $2) ORDER BY id`, parentId, childId));
  return [succeeded(good) && refused(bad, /SERVICE_PART_SPLIT_UNRECONCILED/) && typeof twice === "string"
    && fam.length === 2 && Number(fam[0].quantity) === 2 && fam[0].s === "ISSUED" && Number(fam[1].quantity) === 1 && fam[1].s === "RETURNED", `${good} | ${bad} | ${twice} | ${JSON.stringify(fam)}`];
});
def("4.5", "costs: a change outside COST_CORRECTED refused; COST_CORRECTED keeps previous + reason; NONE with a value refused; supplier-included with a cost refused", async ({ A }) => {
  let p = 0;
  await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); p = await addPartTx(tx, A, c); await issueTx(tx, A, p, 1); });
  const sneaky = await inTx(runtime, A.biz, (tx) => movePartTx(tx, A, p, "PRICE_SET", "ISSUED", `"unitCostAgorot" = 1, "customerUnitPriceAgorot" = 5`, { amount: 5 }));
  const noReason = await inTx(runtime, A.biz, (tx) => movePartTx(tx, A, p, "COST_CORRECTED", "ISSUED", `"unitCostAgorot" = 11000, "costSource" = 'MANUAL'`, { amount: 11000, previous: 12050 }));
  const corr = await inTx(runtime, A.biz, (tx) => movePartTx(tx, A, p, "COST_CORRECTED", "ISSUED", `"unitCostAgorot" = 11000, "costSource" = 'MANUAL'`, { amount: 11000, previous: 12050, reason: "חשבונית מתוקנת" }));
  const none = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); const x = await addPartTx(tx, A, c); const m = await movementTx(tx, A, -1, "SERVICE_PART", "OUT");
    await movePartTx(tx, A, x, "ISSUED", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 5, "costSource" = 'NONE'`, { movementId: m }); });
  const sup = await inTx(runtime, A.biz, async (tx) => { const e = await externalTx(tx, A);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "externalWorkId", "costIncludedInExternal", "unitCostAgorot", "lastEventKind", "closedAt", "updatedAt")
      VALUES ($1, $2, 'SUPPLIER', 'INSTALLED', 'סוללה', 1, $3, true, 700, 'SUPPLIER_PART_RECORDED', now(), now())`, A.biz, e.c, e.w); });
  const ev = rows(await q(owner, null, `SELECT "amountAgorot" a, "previousAmountAgorot" p, reason FROM "ServicePartEvent" WHERE "partId" = $1 AND kind = 'COST_CORRECTED'`, p));
  return [refused(sneaky, /SERVICE_PART_CHANGE_NOT_KIND/) && refused(noReason, CHECK) && succeeded(corr) && refused(none, CHECK) && refused(sup, CHECK)
    && ev.length === 1 && Number(ev[0].a) === 11000 && Number(ev[0].p) === 12050 && ev[0].reason === "חשבונית מתוקנת", `${sneaky} | ${noReason} | ${corr} | ${none} | ${sup}`];
});

// 5. M2‑2 close guard and M2‑1 supplier-return guard, races, deadlock rule
def("5.1", "CLOSE with an open part is refused at COMMIT (SERVICE_CASE_PARTS_OPEN), for each open state; with every part resolved it passes", async ({ A }) => {
  const results: string[] = [];
  for (const st of OPEN_STATES) {
    const r = await inTx(runtime, A.biz, async (tx) => {
      const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c);
      if (st === "ON_ORDER") await movePartTx(tx, A, p, "ORDER_LINKED", "ON_ORDER");
      if (st === "RESERVED") await movePartTx(tx, A, p, "RESERVED", "RESERVED");
      if (st === "ISSUED") await issueTx(tx, A, p, 1);
      await closeTx(tx, A, c);
    });
    results.push(refused(r, /SERVICE_CASE_PARTS_OPEN/) ? "refused" : `NOT refused (${String(r).slice(0, 80)})`);
  }
  const ok = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c); await issueTx(tx, A, p, 1);
    await movePartTx(tx, A, p, "INSTALLED", "INSTALLED", `"closedAt" = now()`);
    const q2 = await addPartTx(tx, A, c); await movePartTx(tx, A, q2, "CANCELLED", "CANCELLED", `"closedAt" = now()`);
    await closeTx(tx, A, c);
  });
  return [results.every((x) => x === "refused") && succeeded(ok), `${results.join(",")} | ${ok}`];
});
def("5.2", "a cancel request with an ISSUED part is NOT refused (READY + CANCELLED); resolving the part afterwards works", async ({ A }) => {
  let p = 0;
  const r = await inTx(runtime, A.biz, async (tx) => {
    const c = await openCaseTx(tx, A); p = await addPartTx(tx, A, c); await issueTx(tx, A, p, 1);
    await caseMoveTx(tx, A.biz, c, `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'הלקוח ויתר'`, "CANCEL", "case.cancelled", "OPEN", "READY", "CANCELLED");
  });
  const resolve = await inTx(runtime, A.biz, async (tx) => { const m = await movementTx(tx, A, 1, "RETURN", "IN"); await movePartTx(tx, A, p, "RETURNED", "RETURNED", `"returnMovementId" = ${m}, "closedAt" = now()`, { movementId: m }); });
  return [succeeded(r) && succeeded(resolve), `${r} | ${resolve}`];
});
def("5.3", "race: close vs add-part in both orders — never a CLOSED case with an open part", async ({ A }) => {
  const outcomes: string[] = [];
  for (const closeFirst of [true, false]) {
    const c = (await inTx(runtime, A.biz, (tx) => openCaseTx(tx, A))) as number;
    const firstHeld = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { if (closeFirst) { await closeTx(tx, A, c); firstHeld.open(); await sleep(400); } else { await firstHeld.p; await closeTx(tx, A, c); } return 1; });
    const T2 = inTx(runtime, A.biz, async (tx) => { if (!closeFirst) { await addPartTx(tx, A, c); firstHeld.open(); await sleep(400); } else { await firstHeld.p; await addPartTx(tx, A, c); } return 2; });
    const [r1, r2] = await Promise.all([T1, T2]);
    const bad = num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceCase" sc WHERE sc.id = $1 AND sc.status = 'CLOSED'
      AND EXISTS (SELECT 1 FROM "ServicePart" p WHERE p."caseId" = sc.id AND p.state IN ('NEEDED','ON_ORDER','RESERVED','ISSUED'))`, c));
    outcomes.push(`${closeFirst ? "close-first" : "add-first"}: ${succeeded(r1) ? "close ok" : "close refused"} / ${succeeded(r2) ? "add ok" : "add refused"} / inconsistent=${bad}`);
    if (bad !== 0 || (succeeded(r1) && succeeded(r2)) || [r1, r2].some((r) => typeof r === "string" && DEADLOCK.test(r))) return [false, outcomes.join(" ; ")];
  }
  return [true, outcomes.join(" ; ")];
});
def("5.4", "supplier return with an ISSUED part of that work is refused at COMMIT; resolving it in the same transaction passes", async ({ A }) => {
  let e = { c: 0, w: 0 }, p = 0;
  await inTx(runtime, A.biz, async (tx) => { e = await externalTx(tx, A); p = await addPartTx(tx, A, e.c); const m = await movementTx(tx, A, -1, "SERVICE_PART", "OUT");
    await movePartTx(tx, A, p, "SENT_WITH_EXTERNAL", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL', "externalWorkId" = ${e.w}`, { movementId: m }); });
  const blocked = await inTx(runtime, A.biz, async (tx) => { await lockCaseTx(tx, e.c); await workReturnTx(tx, A, e.w); });
  const resolved = await inTx(runtime, A.biz, async (tx) => { await lockCaseTx(tx, e.c); await workReturnTx(tx, A, e.w);
    await movePartTx(tx, A, p, "BACK_FROM_EXTERNAL", "INSTALLED", `"closedAt" = now()`); });
  return [refused(blocked, /SERVICE_EXTERNAL_PARTS_UNRESOLVED/) && succeeded(resolved), `${blocked} | ${resolved}`];
});
def("5.5", "race: part send vs supplier return (both lock the case first) in both orders — never a RETURNED work with an ISSUED part, no deadlock", async ({ A }) => {
  const outcomes: string[] = [];
  for (const sendFirst of [true, false]) {
    let e = { c: 0, w: 0 }, p = 0;
    await inTx(runtime, A.biz, async (tx) => { e = await externalTx(tx, A); p = await addPartTx(tx, A, e.c); });
    const firstHeld = gate();
    const send = (tx: Tx) => movementTx(tx, A, -1, "SERVICE_PART", "OUT").then((m) =>
      movePartTx(tx, A, p, "SENT_WITH_EXTERNAL", "ISSUED", `"issueMovementId" = ${m}, "unitCostAgorot" = 100, "costSource" = 'MANUAL', "externalWorkId" = ${e.w}`, { movementId: m }));
    const S = inTx(runtime, A.biz, async (tx) => { if (!sendFirst) await firstHeld.p; await lockCaseTx(tx, e.c); await send(tx); if (sendFirst) { firstHeld.open(); await sleep(400); } return 1; });
    const R = inTx(runtime, A.biz, async (tx) => { if (sendFirst) await firstHeld.p; await lockCaseTx(tx, e.c); await workReturnTx(tx, A, e.w); if (!sendFirst) { firstHeld.open(); await sleep(400); } return 2; });
    const [rs, rr] = await Promise.all([S, R]);
    const bad = num(await q(owner, null, `SELECT count(*)::int n FROM "ServiceExternalWork" w WHERE w.id = $1 AND w.state = 'RETURNED'
      AND EXISTS (SELECT 1 FROM "ServicePart" p WHERE p."externalWorkId" = w.id AND p.state = 'ISSUED')`, e.w));
    outcomes.push(`${sendFirst ? "send-first" : "return-first"}: send ${succeeded(rs) ? "ok" : "refused"} / return ${succeeded(rr) ? "ok" : "refused"} / inconsistent=${bad}`);
    if (bad !== 0 || (succeeded(rs) && succeeded(rr)) || [rs, rr].some((r) => typeof r === "string" && DEADLOCK.test(r))) return [false, outcomes.join(" ; ")];
  }
  return [true, outcomes.join(" ; ")];
});
def("5.6", "deadlock rule on the real guards: concurrent part writes + a 1.2b handover on one case serialise (no 40P01)", async ({ A }) => {
  const c = (await inTx(runtime, A.biz, async (tx) => { const id = await openCaseTx(tx, A); await caseMoveTx(tx, A.biz, id, `status = 'READY', outcome = 'REPAIRED'`, "FINISH_REPAIR", "repair.finished", "OPEN", "READY", "REPAIRED"); return id; })) as number;
  const jobs = [
    inTx(runtime, A.biz, async (tx) => { const p = await addPartTx(tx, A, c); await sleep(150); await movePartTx(tx, A, p, "RESERVED", "RESERVED"); return 1; }),
    inTx(runtime, A.biz, async (tx) => { const p = await addPartTx(tx, A, c); await sleep(150); await movePartTx(tx, A, p, "CANCELLED", "CANCELLED", `"closedAt" = now()`); return 2; }),
    inTx(runtime, A.biz, async (tx) => { await sleep(50); await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "openBalanceAgorot") VALUES ($1, $2, 'דנה', true, 0)`, A.biz, c); return 3; }),
  ];
  const res = await Promise.all(jobs);
  return [res.every((r) => typeof r !== "string" || !DEADLOCK.test(r)) && succeeded(res[0]) && succeeded(res[1]), res.map(String).join(" | ")];
});

// 6. erasure, atomicity, regression objects
def("6.1", "erasure (M2‑3): hand-typed name + sku blanked, item names kept, texts / users / digests null; refused when not deleting / no context; other business untouched", async ({ A }) => {
  const E = await business("sdp-m2-erase");
  let ns = 0, st = 0, sp = 0;
  const setup = await inTx(runtime, E.biz, async (tx) => {
    const c = await openCaseTx(tx, E);
    ns = await addPartTx(tx, E, c, { source: "NON_STOCK", name: "בורג של דני כהן", sku: "DANI-050" });
    st = await addPartTx(tx, E, c, { sku: "SCR-IP14" });
    await movePartTx(tx, E, st, "CANCELLED", "CANCELLED", `reason = 'הלקוח דני ויתר', "closedAt" = now()`, { reason: "הלקוח דני ויתר" });
    const e = await externalTx(tx, E);
    sp = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "externalWorkId", "costIncludedInExternal", "lastEventKind", "closedAt", "updatedAt")
      VALUES ($1, $2, 'SUPPLIER', 'INSTALLED', 'סוללה מהספק של דני', 1, $3, true, 'SUPPLIER_PART_RECORDED', now(), now()) RETURNING id`, E.biz, e.c, e.w)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey") VALUES ($1, $2, $3, 1, 'SUPPLIER_PART_RECORDED', 'INSTALLED', 1, 'OWNER_USER', $4, '{}', $5)`, E.biz, sp, e.c, E.user, ikey());
  });
  const aSnap = JSON.stringify(rows(await q(owner, null, `SELECT row_to_json(p) j FROM "ServicePart" p WHERE "businessId" = $1 ORDER BY id`, A.biz)));
  const notDeleting = await q(runtime, E.biz, `SELECT public.service_parts_erase_business() AS n`);
  const noCtx = await q(runtime, null, `SELECT public.service_parts_erase_business() AS n`);
  await q(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.biz);
  const n = num(await q(runtime, E.biz, `SELECT public.service_parts_erase_business() AS n`));
  const parts = rows(await q(owner, null, `SELECT id, "nameSnapshot" nm, "skuSnapshot" sku, reason, note, "createdByUserId" u, "erasedAt" e FROM "ServicePart" WHERE "businessId" = $1 ORDER BY id`, E.biz));
  const byId = (id: number) => parts.find((x) => Number(x.id) === id) ?? {};
  const evLeft = num(await q(owner, null, `SELECT count(*)::int n FROM "ServicePartEvent" WHERE "businessId" = $1 AND ("actorUserId" IS NOT NULL OR reason IS NOT NULL OR "erasedAt" IS NULL)`, E.biz));
  const again = num(await q(runtime, E.biz, `SELECT public.service_parts_erase_business() AS n`));
  const aAfter = JSON.stringify(rows(await q(owner, null, `SELECT row_to_json(p) j FROM "ServicePart" p WHERE "businessId" = $1 ORDER BY id`, A.biz)));
  const okv = succeeded(setup) && refused(notDeleting, /SERVICE_PARTS_ERASURE_NOT_DELETING/) && refused(noCtx, /SERVICE_PARTS_ERASURE_NO_CONTEXT/) && n > 0
    && byId(ns).nm === "חלק שנמחק" && byId(ns).sku === null && byId(sp).nm === "חלק שנמחק"
    && byId(st).nm === "מסך iPhone 14" && byId(st).sku === "SCR-IP14" && byId(st).reason === null
    && parts.every((x) => x.u === null && x.note === null && x.e !== null) && evLeft === 0 && again === 0 && aSnap === aAfter;
  return [okv, `setup=${setup} n=${n} again=${again} evLeft=${evLeft} ${JSON.stringify(parts)}`];
});
def("6.2", "a failed transaction (movement written, event mismatched) leaves no movement and no part change", async ({ A }) => {
  let p = 0;
  await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); p = await addPartTx(tx, A, c); });
  const before = num(await q(runtime, A.biz, `SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, A.item));
  const r = await inTx(runtime, A.biz, async (tx) => {
    const m = await movementTx(tx, A, -1, "SERVICE_PART", "OUT");
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'ISSUED', "lastEventKind" = 'ISSUED', version = version + 1, "issueMovementId" = $2, "unitCostAgorot" = 1, "costSource" = 'MANUAL' WHERE id = $1`, p, m);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, payload, "idempotencyKey")
      SELECT "businessId", id, "caseId", 9, 'ISSUED', 'NEEDED', 'ISSUED', 1, 'OWNER_USER', '{}', $2 FROM "ServicePart" WHERE id = $1`, p, ikey());
  });
  const after = num(await q(runtime, A.biz, `SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, A.item));
  const st = rows(await q(owner, null, `SELECT state::text s, version FROM "ServicePart" WHERE id = $1`, p))[0];
  return [refused(r, /SERVICE_PART_EVENT_MISMATCH/) && after === before && st.s === "NEEDED" && Number(st.version) === 1, `${r} | ${before}->${after} | ${JSON.stringify(st)}`];
});
def("6.3", "1.2a / 1.2b objects unchanged: their erasure functions name no ServicePart; no Service trigger disabled; the two new deferred guards present", async () => {
  const fns = num(await q(owner, null, `SELECT count(*)::int n FROM pg_proc WHERE proname IN ('service_erase_business','service_external_erase_business') AND prosecdef AND prosrc NOT LIKE '%ServicePart%'`));
  const disabled = num(await q(owner, null, `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND t.tgenabled = 'D' AND c.relname LIKE 'Service%'`));
  const guards = num(await q(owner, null, `SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('ServiceCase_parts_resolved_on_close','ServiceExternalWork_parts_resolved_on_return') AND tgdeferrable AND tginitdeferred AND tgenabled <> 'D'`));
  return [fns === 2 && disabled === 0 && guards === 2, `fns=${fns} disabled=${disabled} guards=${guards}`];
});

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
    if (okv) { pass++; console.log(`  [PASS] ${c.id} ${c.title}${detail && c.id.startsWith("5.") ? " — " + detail : ""}`); }
    else { failures.push(c.id); console.log(`  [FAIL] ${c.id} ${c.title}${detail ? " — " + detail : ""}`); }
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
