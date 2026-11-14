/**
 * Service Desk — migration 20261128090000_service_parts_reservation_guard, proven AS the runtime role on a real lab
 * (.sdresv/lab.sh <db> then --deploy-only: 1.2a + 1.2b + M2 + 1.3-0 + P4 + #1096 + #1104 + M1 + this one, applied by
 * `prisma migrate deploy`; 'SERVICE_PART' movement reason simulated as in .sdp --m0-sim). Raw SQL only — the guard is
 * the database's, so every write here is the plainest one a writer could send (no service-layer check helps it).
 *
 *   S  structure: the two functions are invoker, search_path … pg_temp last, no PUBLIC EXECUTE; G1 is a DEFERRED
 *      constraint trigger on ServiceCase, G2 an immediate row trigger on ServicePart.
 *   C  cancel with RESERVED parts: without the release the COMMIT is refused and nothing stays (FIELD → CANCELLED, held
 *      READY + CANCELLED, a cancel REQUESTED at a supplier); with the release in the same transaction, before or after
 *      the case moves, it commits; NEEDED / CANCELLED / ON_ORDER lines are left as they are.
 *   U  consumed parts: ISSUED / INSTALLED lines are untouched by a cancel; they cannot be RELEASED or CANCELLED; after
 *      the cancel they can still be resolved (installed / returned).
 *   A  after a cancel: no line becomes RESERVED, none leaves the stock (ISSUED from NEEDED / RESERVED).
 *   Q  one quantity is reserved once: reservations of an item fit in its quantity on hand (exactly the last units pass,
 *      one more is refused; a release frees them; fractional units; an item at zero).
 *   K  races, two connections: cancel+release vs issue (both orders); cancel+release vs reserve; a buggy cancel
 *      (no release) vs a reserve that committed first; two reservations of the last units.
 *   R  repeats: a second release is refused, the same event key is refused, a repeated cancel adds no part effect.
 *   J  journal: one RELEASED event per released line (seq = version, before/after states, its key); append-only.
 *   I  isolation: another business cannot see or release A's lines; its reservations and cancels are its own.
 *
 * env: OWNER_URL (lab owner), RUNTIME_URL (app_runtime_prod). Synthetic only. Output: "<n> passed, <m> failed".
 */
import { PrismaClient, Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=12&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });
const runtime2 = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }
async function inTx<T>(client: PrismaClient, biz: number, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${biz}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => `ERR ${e.message}`);
}
const refused = (r: unknown, re: RegExp) => typeof r === "string" && r.startsWith("ERR ") && re.test(r);
const committed = (r: unknown) => !(typeof r === "string" && r.startsWith("ERR "));
const short = (r: unknown) => (typeof r === "string" ? r.replace(/\s+/g, " ").slice(0, 220) : JSON.stringify(r));
const oq = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const on = async (sql: string, ...a: unknown[]) => Number((await oq(sql, ...a))[0]?.n);
let keySeq = 0;
const T0 = Date.now();
const ikey = () => `sdresv-${T0}-${String(++keySeq).padStart(6, "0")}`;

// ── fixtures (raw, as the runtime role under the tenant context) ─────────────────────────────────────────────
async function business(tag: string) {
  const biz = Number((await oq(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdresv-${tag}-${T0}`))[0].id);
  const user = Number((await oq(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdresv-${tag}-${T0}@lab.invalid`, biz))[0].id);
  const cust = Number((await oq(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, biz))[0].id);
  const supplier = Number((await oq(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz))[0].id);
  return { biz, user, cust, supplier };
}
type B = Awaited<ReturnType<typeof business>>;
const item = async (b: B, qty: number, unit = "UNIT") =>
  Number((await oq(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך 6.1', $2::"InventoryUnitType", $3, now()) RETURNING id`, b.biz, unit, qty))[0].id);

async function openCaseTx(tx: Tx, b: B, kind: "IN_SHOP" | "FIELD" = "FIELD") {
  const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
    ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1 RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
    VALUES ($1, $2, $3::"ServiceCaseKind", $4, 'לא נדלק', now()) RETURNING id`, b.biz, n, kind, b.cust)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, b.biz, id, b.user, ikey());
  return id;
}
/** One case transition and its mirroring event (the 1.2a journal rule), in the caller's transaction. */
async function caseMoveTx(tx: Tx, b: B, caseId: number, m: { set: string; action: string; type: string; to: string; outcome?: string | null; crAfter?: boolean }) {
  const before = ((await tx.$queryRawUnsafe(`SELECT status::text s, "cancellationRequested" cr FROM "ServiceCase" WHERE id = $1 FOR UPDATE`, caseId)) as Rows)[0];
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET ${m.set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", $8, $9, $10::"ServiceOutcome", 'OWNER_USER', $11, '{}', $12)`,
    b.biz, caseId, v, m.type, m.action, before.s, m.to, before.cr === true, m.crAfter ?? false, m.outcome ?? null, b.user, ikey());
}
const cancelField = (tx: Tx, b: B, c: number) =>
  caseMoveTx(tx, b, c, { set: `status = 'CANCELLED', outcome = 'CANCELLED', "cancelledAt" = now()`, action: "CANCEL", type: "case.cancelled", to: "CANCELLED", outcome: "CANCELLED" });
const cancelHeld = (tx: Tx, b: B, c: number) =>
  caseMoveTx(tx, b, c, { set: `status = 'READY', outcome = 'CANCELLED', "cancelledAt" = now(), "readyAt" = now(), "cancelReason" = 'הלקוח ביטל'`, action: "CANCEL", type: "case.cancelled", to: "READY", outcome: "CANCELLED" });
const requestCancel = (tx: Tx, b: B, c: number) =>
  caseMoveTx(tx, b, c, { set: `"cancellationRequested" = true, "cancelledAt" = now(), "cancelReason" = 'הלקוח ביטל'`, action: "CANCEL", type: "case.cancellation_requested", to: "EXTERNAL", crAfter: true });

async function addPartTx(tx: Tx, b: B, caseId: number, itemId: number | null, qty: number, unit = "UNIT") {
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, "inventoryItemId", "nameSnapshot", "unitType", quantity, "createdByUserId", "updatedAt")
    VALUES ($1, $2, $3::"ServicePartSource", $4, 'מסך 6.1', $5::"InventoryUnitType", $6, $7, now()) RETURNING id`,
    b.biz, caseId, itemId === null ? "NON_STOCK" : "STOCK", itemId, unit, qty, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", "idempotencyKey")
    VALUES ($1, $2, $3, 1, 'ADDED', NULL, 'NEEDED', $4, 'OWNER_USER', $5, $6)`, b.biz, id, caseId, qty, b.user, ikey());
  return id;
}
/** One part change of one kind + its event (seq = the new version), the 20261115090000 rule. `where` narrows the row. */
async function partMoveTx(tx: Tx, b: B, partId: number, kind: string, to: string, extra = "", key = ikey(), where = "") {
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServicePart" SET state = $2::"ServicePartState", "lastEventKind" = $3::"ServicePartEventKind", version = version + 1, "updatedAt" = now()${extra}
    WHERE id = $1 ${where} RETURNING version, "caseId", quantity, "issueMovementId", "returnMovementId"`, partId, to, kind)) as Rows)[0];
  if (!r) return "NO_ROW";
  const before = ((await tx.$queryRawUnsafe(`SELECT "stateAfter"::text s FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq DESC LIMIT 1`, partId)) as Rows)[0]?.s ?? null;
  const mv = kind === "ISSUED" ? r.issueMovementId : kind === "RETURNED" ? r.returnMovementId : null;
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, "movementId", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5::"ServicePartEventKind", $6::"ServicePartState", $7::"ServicePartState", $8, $9, 'OWNER_USER', $10, $11::jsonb, $12)`,
    b.biz, partId, Number(r.caseId), Number(r.version), kind, before, to, Number(r.quantity), mv === null ? null : Number(mv), b.user, kind === "RELEASED" ? '{"byCaseCancel":true}' : "{}", key);
  return "OK";
}
const reserveTx = (tx: Tx, b: B, p: number) => partMoveTx(tx, b, p, "RESERVED", "RESERVED");
const releaseTx = (tx: Tx, b: B, p: number, key?: string) => partMoveTx(tx, b, p, "RELEASED", "NEEDED", "", key);
/** The application's release (part-release.ts): every RESERVED line of the case, locked, → NEEDED with its event. */
async function releaseAllTx(tx: Tx, b: B, caseId: number) {
  const rows = (await tx.$queryRawUnsafe(`SELECT id FROM "ServicePart" WHERE "caseId" = $1 AND state = 'RESERVED' ORDER BY id FOR UPDATE`, caseId)) as Rows;
  for (const r of rows) await releaseTx(tx, b, Number(r.id));
  return rows.length;
}
/** Issue a STOCK line: the OUT SERVICE_PART movement, the item's quantity, the line ISSUED with it (cost source NONE). */
async function issueTx(tx: Tx, b: B, partId: number, where = "") {
  const p = ((await tx.$queryRawUnsafe(`SELECT "inventoryItemId" i, quantity q FROM "ServicePart" WHERE id = $1`, partId)) as Rows)[0];
  const it = ((await tx.$queryRawUnsafe(`SELECT "currentQuantity" c FROM "InventoryItem" WHERE id = $1`, Number(p.i))) as Rows)[0];
  const qn = Number(p.q), cur = Number(it.c);
  const mv = Number(((await tx.$queryRawUnsafe(`INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", reason, "quantityDelta", "quantityBefore", "quantityAfter")
    VALUES ($1, $2, 'OUT', 'SERVICE_PART', $3, $4, $5) RETURNING id`, b.biz, Number(p.i), -qn, cur, cur - qn)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`UPDATE "InventoryItem" SET "currentQuantity" = "currentQuantity" - $2, "updatedAt" = now() WHERE id = $1`, Number(p.i), qn);
  return partMoveTx(tx, b, partId, "ISSUED", "ISSUED", `, "issueMovementId" = ${mv}, "costSource" = 'NONE'`, ikey(), where);
}
const installTx = (tx: Tx, b: B, p: number) => partMoveTx(tx, b, p, "INSTALLED", "INSTALLED", `, "closedAt" = now()`);

const partRow = async (id: number) => (await oq(`SELECT state::text s, version v, "issueMovementId" m, "closedAt" IS NOT NULL closed FROM "ServicePart" WHERE id = $1`, id))[0];
const caseRow = async (id: number) => (await oq(`SELECT status::text s, outcome::text o, "cancellationRequested" cr, version v FROM "ServiceCase" WHERE id = $1`, id))[0];
const events = (partId: number) => on(`SELECT count(*)::int n FROM "ServicePartEvent" WHERE "partId" = $1`, partId);
const reservedOf = (itemId: number) => on(`SELECT COALESCE(sum(quantity), 0)::float8 n FROM "ServicePart" WHERE "inventoryItemId" = $1 AND state = 'RESERVED'`, itemId);

/** A live case with `n` RESERVED STOCK lines (+ optionally other lines), committed. */
async function caseWithReserved(b: B, itemId: number, n: number, kind: "IN_SHOP" | "FIELD" = "FIELD") {
  const r = await inTx(runtime, b.biz, async (tx) => {
    const c = await openCaseTx(tx, b, kind);
    const parts: number[] = [];
    for (let i = 0; i < n; i++) { const p = await addPartTx(tx, b, c, itemId, 1); await reserveTx(tx, b, p); parts.push(p); }
    return { c, parts };
  });
  if (typeof r === "string") throw new Error(`fixture: ${r}`);
  return r;
}
async function externalCaseWithReserved(b: B, itemId: number) {
  const r = await inTx(runtime, b.biz, async (tx) => {
    const c = await openCaseTx(tx, b, "IN_SHOP");
    const p = await addPartTx(tx, b, c, itemId, 1); await reserveTx(tx, b, p);
    await caseMoveTx(tx, b, c, { set: `status = 'EXTERNAL'`, action: "SEND_TO_EXTERNAL", type: "external.sent", to: "EXTERNAL" });
    const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "updatedAt")
      VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד', now()) RETURNING id`, b.biz, c, b.supplier, b.user)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'SENT', 'SENT', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, c, b.user, ikey());
    return { c, parts: [p] };
  });
  if (typeof r === "string") throw new Error(`fixture: ${r}`);
  return r;
}

async function main() {
  const A = await business("a"), Bz = await business("b");

  console.log("S — structure");
  const fns = await oq(`SELECT proname, prosecdef, array_to_string(proconfig, ',') cfg, has_function_privilege('public', oid, 'EXECUTE') pub
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('service_case_parts_released_on_cancel', 'service_part_takes_stock_guard')`);
  ok("S1 both functions exist, SECURITY INVOKER, search_path pg_catalog, public, pg_temp; no PUBLIC EXECUTE",
    fns.length === 2 && fns.every((f) => f.prosecdef === false && String(f.cfg) === "search_path=pg_catalog, public, pg_temp" && f.pub === false), JSON.stringify(fns));
  const trg = await oq(`SELECT tgname, tgrelid::regclass::text rel, tgconstraint <> 0 con, tgdeferrable d, tginitdeferred i, tgenabled e FROM pg_trigger
    WHERE tgname IN ('ServiceCase_parts_released_on_cancel', 'ServicePart_takes_stock_on_live_case') ORDER BY tgname`);
  ok("S2 G1 is a DEFERRABLE INITIALLY DEFERRED constraint trigger on ServiceCase; G2 an immediate trigger on ServicePart; both enabled",
    trg.length === 2 && trg[0].rel === '"ServiceCase"' && trg[0].con === true && trg[0].d === true && trg[0].i === true
      && trg[1].rel === '"ServicePart"' && trg[1].d === false && trg.every((t) => t.e === "O"), JSON.stringify(trg));

  console.log("C — cancel with RESERVED parts");
  const itA = await item(A, 100);
  {
    const f = await caseWithReserved(A, itA, 2);
    const ev0 = await events(f.parts[0]);
    const r = await inTx(runtime, A.biz, (tx) => cancelField(tx, A, f.c));
    const c = await caseRow(f.c);
    ok("C1 FIELD → CANCELLED while 2 lines are RESERVED, no release: refused at COMMIT (DZP12), case and lines unchanged",
      refused(r, /SERVICE_PART_RESERVED_ON_CANCELLED_CASE/) && c.s === "OPEN" && (await partRow(f.parts[0])).s === "RESERVED" && (await events(f.parts[0])) === ev0, short(r));
    const r2 = await inTx(runtime, A.biz, async (tx) => { const n = await releaseAllTx(tx, A, f.c); await cancelField(tx, A, f.c); return n; });
    const p0 = await partRow(f.parts[0]), p1 = await partRow(f.parts[1]);
    ok("C2 the same cancel with the release first in its transaction commits: both lines NEEDED (version 3), case CANCELLED",
      r2 === 2 && p0.s === "NEEDED" && p1.s === "NEEDED" && Number(p0.v) === 3 && (await caseRow(f.c)).s === "CANCELLED", short(r2));
    const ev = await oq(`SELECT seq, kind::text k, "stateBefore"::text b, "stateAfter"::text a, payload->>'byCaseCancel' bc FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq`, f.parts[0]);
    ok("J1 the released line's journal: ADDED, RESERVED, RELEASED (seq 3, RESERVED → NEEDED, byCaseCancel) — exactly one RELEASED",
      ev.length === 3 && ev[2].k === "RELEASED" && Number(ev[2].seq) === 3 && ev[2].b === "RESERVED" && ev[2].a === "NEEDED" && ev[2].bc === "true"
        && ev.filter((e) => e.k === "RELEASED").length === 1, JSON.stringify(ev));
  }
  {
    const f = await caseWithReserved(A, itA, 1);
    const r = await inTx(runtime, A.biz, async (tx) => { await cancelField(tx, A, f.c); await releaseAllTx(tx, A, f.c); return "ok"; });
    ok("C3 cancel FIRST, release after it in the same transaction: commits (the check is at COMMIT)",
      committed(r) && (await partRow(f.parts[0])).s === "NEEDED" && (await caseRow(f.c)).s === "CANCELLED", short(r));
  }
  {
    const f = await caseWithReserved(A, itA, 1, "IN_SHOP");
    const r = await inTx(runtime, A.biz, (tx) => cancelHeld(tx, A, f.c));
    ok("C4 a held item's cancel (READY + outcome CANCELLED) with a RESERVED line, no release: refused",
      refused(r, /SERVICE_PART_RESERVED_ON_CANCELLED_CASE/) && (await caseRow(f.c)).s === "OPEN", short(r));
    const r2 = await inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, f.c); await cancelHeld(tx, A, f.c); return "ok"; });
    const c = await caseRow(f.c);
    ok("C5 … with the release: commits (READY, CANCELLED; the line NEEDED)", committed(r2) && c.s === "READY" && c.o === "CANCELLED" && (await partRow(f.parts[0])).s === "NEEDED", short(r2));
    const r3 = await inTx(runtime, A.biz, (tx) => caseMoveTx(tx, A, f.c, { set: `status = 'DELIVERED', "deliveredAt" = now()`, action: "DELIVER", type: "case.delivered", to: "DELIVERED", outcome: "CANCELLED" }));
    ok("C6 the cancelled case moves on (READY → DELIVERED, outcome CANCELLED kept): the guard re-checks and passes", committed(r3) && (await caseRow(f.c)).s === "DELIVERED", short(r3));
  }
  {
    const f = await externalCaseWithReserved(A, itA);
    const r = await inTx(runtime, A.biz, (tx) => requestCancel(tx, A, f.c));
    ok("C7 a cancel REQUESTED while a supplier has the item, with a RESERVED line, no release: refused",
      refused(r, /SERVICE_PART_RESERVED_ON_CANCELLED_CASE/) && (await caseRow(f.c)).cr === false, short(r));
    const r2 = await inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, f.c); await requestCancel(tx, A, f.c); return "ok"; });
    ok("C8 … with the release: commits (EXTERNAL, cancellationRequested; the line NEEDED)",
      committed(r2) && (await caseRow(f.c)).cr === true && (await partRow(f.parts[0])).s === "NEEDED", short(r2));
  }
  {
    const f = await caseWithReserved(A, itA, 1);
    const other = await inTx(runtime, A.biz, async (tx) => {
      const needed = await addPartTx(tx, A, f.c, itA, 1);
      const gone = await addPartTx(tx, A, f.c, itA, 1); await partMoveTx(tx, A, gone, "CANCELLED", "CANCELLED", `, "closedAt" = now()`);
      const free = await addPartTx(tx, A, f.c, null, 2);
      return { needed, gone, free };
    });
    if (typeof other === "string") throw new Error(other);
    const v = await Promise.all([other.needed, other.gone, other.free].map(partRow));
    const r = await inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, f.c); await cancelField(tx, A, f.c); return "ok"; });
    const w = await Promise.all([other.needed, other.gone, other.free].map(partRow));
    ok("C9 only the RESERVED line is released; a NEEDED, a CANCELLED and a NON_STOCK line are left exactly as they were",
      committed(r) && JSON.stringify(v) === JSON.stringify(w) && (await partRow(f.parts[0])).s === "NEEDED", short(r));
  }

  console.log("U — consumed parts");
  const itU = await item(A, 10);
  {
    const f = await inTx(runtime, A.biz, async (tx) => {
      const c = await openCaseTx(tx, A, "IN_SHOP");
      const issued = await addPartTx(tx, A, c, itU, 1); await reserveTx(tx, A, issued); await issueTx(tx, A, issued);
      const installed = await addPartTx(tx, A, c, itU, 1); await issueTx(tx, A, installed); await installTx(tx, A, installed);
      const reserved = await addPartTx(tx, A, c, itU, 1); await reserveTx(tx, A, reserved);
      return { c, issued, installed, reserved };
    });
    if (typeof f === "string") throw new Error(f);
    const before = [await partRow(f.issued), await partRow(f.installed)];
    const qty = await on(`SELECT "currentQuantity"::float8 n FROM "InventoryItem" WHERE id = $1`, itU);
    const r = await inTx(runtime, A.biz, async (tx) => { const n = await releaseAllTx(tx, A, f.c); await cancelHeld(tx, A, f.c); return n; });
    const after = [await partRow(f.issued), await partRow(f.installed)];
    ok("U1 a cancel with an ISSUED, an INSTALLED and a RESERVED line commits releasing ONLY the reserved one; the consumed lines (state, version, movement) and the stock are unchanged",
      r === 1 && JSON.stringify(before) === JSON.stringify(after) && before[0].s === "ISSUED" && before[1].s === "INSTALLED"
        && (await partRow(f.reserved)).s === "NEEDED" && (await on(`SELECT "currentQuantity"::float8 n FROM "InventoryItem" WHERE id = $1`, itU)) === qty, short(r));
    const rel = await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, f.issued));
    const rel2 = await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, f.installed));
    const can = await inTx(runtime, A.biz, (tx) => partMoveTx(tx, A, f.issued, "CANCELLED", "CANCELLED", `, "closedAt" = now()`));
    ok("U2 a consumed line can never be released or cancelled (ISSUED → RELEASED, INSTALLED → RELEASED, ISSUED → CANCELLED all refused)",
      refused(rel, /SERVICE_PART_TRANSITION/) && refused(rel2, /SERVICE_PART_TRANSITION/) && refused(can, /SERVICE_PART_TRANSITION/)
        && JSON.stringify(await partRow(f.issued)) === JSON.stringify(after[0]), `${short(rel)} | ${short(can)}`);
    const ins = await inTx(runtime, A.biz, (tx) => installTx(tx, A, f.issued));
    ok("U3 after the cancel the ISSUED line is still resolved normally (recorded INSTALLED) — resolutions are not this guard's", committed(ins) && (await partRow(f.issued)).s === "INSTALLED", short(ins));
  }

  console.log("A — after a cancel");
  {
    const f = await inTx(runtime, A.biz, async (tx) => {
      const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c, itA, 1); const p2 = await addPartTx(tx, A, c, itA, 1);
      await cancelField(tx, A, c); return { c, p, p2 };
    });
    if (typeof f === "string") throw new Error(f);
    const r = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, f.p));
    ok("A1 a NEEDED line of a CANCELLED case cannot be RESERVED (DZP12 SERVICE_PART_CASE_CANCELLED)", refused(r, /SERVICE_PART_CASE_CANCELLED/) && (await partRow(f.p)).s === "NEEDED", short(r));
    const mv0 = await on(`SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, itA);
    const r2 = await inTx(runtime, A.biz, (tx) => issueTx(tx, A, f.p2));
    ok("A2 … nor leave the stock (NEEDED → ISSUED refused; its movement and stock change roll back with it)",
      refused(r2, /SERVICE_PART_CASE_CANCELLED/) && (await partRow(f.p2)).s === "NEEDED" && (await on(`SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, itA)) === mv0, short(r2));
    const g = await externalCaseWithReserved(A, itA);
    await inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, g.c); await requestCancel(tx, A, g.c); });
    const r3 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, g.parts[0]));
    ok("A3 a cancel REQUESTED at a supplier counts as cancelled: re-reserving the released line is refused", refused(r3, /SERVICE_PART_CASE_CANCELLED/), short(r3));
    const r4 = await inTx(runtime, A.biz, (tx) => partMoveTx(tx, A, f.p, "CANCELLED", "CANCELLED", `, "closedAt" = now()`));
    ok("A4 a change that takes no stock (cancelling the NEEDED line with the case) is not this guard's: it commits", committed(r4) && (await partRow(f.p)).s === "CANCELLED", short(r4));
  }

  console.log("Q — one quantity is reserved once");
  {
    const it3 = await item(A, 3);
    const c1 = await caseWithReserved(A, it3, 2);
    const f = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); return { c, a: await addPartTx(tx, A, c, it3, 2), b: await addPartTx(tx, A, c, it3, 1) }; });
    if (typeof f === "string") throw new Error(f);
    const r = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, f.a));
    ok("Q1 3 on hand, 2 reserved elsewhere: reserving 2 more is refused (DZP13 SERVICE_PART_OVER_RESERVED)", refused(r, /SERVICE_PART_OVER_RESERVED/) && (await reservedOf(it3)) === 2, short(r));
    const r2 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, f.b));
    ok("Q2 reserving exactly the last unit passes (3 of 3)", committed(r2) && (await reservedOf(it3)) === 3, short(r2));
    await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, c1.parts[0]));
    await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, c1.parts[1]));
    const r3 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, f.a));
    ok("Q3 a release frees the quantity: after 2 are released the 2 can be reserved", committed(r3) && (await reservedOf(it3)) === 3, short(r3));
    const ml = await item(A, 1.5, "ML");
    const g = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); return { a: await addPartTx(tx, A, c, ml, 1.25, "ML"), b: await addPartTx(tx, A, c, ml, 0.5, "ML") }; });
    if (typeof g === "string") throw new Error(g);
    const r4 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, g.a));
    const r5 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, g.b));
    ok("Q4 fractional units: 1.25 of 1.5 passes, 0.5 more is refused", committed(r4) && refused(r5, /SERVICE_PART_OVER_RESERVED/), `${short(r4)} | ${short(r5)}`);
    const z = await item(A, 0);
    const h = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); return addPartTx(tx, A, c, z, 1); });
    const r6 = await inTx(runtime, A.biz, (tx) => reserveTx(tx, A, Number(h)));
    ok("Q5 an item with nothing on hand cannot be reserved", refused(r6, /SERVICE_PART_OVER_RESERVED/), short(r6));
    const r7 = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); const p = await addPartTx(tx, A, c, it3, 1); await issueTx(tx, A, p); return "ok"; });
    ok("Q6 an issue straight from NEEDED does not count as a reservation (the stock movement is the inventory's check)", committed(r7), short(r7));
  }

  console.log("K — races, two connections");
  {
    // K1 cancel+release holds the case; an issue of the same RESERVED line (no version check) waits, then is refused.
    const it = await item(A, 5);
    const f = await caseWithReserved(A, it, 1, "IN_SHOP");
    const g = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, f.c); await cancelHeld(tx, A, f.c); g.open(); await sleep(700); return "cancelled"; }).finally(() => g.open());
    await g.p;
    const T2 = inTx(runtime2, A.biz, (tx) => issueTx(tx, A, f.parts[0]));
    const [r1, r2] = await Promise.all([T1, T2]);
    ok("K1 cancel+release first, a concurrent issue of the same line second: the cancel commits, the issue is refused (case cancelled), no movement stays",
      committed(r1) && refused(r2, /SERVICE_PART_CASE_CANCELLED|SERVICE_PART_TRANSITION/) && (await partRow(f.parts[0])).s === "NEEDED"
        && (await on(`SELECT count(*)::int n FROM "InventoryMovement" WHERE "itemId" = $1`, it)) === 0, `${short(r1)} | ${short(r2)}`);
  }
  {
    // K2 the issue first (holds the case row via the parts guard), the cancel+release second: the consumed line stays ISSUED.
    const it = await item(A, 5);
    const f = await caseWithReserved(A, it, 1, "IN_SHOP");
    const g = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { await issueTx(tx, A, f.parts[0]); g.open(); await sleep(700); return "issued"; }).finally(() => g.open());
    await g.p;
    const T2 = inTx(runtime2, A.biz, async (tx) => {
      await tx.$queryRawUnsafe(`SELECT 1 FROM "ServiceCase" WHERE id = $1 FOR UPDATE`, f.c); // the service's lockCase
      const n = await releaseAllTx(tx, A, f.c); await cancelHeld(tx, A, f.c); return n;
    });
    const [r1, r2] = await Promise.all([T1, T2]);
    ok("K2 issue first, cancel+release second: both commit; the cancel released nothing (0 lines) and the line stays ISSUED with its movement",
      committed(r1) && r2 === 0 && (await partRow(f.parts[0])).s === "ISSUED" && (await partRow(f.parts[0])).m !== null && (await caseRow(f.c)).o === "CANCELLED",
      `${short(r1)} | ${short(r2)}`);
  }
  {
    // K3 cancel+release holds the case; a reserve of another NEEDED line of the case waits, then is refused.
    const it = await item(A, 5);
    const f = await caseWithReserved(A, it, 1);
    const p2 = await inTx(runtime, A.biz, (tx) => addPartTx(tx, A, f.c, it, 1));
    const g = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { await releaseAllTx(tx, A, f.c); await cancelField(tx, A, f.c); g.open(); await sleep(700); return "cancelled"; }).finally(() => g.open());
    await g.p;
    const T2 = inTx(runtime2, A.biz, (tx) => reserveTx(tx, A, Number(p2)));
    const [r1, r2] = await Promise.all([T1, T2]);
    ok("K3 cancel+release vs a concurrent reserve on the same case: the cancel commits, the reserve is refused; nothing of the case is RESERVED",
      committed(r1) && refused(r2, /SERVICE_PART_CASE_CANCELLED/) && (await on(`SELECT count(*)::int n FROM "ServicePart" WHERE "caseId" = $1 AND state = 'RESERVED'`, f.c)) === 0,
      `${short(r1)} | ${short(r2)}`);
  }
  {
    // K4 a reserve commits while a BUGGY cancel (no release, read the parts before the lock) waits on the case row.
    const it = await item(A, 5);
    const f = await inTx(runtime, A.biz, async (tx) => { const c = await openCaseTx(tx, A); return { c, p: await addPartTx(tx, A, c, it, 1) }; });
    if (typeof f === "string") throw new Error(f);
    const g = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { await reserveTx(tx, A, f.p); g.open(); await sleep(700); return "reserved"; }).finally(() => g.open());
    await g.p;
    const T2 = inTx(runtime2, A.biz, (tx) => cancelField(tx, A, f.c));
    const [r1, r2] = await Promise.all([T1, T2]);
    ok("K4 a reserve commits first, a cancel that does not release commits second: the cancel is refused at COMMIT — the reservation is never stranded",
      committed(r1) && refused(r2, /SERVICE_PART_RESERVED_ON_CANCELLED_CASE/) && (await caseRow(f.c)).s === "OPEN" && (await partRow(f.p)).s === "RESERVED",
      `${short(r1)} | ${short(r2)}`);
  }
  {
    // K5 two reservations of the last units, two cases, two connections, no service-layer lock: one is refused.
    const it = await item(A, 2);
    const f = await inTx(runtime, A.biz, async (tx) => {
      const c1 = await openCaseTx(tx, A), c2 = await openCaseTx(tx, A);
      return { a: await addPartTx(tx, A, c1, it, 2), b: await addPartTx(tx, A, c2, it, 2) };
    });
    if (typeof f === "string") throw new Error(f);
    const g = gate();
    const T1 = inTx(runtime, A.biz, async (tx) => { await reserveTx(tx, A, f.a); g.open(); await sleep(700); return "reserved"; }).finally(() => g.open());
    await g.p;
    const T2 = inTx(runtime2, A.biz, (tx) => reserveTx(tx, A, f.b));
    const [r1, r2] = await Promise.all([T1, T2]);
    ok("K5 two reservations of the same last 2 units at once: the first commits, the second waits and is refused; 2 reserved of 2",
      committed(r1) && refused(r2, /SERVICE_PART_OVER_RESERVED/) && (await reservedOf(it)) === 2, `${short(r1)} | ${short(r2)}`);
  }

  console.log("R — repeats");
  {
    const f = await caseWithReserved(A, itA, 1);
    const k = ikey();
    await inTx(runtime, A.biz, async (tx) => { await releaseTx(tx, A, f.parts[0], k); await cancelField(tx, A, f.c); });
    const ev = await events(f.parts[0]);
    const r = await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, f.parts[0]));
    ok("R1 a second release of the released line is refused (RELEASED is only from RESERVED); no second event", refused(r, /SERVICE_PART_TRANSITION/) && (await events(f.parts[0])) === ev, short(r));
    const f2 = await caseWithReserved(A, itA, 1);
    const r2 = await inTx(runtime, A.biz, (tx) => releaseTx(tx, A, f2.parts[0], k));
    ok("R2 a release event with an idempotency key already used is refused; the other line stays RESERVED", refused(r2, /ServicePartEvent_businessId_idempotencyKey_key|Unique constraint|23505/) && (await partRow(f2.parts[0])).s === "RESERVED", short(r2));
    const pv = JSON.stringify(await partRow(f.parts[0]));
    const r3 = await inTx(runtime, A.biz, async (tx) => releaseAllTx(tx, A, f.c));
    ok("R3 running the application's release again on the cancelled case finds nothing and changes nothing", r3 === 0 && JSON.stringify(await partRow(f.parts[0])) === pv && (await events(f.parts[0])) === ev, short(r3));
  }

  console.log("J — journal");
  {
    const f = await caseWithReserved(A, itA, 1);
    const r = await inTx(runtime, A.biz, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'NEEDED', "lastEventKind" = 'RELEASED', version = version + 1, "updatedAt" = now() WHERE id = $1`, f.parts[0]);
      await cancelField(tx, A, f.c); return "ok";
    });
    ok("J2 a release WITHOUT its event (silent change) rolls back the whole cancel (the 20261115090000 journal rule still holds)",
      refused(r, /SERVICE_PART_SILENT_CHANGE/) && (await partRow(f.parts[0])).s === "RESERVED" && (await caseRow(f.c)).s === "OPEN", short(r));
    const r2 = await inTx(runtime, A.biz, (tx) => tx.$executeRawUnsafe(`UPDATE "ServicePartEvent" SET kind = 'RELEASED' WHERE "partId" = $1`, f.parts[0]));
    ok("J3 the part journal stays append-only for the runtime", refused(r2, /permission denied|SERVICE_PART_EVENT_APPEND_ONLY/), short(r2));
  }

  console.log("I — isolation");
  {
    const f = await caseWithReserved(A, itA, 1);
    const seen = await inTx(runtime, Bz.biz, async (tx) => Number(((await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "ServicePart" WHERE id = $1`, f.parts[0])) as Rows)[0].n));
    const upd = await inTx(runtime, Bz.biz, (tx) => tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'NEEDED', "lastEventKind" = 'RELEASED', version = version + 1 WHERE id = $1`, f.parts[0]));
    ok("I1 business B cannot see A's reserved line, nor release it (0 rows)", seen === 0 && upd === 0 && (await partRow(f.parts[0])).s === "RESERVED", `${seen} ${short(upd)}`);
    const itB = await item(Bz, 1);
    const gB = await caseWithReserved(Bz, itB, 1);
    const rB = await inTx(runtime, Bz.biz, async (tx) => { await releaseAllTx(tx, Bz, gB.c); await cancelField(tx, Bz, gB.c); return "ok"; });
    ok("I2 B cancels its own case (releasing its own line) while A's reservations stand: commits; A's line untouched",
      committed(rB) && (await partRow(gB.parts[0])).s === "NEEDED" && (await partRow(f.parts[0])).s === "RESERVED", short(rB));
    const itA1 = await item(A, 1);
    await caseWithReserved(A, itA1, 1);
    const g2 = await caseWithReserved(Bz, itB, 1).then(() => "ok", (e: Error) => `ERR ${e.message}`);
    ok("I3 reservations are counted per business and item: A's full item does not limit B's own item", g2 === "ok", short(g2));
    const own = await inTx(runtime, Bz.biz, async (tx) => releaseAllTx(tx, Bz, f.c));
    ok("I4 the application's release run under B's context on A's case finds nothing (0 lines; RLS)", own === 0 && (await partRow(f.parts[0])).s === "RESERVED", short(own));
  }

  console.log();
  console.log(`${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), runtime2.$disconnect()]);
  completed = true;
  process.exit(failures.length ? 1 : 0);
}

let completed = false;
process.on("beforeExit", () => { if (!completed) { console.log("the battery did not complete (a step never resolved)"); process.exit(3); } });
main().then(() => { completed = true; }).catch(async (e) => { console.error(e); await Promise.all([owner.$disconnect(), runtime.$disconnect(), runtime2.$disconnect()]); process.exit(2); });
