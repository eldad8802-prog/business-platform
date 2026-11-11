/**
 * Service Desk — the unlock proof (PR #1116, parts 1d-B + external work 1d-A opened). The owner's five questions, each a
 * named section of checks, AS the real runtime role (app_runtime_prod, NOBYPASSRLS) on the P4 lab (.sd3p4/lab.sh <db>
 * then --deploy-only: 1.2a + 1.2b + M2 + 1.3-0 + P4 applied by migrate deploy). Synthetic only. It adds to .sdparts and
 * .sdext (it weakens nothing there) and creates its own businesses, so it runs on the same lab database after them.
 *
 *   ISO  isolation between businesses: B never lists, adds to, reserves, releases, prices, cancels A's parts; never sends,
 *        acts on or returns A's external work; never uses A's inventory item or A's supplier — every answer NOT_FOUND or
 *        the same answer as an id that does not exist (no existence oracle), never an id of A in the answer; an
 *        idempotency key of A is not a replay for B; the runtime role under B's tenant context sees and changes 0 rows of A.
 *   RES  reservation: NEEDED → RESERVED (soft) within on hand − the other RESERVED lines of the item; the RESERVED event
 *        mirrors the line; RELEASE gives the quantity back; the inventory row and InventoryMovement are never touched.
 *   CXL  case CANCEL with reservations: every RESERVED line of the case → NEEDED with a RELEASED event (byCaseCancel, key
 *        "<cancel key>#rel<part id>") in the cancel's transaction; every other line, the other case, the item and the
 *        movements unchanged; the quantity is free again; a cancel replay releases nothing twice.
 *   DBL  double use: one line cannot be reserved twice (in sequence or at once); N parallel reservations of one item
 *        never exceed what is on hand (exactly the right number win); a reservation racing the case cancel leaves no
 *        RESERVED line on a cancelled case; the unique indexes that make an issue / return movement single-use and the
 *        journals single-entry exist.
 *   IDM  repeated actions: a replay with the same Idempotency-Key returns the first result and writes nothing; the same
 *        key with another body (or another line / work) → IDEMPOTENCY_KEY_REUSED; a stale expectedVersion →
 *        VERSION_CONFLICT with nothing written; one key five times at once → one write.
 *   (additions after END1 — the test extension of #1116, same lab, same helpers)
 *   RES9–12 / ISO15–16  a line asking more than on hand, an item at 0, a CANCELLED line, RELEASE of a NEEDED line, CANCEL
 *        of a RESERVED line frees it; A's part-action key on B's line is B's own write; A and B reserve at the same moment.
 *   PAR  parallel requests on separate connections: RESERVE vs CANCEL, RELEASE vs CANCEL, two cancels of one case,
 *        case cancel vs RELEASE, a reserve/release storm on one item, one add key ×4, two returns of one work — exactly
 *        one wins where one must, and every line equals its journal.
 *   FAIL failure mid-operation: a temporary lab trigger raises after the first writes inside the transaction (add,
 *        RESERVE, case CANCEL after one / after all releases, send, return) → error and the database exactly as before;
 *        the same key afterwards is a fresh write. The trigger is dropped in a finally.
 *   INV  inventory: every stock-moving action ACTION_NOT_IN_SCOPE; no SERVICE_PART movement reason exists (no issue is
 *        possible); the runtime role cannot fake an issue (wrong movement / none) nor change a line without its event;
 *        a till sale below a soft reservation; reserved ≤ on hand, 0 movement links, every line = its journal.
 *   [GAP] (printed, not counted) whether the database alone refuses a RESERVED line on a CANCELLED case.
 *
 * env: OWNER_URL (lab owner — fixtures and read-backs), DATABASE_URL = DIRECT_URL
 *      (app_runtime_prod — the services and the RLS probes), TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { PARTS_API_OPEN, addCasePart, listParts, runPartAction } from "../lib/services/service-desk/parts.service";
import {
  EXTERNAL_WORK_OPEN, listExternalWork, returnFromExternal, runExternalWorkAction, sendToExternal,
} from "../lib/services/service-desk/external-work.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
let pass = 0;
const failures: string[] = [];
const tally: Record<string, [number, number]> = {};
function ok(name: string, cond: boolean, detail = "") {
  const sec = name.replace(/[0-9].*$/, "");
  tally[sec] ??= [0, 0];
  if (cond) { pass++; tally[sec][0]++; console.log(`  [PASS] ${name}`); } else { failures.push(name); tally[sec][1]++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = (at = new Date()) => uuidV7(at);
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.slice(0, 200)}`;
  }
}
const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdunlock-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdunlock-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  const item = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך 6.1', 'UNIT', 3, now()) RETURNING id`, b))[0].id);
  const item2 = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'סוללה', 'UNIT', 2, now()) RETURNING id`, b))[0].id);
  const ml = Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'גז קירור', 'ML', 10, now()) RETURNING id`, b))[0].id);
  const supplier = Number((await q(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'ספק מעבדה', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, item, item2, ml, supplier, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
const newItem = async (z: Biz, qty: number, unit = "UNIT") =>
  Number((await q(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'פריט', $2::"InventoryUnitType", $3, now()) RETURNING id`, z.b, unit, qty))[0].id);
const openFIELD = async (z: Biz) => (await openCase(z.p, { kind: "FIELD", customerId: z.cust, problemDescription: "תקלה סינתטית" }, { idempotencyKey: key() })).case;
const act = (z: Biz, id: number, action: Record<string, unknown>, v: number, k = key()) => runCaseAction(z.p, id, { action, expectedVersion: v }, { idempotencyKey: k });
const add = (z: Biz, caseId: number, body: Record<string, unknown>, k = key()) => addCasePart(z.p, caseId, body, { idempotencyKey: k });
const stockLine = (z: Biz, caseId: number, item: number, quantity = 1) => add(z, caseId, { source: "STOCK", inventoryItemId: item, name: "חלק", quantity });
const pact = (z: Biz, partId: number, action: Record<string, unknown>, v: number, k = key()) => runPartAction(z.p, partId, { action, expectedVersion: v }, { idempotencyKey: k });
const partEvents = (partId: number) => n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "partId" = $1`, partId);
const bizPartEvents = (b: number) => n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "businessId" = $1`, b);
const movements = (b: number) => n(`SELECT count(*)::int AS n FROM "InventoryMovement" WHERE "businessId" = $1`, b);
const itemRow = async (id: number) => JSON.stringify((await q(`SELECT "currentQuantity" q, "isActive" a, "updatedAt" u FROM "InventoryItem" WHERE id = $1`, id))[0]);
const partRow = async (id: number) => (await q(`SELECT id, state::text s, version v, "lastEventKind"::text k, quantity, "customerUnitPriceAgorot" price, reason,
  "inventoryItemId" item, "closedAt" c, "issueMovementId" im, "returnMovementId" rm, "updatedAt" u FROM "ServicePart" WHERE id = $1`, id))[0];
const reservedOf = (item: number) => n(`SELECT COALESCE(sum(quantity), 0)::float8 AS n FROM "ServicePart" WHERE "inventoryItemId" = $1 AND state = 'RESERVED'`, item);
const strip = (r: Record<string, unknown>, ...cols: string[]) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !cols.includes(k))));
const caseRow = async (id: number) => (await q(`SELECT status::text s, version v, outcome::text o FROM "ServiceCase" WHERE id = $1`, id))[0];
/** A FIELD case in DIAGNOSING with a cover (as .sdext: on-site check-in needs no signature). */
async function diagnosing(z: Biz) {
  const o = await openCase(z.p, { kind: "FIELD", customerId: z.cust, problemDescription: "המזגן לא מקרר" }, { idempotencyKey: key() });
  const ci = await act(z, o.case.id, { type: "CHECK_IN" }, 1);
  const dg = await act(z, o.case.id, { type: "START_DIAGNOSIS" }, ci.case.version);
  await x(`UPDATE "ServiceCase" SET "coverageSource" = 'MANUFACTURER', "coverageDecision" = 'APPROVED' WHERE id = $1`, o.case.id); // lab: a cover
  return { id: o.case.id, v: dg.case.version };
}
const send = (z: Biz, caseId: number, v: number, extra: Record<string, unknown> = {}, k = key()) =>
  sendToExternal(z.p, caseId, { expectedVersion: v, supplierId: z.supplier, sendReason: "תיקון אצל היבואן", requestedWork: "החלפת לוח", ...extra }, { idempotencyKey: k });
const wact = (z: Biz, workId: number, action: Record<string, unknown>, v: number, k = key()) => runExternalWorkAction(z.p, workId, { action, expectedVersion: v }, { idempotencyKey: k });
const ret = (z: Biz, workId: number, wv: number, cv: number, extra: Record<string, unknown> = {}, k = key()) =>
  returnFromExternal(z.p, workId, { expectedVersion: wv, caseExpectedVersion: cv, next: "READY", outcome: "REPAIRED", result: "REPAIRED", followUpRequired: false, ...extra }, { idempotencyKey: k });
const workEvents = (workId: number) => n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1`, workId);
/** Runs `fn` as the runtime role inside one transaction under `b`'s tenant context (or none); returns its value or the error. */
async function asRuntime<T>(b: number | null, fn: (tx: Parameters<Parameters<typeof runtime.$transaction>[0]>[0]) => Promise<T>): Promise<T | string> {
  return runtime.$transaction(async (tx) => {
    if (b !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return fn(tx);
  }).catch((e) => `ERR:${String((e as Error).message).replace(/\s+/g, " ").replace(/^.*?Message: /, "").slice(0, 200)}`);
}
/** True when the text names none of the given ids as a whole number (an answer to B must not carry A's ids). */
const namesNone = (text: string, ids: number[]) => ids.every((id) => !new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(text));

async function main() {
  const A = await business("a"), B = await business("b");
  ok("SETUP1 both APIs are open in code (PARTS_API_OPEN, EXTERNAL_WORK_OPEN — the unlock PR)", PARTS_API_OPEN === true && EXTERNAL_WORK_OPEN === true);
  const role = (await runtime.$queryRawUnsafe(`SELECT current_user u, r.rolbypassrls b, r.rolsuper s FROM pg_roles r WHERE r.rolname = current_user`) as Rows)[0];
  ok("SETUP2 the services run as app_runtime_prod — NOBYPASSRLS, not a superuser", role.u === "app_runtime_prod" && role.b === false && role.s === false, JSON.stringify(role));
  const movA0 = await movements(A.b), movB0 = await movements(B.b);

  // ── 1. ISO — isolation ──────────────────────────────────────────────────────────────────────────────────────
  console.log("ISO — isolation between businesses");
  const ac = await openFIELD(A);
  const aRes = await stockLine(A, ac.id, A.item);
  const aRv = await pact(A, aRes.part.id, { type: "RESERVE" }, 1);
  const aNeed = await add(A, ac.id, { source: "NON_STOCK", name: "בורג", quantity: 1, customerUnitPriceAgorot: 500 });
  const aSnap = async () => JSON.stringify([await partRow(aRes.part.id), await partRow(aNeed.part.id), await caseRow(ac.id), await itemRow(A.item), await bizPartEvents(A.b)]);
  const a0 = await aSnap();
  const bc = await openFIELD(B);
  const iso1 = await Promise.all([
    code(() => listParts(B.b, ac.id)),
    code(() => add(B, ac.id, { source: "NON_STOCK", name: "x", quantity: 1 })),
    code(() => add(B, ac.id, { source: "STOCK", inventoryItemId: A.item, name: "x", quantity: 1 })),
  ]);
  ok("ISO1 B cannot list A's parts or add a line to A's case (stock or not) → NOT_FOUND ×3", iso1.every((r) => r === "NOT_FOUND"), JSON.stringify(iso1));
  const iso2 = [];
  for (const a of [{ type: "RESERVE" }, { type: "RELEASE" }, { type: "SET_PRICE", customerUnitPriceAgorot: 1 }, { type: "CANCEL", reason: "x" }]) {
    iso2.push(await code(() => pact(B, aRes.part.id, a, aRv.part.version)));
    iso2.push(await code(() => pact(B, aNeed.part.id, a, aNeed.part.version)));
  }
  ok("ISO2 B cannot RESERVE, RELEASE, SET_PRICE or CANCEL either of A's lines (reserved / needed) → NOT_FOUND ×8", iso2.every((r) => r === "NOT_FOUND"), JSON.stringify(iso2));
  const acv = Number((await caseRow(ac.id)).v);
  ok("ISO3 B cannot cancel (or act on) A's case → NOT_FOUND; A's reservation survives", (await code(() => act(B, ac.id, { type: "CANCEL", reason: "x" }, acv))) === "NOT_FOUND");
  ok("ISO4 after every attempt of B: A's lines, case, item and part journal are byte-for-byte unchanged", (await aSnap()) === a0);
  // A's item on B's case: the same answer as an id that does not exist (no existence oracle), with no id of A in it.
  const ghost = Number((await q(`SELECT COALESCE(max(id), 0) + 100000 AS id FROM "InventoryItem"`))[0].id);
  const foreignItem = await code(() => stockLine(B, bc.id, A.item));
  const missingItem = await code(() => stockLine(B, bc.id, ghost));
  ok("ISO5 B adding A's inventory item → refused exactly as a non-existent item (SERVER_CHECK_FAILED ITEM_BELONGS_TO_BUSINESS), no id of A in the answer, nothing written",
    foreignItem === missingItem && foreignItem.startsWith("SERVER_CHECK_FAILED") && namesNone(foreignItem, [A.item, A.b])
      && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, bc.id)) === 0, `${foreignItem} | ${missingItem}`);
  const bLine = await stockLine(B, bc.id, B.item);
  ok("ISO6 B's reservations count only B's stock: B reserves its own item although A holds a reservation on A's", (await pact(B, bLine.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED" && (await reservedOf(A.item)) === 1);
  // the same Idempotency-Key in both businesses: never a cross-tenant replay
  const shared = key();
  const aK = await add(A, ac.id, { source: "NON_STOCK", name: "מפתח משותף", quantity: 1 }, shared);
  const bK = await add(B, bc.id, { source: "NON_STOCK", name: "מפתח משותף", quantity: 1 }, shared);
  ok("ISO7 A's Idempotency-Key used by B → B gets its own new line (not a replay of A's), each journal holds the key once",
    !bK.replayed && bK.part.id !== aK.part.id && bK.part.caseId === bc.id
      && (await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "idempotencyKey" = $1`, shared)) === 2);
  const a1 = await aSnap(); // A's own add (ISO7) moved A's journal; B's attempts below are judged against this
  // external work and suppliers
  const ad = await diagnosing(A);
  const aw = await send(A, ad.id, ad.v);
  const bd = await diagnosing(B);
  const isoX = [
    await code(() => listExternalWork(B.b, ad.id)),
    await code(() => sendToExternal(B.p, ad.id, { expectedVersion: ad.v + 1, supplierId: B.supplier, sendReason: "x" }, { idempotencyKey: key() })),
    await code(() => wact(B, aw.work.id, { type: "RECORD_PROGRESS", stage: "RECEIVED_BY_SUPPLIER" }, 1)),
    await code(() => wact(B, aw.work.id, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 1 }, 1)),
    await code(() => ret(B, aw.work.id, 1, aw.case.version)),
  ];
  ok("ISO8 B cannot list, send on, act on or return A's external work → NOT_FOUND ×5; A's work unchanged (v1, one event)",
    isoX.every((r) => r === "NOT_FOUND") && (await workEvents(aw.work.id)) === 1, JSON.stringify(isoX));
  const ghostSup = Number((await q(`SELECT COALESCE(max(id), 0) + 100000 AS id FROM "Supplier"`))[0].id);
  const foreignSup = await code(() => send(B, bd.id, bd.v, { supplierId: A.supplier }));
  const missingSup = await code(() => send(B, bd.id, bd.v, { supplierId: ghostSup }));
  ok("ISO9 B sending to A's supplier → refused exactly as a non-existent supplier, no id of A in the answer, nothing written",
    foreignSup === missingSup && foreignSup.startsWith("REFUSED") && namesNone(foreignSup, [A.supplier, A.b])
      && (await n(`SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "caseId" = $1`, bd.id)) === 0, `${foreignSup} | ${missingSup}`);
  // the runtime role itself (RLS), under B's tenant context and under none
  const tables: [string, string][] = [["ServicePart", `"businessId" = ${A.b}`], ["ServicePartEvent", `"businessId" = ${A.b}`], ["ServiceExternalWork", `"businessId" = ${A.b}`],
    ["ServiceExternalWorkEvent", `"businessId" = ${A.b}`], ["ServiceCase", `"businessId" = ${A.b}`], ["Supplier", `"businessId" = ${A.b}`], ["InventoryItem", `"businessId" = ${A.b}`]];
  const ownerSees = await Promise.all(tables.map(([tb, w]) => n(`SELECT count(*)::int AS n FROM "${tb}" WHERE ${w}`)));
  const bSees = await asRuntime(B.b, async (tx) => Promise.all(tables.map(async ([tb]) => Number(((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${tb}" WHERE "businessId" = $1`, A.b)) as Rows)[0].n))));
  const noneSees = await asRuntime(null, async (tx) => Promise.all(tables.map(async ([tb]) => Number(((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${tb}" WHERE "businessId" = $1`, A.b)) as Rows)[0].n))));
  ok("ISO10 the runtime role under B's context sees 0 of A's rows in parts, part events, external works, work events, cases, suppliers and inventory items (A has rows in each)",
    ownerSees.every((c) => c > 0) && Array.isArray(bSees) && bSees.every((c) => c === 0), `${JSON.stringify(ownerSees)} vs ${JSON.stringify(bSees)}`);
  ok("ISO11 … and with no tenant context it sees 0 of them too", Array.isArray(noneSees) && noneSees.every((c) => c === 0), JSON.stringify(noneSees));
  const upd = await asRuntime(B.b, async (tx) => [
    await tx.$executeRawUnsafe(`UPDATE "InventoryItem" SET "currentQuantity" = 0 WHERE id = $1`, A.item),
    await tx.$executeRawUnsafe(`UPDATE "Supplier" SET "isActive" = false WHERE id = $1`, A.supplier),
    await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET "updatedAt" = now() WHERE id = $1`, aRes.part.id),
  ]);
  ok("ISO12 the runtime role under B's context changes 0 rows of A's item, supplier and part", Array.isArray(upd) && upd.every((c) => c === 0) && (await aSnap()) === a1, JSON.stringify(upd));
  const ins = await asRuntime(B.b, async (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, "nameSnapshot", quantity, "updatedAt") VALUES ($1, $2, 'NON_STOCK', 'x', 1, now())`, A.b, ac.id));
  const ins2 = await asRuntime(B.b, async (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, "nameSnapshot", quantity, "updatedAt") VALUES ($1, $2, 'NON_STOCK', 'x', 1, now())`, B.b, ac.id));
  const ins3 = await asRuntime(B.b, async (tx) => tx.$executeRawUnsafe(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'x', now())`, A.b));
  ok("ISO13 the runtime role cannot write a line into A's business or onto A's case from B's context (SERVICE_PART_CASE_INVALID), nor a supplier into A's business (row-level security)",
    /SERVICE_PART_CASE_INVALID|row-level security/.test(String(ins)) && /SERVICE_PART_CASE_INVALID/.test(String(ins2)) && /row-level security/.test(String(ins3))
      && (await aSnap()) === a1 && (await n(`SELECT count(*)::int AS n FROM "Supplier" WHERE "businessId" = $1`, A.b)) === 1, `${String(ins).slice(0, 90)} | ${String(ins2).slice(0, 90)} | ${String(ins3).slice(0, 90)}`);
  // HTTP: B's session on A's ids → 404, the body carries no id of A
  {
    const setOverride = async (b: number, on: boolean) => {
      await x(`DELETE FROM "BusinessFeatureAccess" WHERE "businessId" = $1 AND "featureKey" = 'service_desk'`, b);
      if (on) await x(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", state, reason, "updatedAt") VALUES ($1, 'service_desk', 'ENABLED', 'sdunlock lab', now())`, b);
    };
    const { signAuthToken } = await import("../lib/auth-token");
    const tokenB = signAuthToken(B.u);
    const routes = {
      caseParts: await import("../app/api/service-desk/cases/[id]/parts/route"),
      partActions: await import("../app/api/service-desk/parts/[partId]/actions/route"),
      caseWork: await import("../app/api/service-desk/cases/[id]/external-work/route"),
      workActions: await import("../app/api/service-desk/external-work/[workId]/actions/route"),
      workReturn: await import("../app/api/service-desk/external-work/[workId]/return/route"),
    };
    const http = (method: string, body: unknown) => new Request("https://lab.test/api/service-desk/x", {
      method, headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json", "idempotency-key": key() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await setOverride(B.b, true);
    const rs = [
      await routes.caseParts.GET(http("GET", undefined), { params: Promise.resolve({ id: String(ac.id) }) }),
      await routes.caseParts.POST(http("POST", { source: "STOCK", inventoryItemId: A.item, name: "x", quantity: 1 }), { params: Promise.resolve({ id: String(ac.id) }) }),
      await routes.partActions.POST(http("POST", { action: { type: "RELEASE" }, expectedVersion: aRv.part.version }), { params: Promise.resolve({ partId: String(aRes.part.id) }) }),
      await routes.caseWork.GET(http("GET", undefined), { params: Promise.resolve({ id: String(ad.id) }) }),
      await routes.workActions.POST(http("POST", { action: { type: "RECORD_PROGRESS", stage: "REPAIR_DONE" }, expectedVersion: 1 }), { params: Promise.resolve({ workId: String(aw.work.id) }) }),
      await routes.workReturn.POST(http("POST", { expectedVersion: 1, caseExpectedVersion: aw.case.version, next: "READY", outcome: "REPAIRED", result: "REPAIRED", followUpRequired: false }), { params: Promise.resolve({ workId: String(aw.work.id) }) }),
    ];
    const texts = await Promise.all(rs.map((r) => r.text()));
    await setOverride(B.b, false);
    ok("ISO14 over HTTP with B's session (module ON for B): every parts / external-work route on A's ids → 404, no id of A in any body",
      rs.every((r) => r.status === 404) && texts.every((s: string) => namesNone(s, [ac.id, aRes.part.id, ad.id, aw.work.id, A.item, A.b])) && (await aSnap()) === a1 && (await workEvents(aw.work.id)) === 1,
      JSON.stringify(rs.map((r, i) => `${r.status}:${texts[i].slice(0, 60)}`)));
  }

  // ── 2. RES — reservation ────────────────────────────────────────────────────────────────────────────────────
  console.log("RES — reservation (soft, no stock movement)");
  const rItem = await newItem(A, 3);
  const rItemBefore = await itemRow(rItem);
  const r1c = await openFIELD(A), r2c = await openFIELD(A);
  const r1 = await stockLine(A, r1c.id, rItem, 2);
  const kR = key();
  const rv1 = await pact(A, r1.part.id, { type: "RESERVE" }, 1, kR);
  const ev = (await q(`SELECT seq, kind::text k, "stateBefore"::text sb, "stateAfter"::text sa, quantity, "idempotencyKey" ik FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq DESC LIMIT 1`, r1.part.id))[0];
  ok("RES1 NEEDED → RESERVED v2; the event is RESERVED (seq 2, NEEDED → RESERVED, quantity 2, the request's key); warning RESERVATION_IS_SOFT",
    rv1.part.state === "RESERVED" && rv1.part.version === 2 && rv1.warnings.includes("RESERVATION_IS_SOFT")
      && Number(ev.seq) === 2 && ev.k === "RESERVED" && ev.sb === "NEEDED" && ev.sa === "RESERVED" && Number(ev.quantity) === 2 && ev.ik === kR);
  const r2 = await stockLine(A, r2c.id, rItem, 2);
  ok("RES2 on hand 3, 2 reserved by another line → reserving 2 more is refused PART_NOT_AVAILABLE, the line stays NEEDED v1, nothing written",
    (await code(() => pact(A, r2.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE") && (await partRow(r2.part.id)).s === "NEEDED" && (await partEvents(r2.part.id)) === 1);
  const r3 = await stockLine(A, r2c.id, rItem, 1);
  ok("RES3 … the remaining 1 can be reserved (available = on hand − the other RESERVED lines); 3 of 3 now reserved",
    (await pact(A, r3.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED" && (await reservedOf(rItem)) === 3);
  const rl1 = await pact(A, r1.part.id, { type: "RELEASE" }, rv1.part.version);
  ok("RES4 RELEASE → NEEDED v3 with a RELEASED event; the 2 units are available again (reserving the other line's 2 now passes)",
    rl1.part.state === "NEEDED" && rl1.part.version === 3 && (await q(`SELECT kind::text k FROM "ServicePartEvent" WHERE "partId" = $1 AND seq = 3`, r1.part.id))[0].k === "RELEASED"
      && (await pact(A, r2.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED" && (await reservedOf(rItem)) === 3);
  ok("RES5 the inventory item row is unchanged (quantity, active, updatedAt) and no InventoryMovement exists for the business",
    (await itemRow(rItem)) === rItemBefore && (await movements(A.b)) === movA0);
  const nsl = await add(A, r1c.id, { source: "NON_STOCK", name: "חלק מיוחד", quantity: 1 });
  ok("RES6 a NON_STOCK line cannot be reserved (NOT_A_STOCK_PART)", (await code(() => pact(A, nsl.part.id, { type: "RESERVE" }, 1))).includes("NOT_A_STOCK_PART"));
  const offItem = await newItem(A, 5);
  const offLine = await stockLine(A, r1c.id, offItem);
  await x(`UPDATE "InventoryItem" SET "isActive" = false WHERE id = $1`, offItem);
  ok("RES7 an item deactivated after the line was added → RESERVE refused ITEM_INACTIVE, nothing written",
    (await code(() => pact(A, offLine.part.id, { type: "RESERVE" }, 1))).includes("ITEM_INACTIVE") && (await partEvents(offLine.part.id)) === 1);
  const mlItem = await newItem(A, 10, "ML");
  const ml1 = await add(A, r1c.id, { source: "STOCK", inventoryItemId: mlItem, name: "גז", quantity: 6.5 });
  const ml2 = await add(A, r2c.id, { source: "STOCK", inventoryItemId: mlItem, name: "גז", quantity: 3.5 });
  const ml3 = await add(A, r2c.id, { source: "STOCK", inventoryItemId: mlItem, name: "גז", quantity: 0.25 });
  ok("RES8 a measured unit: 6.5 + 3.5 of 10 ML both reserve (exactly on hand); 0.25 more → PART_NOT_AVAILABLE",
    (await pact(A, ml1.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED" && (await pact(A, ml2.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED"
      && (await code(() => pact(A, ml3.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE"));

  // ── 3. CXL — case CANCEL releases the reservations ──────────────────────────────────────────────────────────
  console.log("CXL — case CANCEL → RELEASE_PART_RESERVATIONS");
  const cItem = await newItem(A, 5), cItem2 = await newItem(A, 5);
  const cc = await openFIELD(A), other = await openFIELD(A);
  const cRes1 = await stockLine(A, cc.id, cItem, 2);
  const cRes2 = await stockLine(A, cc.id, cItem2, 1);
  const cNeed = await stockLine(A, cc.id, cItem, 1);
  const cNon = await add(A, cc.id, { source: "NON_STOCK", name: "שירות", quantity: 1, customerUnitPriceAgorot: 9900 });
  const cGone = await stockLine(A, cc.id, cItem, 1);
  const oRes = await stockLine(A, other.id, cItem, 1);
  const v1 = (await pact(A, cRes1.part.id, { type: "RESERVE" }, 1)).part.version;
  await pact(A, cRes1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 12000 }, v1);
  await pact(A, cRes2.part.id, { type: "RESERVE" }, 1);
  await pact(A, cGone.part.id, { type: "CANCEL", reason: "לא נדרש" }, 1);
  await pact(A, oRes.part.id, { type: "RESERVE" }, 1);
  const released = [cRes1.part.id, cRes2.part.id], untouched = [cNeed.part.id, cNon.part.id, cGone.part.id, oRes.part.id];
  const before: Record<number, Record<string, unknown>> = {};
  for (const id of [...released, ...untouched]) before[id] = await partRow(id);
  const evBefore = await bizPartEvents(A.b);
  const items0 = [await itemRow(cItem), await itemRow(cItem2)];
  const ccv = Number((await caseRow(cc.id)).v);
  const kC = key();
  const cx = await act(A, cc.id, { type: "CANCEL", reason: "הלקוח ביטל" }, ccv, kC);
  ok("CXL1 CANCEL of an OPEN case with 2 RESERVED lines → the case CANCELLED / outcome CANCELLED, one case event", cx.case.status === "CANCELLED" && !cx.replayed
    && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, cc.id)) === ccv + 1, JSON.stringify(cx.case.status));
  const relEv = await q(`SELECT "partId" p, seq, kind::text k, "stateBefore"::text sb, "stateAfter"::text sa, quantity, "idempotencyKey" ik, payload->>'byCaseCancel' bc
    FROM "ServicePartEvent" WHERE "caseId" = $1 AND "idempotencyKey" LIKE $2 ORDER BY "partId"`, cc.id, `${kC}#rel%`);
  let allRel = relEv.length === 2;
  for (const id of released) {
    const now = await partRow(id), e = relEv.find((r) => Number(r.p) === id);
    allRel &&= now.s === "NEEDED" && Number(now.v) === Number(before[id].v) + 1 && now.k === "RELEASED" && !!e && e.k === "RELEASED" && e.sb === "RESERVED" && e.sa === "NEEDED"
      && Number(e.seq) === Number(now.v) && Number(e.quantity) === Number(before[id].quantity) && e.ik === `${kC}#rel${id}` && e.bc === "true";
  }
  ok("CXL2 each RESERVED line → NEEDED, version + 1, with its own RELEASED event (seq = new version, its quantity, byCaseCancel, key <cancel key>#rel<id>)", allRel, JSON.stringify(relEv));
  ok("CXL3 a released line changes ONLY state / version / lastEventKind / updatedAt (its price, quantity, item, reason, movements kept)",
    (await Promise.all(released.map(async (id) => strip(await partRow(id), "s", "v", "k", "u") === strip(before[id], "s", "v", "k", "u")))).every(Boolean));
  ok("CXL4 nothing else changed: the NEEDED stock line, the NON_STOCK line, the already-CANCELLED line and ANOTHER case's RESERVED line of the same item are byte-for-byte unchanged",
    (await Promise.all(untouched.map(async (id) => JSON.stringify(await partRow(id)) === JSON.stringify(before[id])))).every(Boolean));
  ok("CXL5 exactly 2 new part events for the business (the two RELEASED), the items unchanged, no InventoryMovement",
    (await bizPartEvents(A.b)) === evBefore + 2 && (await itemRow(cItem)) === items0[0] && (await itemRow(cItem2)) === items0[1] && (await movements(A.b)) === movA0);
  ok("CXL6 the released quantity is free: of item 1 only the other case's 1 unit stays reserved, of item 2 nothing", (await reservedOf(cItem)) === 1 && (await reservedOf(cItem2)) === 0);
  const ccNext = await openFIELD(A);
  const take = await stockLine(A, ccNext.id, cItem, 4);
  ok("CXL7 … another case can now reserve 4 of the 5 (5 on hand − 1 still reserved)", (await pact(A, take.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED");
  const evMid = await bizPartEvents(A.b);
  const rep = await act(A, cc.id, { type: "CANCEL", reason: "הלקוח ביטל" }, ccv, kC);
  ok("CXL8 the cancel replayed with its key → replayed, no new case or part event, the released lines not touched again",
    rep.replayed && (await bizPartEvents(A.b)) === evMid && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, cc.id)) === ccv + 1
      && (await partRow(cRes1.part.id)).v === Number(before[cRes1.part.id].v) + 1);
  ok("CXL9 a released line on the cancelled case cannot be reserved again (the case is finished)", /REFUSED|CASE_/.test(await code(() => pact(A, cRes1.part.id, { type: "RESERVE" }, Number(before[cRes1.part.id].v) + 1))) && (await reservedOf(cItem)) === 5);
  const plain = await openFIELD(A);
  await add(A, plain.id, { source: "NON_STOCK", name: "x", quantity: 1 });
  const ePlain = await bizPartEvents(A.b);
  ok("CXL10 a cancel with no RESERVED line writes no part event", (await act(A, plain.id, { type: "CANCEL" }, 1)).case.status === "CANCELLED" && (await bizPartEvents(A.b)) === ePlain);
  // a checked-in, diagnosing case (another starting status) releases the same way
  const dz = await diagnosing(A);
  const dzItem = await newItem(A, 1);
  const dzLine = await stockLine(A, dz.id, dzItem);
  await pact(A, dzLine.part.id, { type: "RESERVE" }, 1);
  const dzCx = await code(() => act(A, dz.id, { type: "CANCEL", reason: "הלקוח ביטל" }, dz.v));
  ok("CXL11 a case in DIAGNOSING cancelled → its reservation released (RESERVED → NEEDED), the unit free", dzCx === "OK" && (await partRow(dzLine.part.id)).s === "NEEDED" && (await reservedOf(dzItem)) === 0, dzCx);

  // ── 4. DBL — double use ─────────────────────────────────────────────────────────────────────────────────────
  console.log("DBL — no double use");
  const dItem = await newItem(A, 5);
  const dc = await openFIELD(A);
  const dl = await stockLine(A, dc.id, dItem);
  const dv = await pact(A, dl.part.id, { type: "RESERVE" }, 1);
  ok("DBL1 the same line RESERVED a second time (current version) → refused; still one RESERVED event, 1 unit reserved",
    (await code(() => pact(A, dl.part.id, { type: "RESERVE" }, dv.part.version))).startsWith("REFUSED")
      && (await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "partId" = $1 AND kind = 'RESERVED'`, dl.part.id)) === 1 && (await reservedOf(dItem)) === 1);
  const dl2 = await stockLine(A, dc.id, dItem);
  const twice = await Promise.all([code(() => pact(A, dl2.part.id, { type: "RESERVE" }, 1)), code(() => pact(A, dl2.part.id, { type: "RESERVE" }, 1))]);
  ok("DBL2 the same line reserved twice AT ONCE (two keys, one version) → exactly one OK, the other VERSION_CONFLICT; one RESERVED event, v2",
    twice.filter((r) => r === "OK").length === 1 && twice.includes("VERSION_CONFLICT") && (await partEvents(dl2.part.id)) === 2 && Number((await partRow(dl2.part.id)).v) === 2, JSON.stringify(twice));
  const pItem = await newItem(A, 3);
  const pLines = [];
  for (let i = 0; i < 6; i++) { const c = await openFIELD(A); pLines.push((await stockLine(A, c.id, pItem)).part.id); }
  const six = await Promise.all(pLines.map((id) => code(() => pact(A, id, { type: "RESERVE" }, 1))));
  ok("DBL3 six cases reserve 1 unit of an item with 3 on hand, all at once → exactly 3 OK and 3 PART_NOT_AVAILABLE; 3 reserved, never more",
    six.filter((r) => r === "OK").length === 3 && six.filter((r) => r.includes("PART_NOT_AVAILABLE")).length === 3 && (await reservedOf(pItem)) === 3, JSON.stringify(six));
  const fItem = await newItem(A, 10, "ML");
  const fc1 = await openFIELD(A), fc2 = await openFIELD(A);
  const f1 = await add(A, fc1.id, { source: "STOCK", inventoryItemId: fItem, name: "גז", quantity: 6 });
  const f2 = await add(A, fc2.id, { source: "STOCK", inventoryItemId: fItem, name: "גז", quantity: 6 });
  const ff = await Promise.all([code(() => pact(A, f1.part.id, { type: "RESERVE" }, 1)), code(() => pact(A, f2.part.id, { type: "RESERVE" }, 1))]);
  ok("DBL4 two 6 ML reservations of 10 ML at once → exactly one wins, 6 reserved", ff.filter((r) => r === "OK").length === 1 && (await reservedOf(fItem)) === 6, JSON.stringify(ff));
  // a reservation racing the case's cancel
  let raceOk = true; const raceLog: string[] = [];
  for (let i = 0; i < 3; i++) {
    const rItem2 = await newItem(A, 1);
    const rc = await openFIELD(A);
    const line = await stockLine(A, rc.id, rItem2);
    const rcv = Number((await caseRow(rc.id)).v);
    const [r, c] = await Promise.all([code(() => pact(A, line.part.id, { type: "RESERVE" }, 1)), code(() => act(A, rc.id, { type: "CANCEL", reason: "ביטול" }, rcv))]);
    const pr = await partRow(line.part.id), cr = await caseRow(rc.id);
    const evs = await q(`SELECT kind::text k FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq`, line.part.id);
    raceLog.push(`${r}/${c.slice(0, 40)}→${cr.s},${pr.s},v${pr.v},${evs.map((e) => e.k).join("+")}`);
    raceOk &&= c === "OK" && cr.s === "CANCELLED" && pr.s !== "RESERVED" && Number(pr.v) === evs.length
      && evs.filter((e) => e.k === "RESERVED").length === evs.filter((e) => e.k === "RELEASED").length && (await reservedOf(rItem2)) === 0;
  }
  ok("DBL5 RESERVE racing the case CANCEL (×3) → the cancel always wins the case; never a RESERVED line on a cancelled case; every RESERVED has its RELEASED; version = journal length", raceOk, raceLog.join(" | "));
  const idx = await q(`SELECT indexname i, indexdef d FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    ["ServicePart_issueMovementId_key", "ServicePart_returnMovementId_key", "ServicePartEvent_businessId_partId_seq_key", "ServicePartEvent_businessId_idempotencyKey_key"]);
  ok("DBL6 the database makes a movement single-use and the part journal single-entry: UNIQUE issueMovementId, returnMovementId, (businessId, partId, seq), (businessId, idempotencyKey)",
    idx.length === 4 && idx.every((r) => String(r.d).startsWith("CREATE UNIQUE INDEX")), JSON.stringify(idx.map((r) => r.i)));
  const dupSeq = await asRuntime(A.b, async (tx) => tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey")
    SELECT "businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, $2 FROM "ServicePartEvent" WHERE "partId" = $1 AND seq = 2`, dl.part.id, key()));
  ok("DBL7 the runtime role cannot write a second RESERVED event for a line (a copy of seq 2) — rejected by the UNIQUE (businessId, partId, seq), journal unchanged", /Unique constraint/.test(String(dupSeq)) && (await partEvents(dl.part.id)) === 2, String(dupSeq).slice(0, 120));
  const xd = await diagnosing(A);
  const xs = await Promise.all([code(() => send(A, xd.id, xd.v)), code(() => send(A, xd.id, xd.v))]);
  ok("DBL8 one case sent to a supplier twice at once → exactly one external work", xs.filter((r) => r === "OK").length === 1 && (await n(`SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "caseId" = $1`, xd.id)) === 1, JSON.stringify(xs));

  // ── 5. IDM — repeated actions / idempotency ─────────────────────────────────────────────────────────────────
  console.log("IDM — repeated actions");
  const iItem = await newItem(A, 5);
  const ic = await openFIELD(A);
  const il = await stockLine(A, ic.id, iItem);
  const il2 = await stockLine(A, ic.id, iItem);
  const kI = key();
  const first = await pact(A, il.part.id, { type: "RESERVE" }, 1, kI);
  const again = await pact(A, il.part.id, { type: "RESERVE" }, 1, kI);
  ok("IDM1 RESERVE replayed with its key → replayed, the same line and version, no second event, 1 reserved", again.replayed && !first.replayed && again.part.version === first.part.version
    && (await partEvents(il.part.id)) === 2 && (await reservedOf(iItem)) === 1);
  ok("IDM2 the same key with another body (RELEASE) → IDEMPOTENCY_KEY_REUSED, nothing written", (await code(() => pact(A, il.part.id, { type: "RELEASE" }, 2, kI))) === "IDEMPOTENCY_KEY_REUSED" && (await partEvents(il.part.id)) === 2);
  ok("IDM3 the same key on ANOTHER line (same action) → IDEMPOTENCY_KEY_REUSED, the other line untouched",
    (await code(() => pact(A, il2.part.id, { type: "RESERVE" }, 1, kI))) === "IDEMPOTENCY_KEY_REUSED" && (await partEvents(il2.part.id)) === 1);
  ok("IDM4 a stale expectedVersion → VERSION_CONFLICT, nothing written", (await code(() => pact(A, il.part.id, { type: "RELEASE" }, 1))) === "VERSION_CONFLICT" && (await partEvents(il.part.id)) === 2);
  const kP = key();
  const fivePar = await Promise.all(Array.from({ length: 5 }, () => pact(A, il2.part.id, { type: "RESERVE" }, 1, kP).then((r) => `${r.part.version}:${r.replayed}`, (e) => `E:${(e as ServiceDeskError).code ?? (e as Error).message}`)));
  ok("IDM5 one RESERVE key five times at once → one RESERVED event, every answer the same line at v2 (one fresh, the rest replays)",
    fivePar.every((r) => r.startsWith("2:")) && fivePar.filter((r) => r === "2:false").length === 1 && (await partEvents(il2.part.id)) === 2 && (await reservedOf(iItem)) === 2, JSON.stringify(fivePar));
  const kAdd = key();
  const ad1 = await add(A, ic.id, { source: "STOCK", inventoryItemId: iItem, name: "חלק", quantity: 1 }, kAdd);
  const ad2 = await add(A, ic.id, { source: "STOCK", inventoryItemId: iItem, name: "חלק", quantity: 1 }, kAdd);
  ok("IDM6 add replayed → the same line, one line; the key with another quantity → IDEMPOTENCY_KEY_REUSED",
    ad2.replayed && ad2.part.id === ad1.part.id && (await code(() => add(A, ic.id, { source: "STOCK", inventoryItemId: iItem, name: "חלק", quantity: 2 }, kAdd))) === "IDEMPOTENCY_KEY_REUSED"
      && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, ic.id)) === 3);
  const kPr = key();
  const sp = await pact(A, ad1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 700 }, 1, kPr);
  const sp2 = await pact(A, ad1.part.id, { type: "SET_PRICE", customerUnitPriceAgorot: 700 }, 1, kPr);
  ok("IDM7 SET_PRICE replayed → replayed (not PRICE_UNCHANGED), one PRICE_SET event", sp2.replayed && sp2.part.version === sp.part.version && (await partEvents(ad1.part.id)) === 2);
  // the cancel: replay vs another body
  const icv = Number((await caseRow(ic.id)).v);
  const kX = key();
  const cx1 = await act(A, ic.id, { type: "CANCEL", reason: "ביטול" }, icv, kX);
  const evAfter = await bizPartEvents(A.b);
  ok("IDM8 case CANCEL (with 2 reservations) replayed → replayed, no new release events; with another reason → IDEMPOTENCY_KEY_REUSED",
    cx1.case.status === "CANCELLED" && (await act(A, ic.id, { type: "CANCEL", reason: "ביטול" }, icv, kX)).replayed
      && (await code(() => act(A, ic.id, { type: "CANCEL", reason: "סיבה אחרת" }, icv, kX))) === "IDEMPOTENCY_KEY_REUSED" && (await bizPartEvents(A.b)) === evAfter && (await reservedOf(iItem)) === 0);
  // external work: action, return
  const wd = await diagnosing(A);
  const ws = await send(A, wd.id, wd.v);
  const kW = key();
  const w1 = await wact(A, ws.work.id, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 30000 }, 1, kW);
  const w2 = await wact(A, ws.work.id, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 30000 }, 1, kW);
  ok("IDM9 an external-work action replayed → replayed, one event; another amount with the key → IDEMPOTENCY_KEY_REUSED; a stale version → VERSION_CONFLICT",
    w2.replayed && w2.work.version === w1.work.version && (await workEvents(ws.work.id)) === 2
      && (await code(() => wact(A, ws.work.id, { type: "RECORD_COST", kind: "ESTIMATED", amountAgorot: 1 }, 1, kW))) === "IDEMPOTENCY_KEY_REUSED"
      && (await code(() => wact(A, ws.work.id, { type: "RECORD_COST", kind: "APPROVED", amountAgorot: 1 }, 1))) === "VERSION_CONFLICT" && (await workEvents(ws.work.id)) === 2);
  const kRt = key();
  const caseEvBefore = await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, wd.id);
  ok("IDM10 a return with a stale case version → VERSION_CONFLICT, nothing written", (await code(() => ret(A, ws.work.id, 2, ws.case.version - 1))) === "VERSION_CONFLICT" && (await workEvents(ws.work.id)) === 2);
  const rt1 = await ret(A, ws.work.id, 2, ws.case.version, {}, kRt);
  const rt2 = await code(() => ret(A, ws.work.id, 2, ws.case.version, {}, kRt));
  ok("IDM11 the return replayed with its key → answered from the journal, no second RETURNED event or case event; another body with the key → IDEMPOTENCY_KEY_REUSED",
    rt1.work.state === "RETURNED" && rt2 === "OK" && (await workEvents(ws.work.id)) === 3 && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, wd.id)) === caseEvBefore + 1
      && (await code(() => ret(A, ws.work.id, 2, ws.case.version, { finalCostAgorot: 5 }, kRt))) === "IDEMPOTENCY_KEY_REUSED", rt2);

  ok("END1 no InventoryMovement was written for either business by anything above", (await movements(A.b)) === movA0 && (await movements(B.b)) === movB0);

  // ── 6. RES+ / ISO+ — wrong reservations and cross-tenant keys (additions, PR #1116 test extension) ─────────────
  console.log("RES+ / ISO+ — wrong reservations, cross-tenant keys");
  {
    const big = await newItem(A, 3);
    const bc1 = await openFIELD(A);
    const over = await stockLine(A, bc1.id, big, 4);
    ok("RES9 one line asking for MORE than on hand (4 of 3) → RESERVE refused PART_NOT_AVAILABLE, still NEEDED v1, 0 reserved",
      (await code(() => pact(A, over.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE") && (await partRow(over.part.id)).s === "NEEDED" && (await reservedOf(big)) === 0);
    const zero = await newItem(A, 0);
    const zl = await stockLine(A, bc1.id, zero);
    ok("RES10 an item with 0 on hand → RESERVE refused PART_NOT_AVAILABLE, nothing written",
      (await code(() => pact(A, zl.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE") && (await partEvents(zl.part.id)) === 1);
    const cl = await stockLine(A, bc1.id, big);
    const clv = (await pact(A, cl.part.id, { type: "CANCEL", reason: "לא נדרש" }, 1)).part.version;
    const nl = await stockLine(A, bc1.id, big);
    const r10 = [await code(() => pact(A, cl.part.id, { type: "RESERVE" }, clv)), await code(() => pact(A, nl.part.id, { type: "RELEASE" }, 1))];
    ok("RES11 a CANCELLED line cannot be reserved, a NEEDED line cannot be released → REFUSED ×2, nothing written",
      r10.every((r) => r.startsWith("REFUSED")) && (await partEvents(cl.part.id)) === 2 && (await partEvents(nl.part.id)) === 1 && (await reservedOf(big)) === 0, JSON.stringify(r10));
    const rl = await stockLine(A, bc1.id, big, 2);
    const rv = await pact(A, rl.part.id, { type: "RESERVE" }, 1);
    const rc = await pact(A, rl.part.id, { type: "CANCEL", reason: "הלקוח ויתר" }, rv.part.version);
    ok("RES12 CANCEL of a RESERVED line → CANCELLED, the 2 units are free again (0 reserved), no movement",
      rc.part.state === "CANCELLED" && (await reservedOf(big)) === 0 && (await movements(A.b)) === movA0);
    // ISO+: a part-action key of A replayed by B on B's own line is B's own write
    const kShared = key();
    const aL = await stockLine(A, bc1.id, big);
    const bcase = await openFIELD(B);
    const bL = await stockLine(B, bcase.id, B.item2);
    const aR = await pact(A, aL.part.id, { type: "RESERVE" }, 1, kShared);
    const bR = await pact(B, bL.part.id, { type: "RESERVE" }, 1, kShared);
    ok("ISO15 A's RESERVE Idempotency-Key used by B on B's line → B's own fresh reservation (not a replay, not A's line), A untouched",
      !aR.replayed && !bR.replayed && bR.part.id === bL.part.id && bR.part.state === "RESERVED" && (await partRow(aL.part.id)).s === "RESERVED" && Number((await partRow(aL.part.id)).v) === 2);
    // two businesses reserving at the same moment never block or count each other
    const ia = await newItem(A, 1), ib = await newItem(B, 1);
    const ca = await openFIELD(A), cb = await openFIELD(B);
    const la = await stockLine(A, ca.id, ia), lb = await stockLine(B, cb.id, ib);
    const both = await Promise.all([code(() => pact(A, la.part.id, { type: "RESERVE" }, 1)), code(() => pact(B, lb.part.id, { type: "RESERVE" }, 1))]);
    ok("ISO16 A and B each reserve the last unit of their own item at the same moment → both OK (no cross-tenant counting or blocking)",
      both.every((r) => r === "OK") && (await reservedOf(ia)) === 1 && (await reservedOf(ib)) === 1, JSON.stringify(both));
  }

  // ── 7. PAR — parallel requests on the same line / case (separate pooled connections, Promise.all) ──────────
  console.log("PAR — parallel requests");
  /** The line agrees with its journal: version = number of events = last seq; lastEventKind / state = the last event's. */
  const journalOk = async (partId: number) => {
    const p = await partRow(partId);
    const evs = await q(`SELECT seq, kind::text k, "stateAfter"::text sa FROM "ServicePartEvent" WHERE "partId" = $1 ORDER BY seq`, partId);
    const last = evs[evs.length - 1];
    return evs.length === Number(p.v) && evs.every((e, i) => Number(e.seq) === i + 1) && last.k === p.k && last.sa === p.s;
  };
  {
    const it1 = await newItem(A, 3);
    let par1 = true; const log1: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await openFIELD(A);
      const l = await stockLine(A, c.id, it1);
      const rs = await Promise.all([code(() => pact(A, l.part.id, { type: "RESERVE" }, 1)), code(() => pact(A, l.part.id, { type: "CANCEL", reason: "x" }, 1))]);
      const pr = await partRow(l.part.id);
      log1.push(`${rs.join("/")}→${pr.s}v${pr.v}`);
      par1 &&= rs.filter((r) => r === "OK").length === 1 && rs.includes("VERSION_CONFLICT") && Number(pr.v) === 2 && (await journalOk(l.part.id));
    }
    ok("PAR1 RESERVE and CANCEL of the same NEEDED line at once (×3) → exactly one wins, the other VERSION_CONFLICT; the line = its journal (v2)",
      par1 && (await reservedOf(it1)) <= 3, log1.join(" | "));
    const it2 = await newItem(A, 3);
    let par2 = true; const log2: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await openFIELD(A);
      const l = await stockLine(A, c.id, it2);
      const v = (await pact(A, l.part.id, { type: "RESERVE" }, 1)).part.version;
      const rs = await Promise.all([code(() => pact(A, l.part.id, { type: "RELEASE" }, v)), code(() => pact(A, l.part.id, { type: "CANCEL", reason: "x" }, v))]);
      const pr = await partRow(l.part.id);
      log2.push(`${rs.join("/")}→${pr.s}v${pr.v}`);
      par2 &&= rs.filter((r) => r === "OK").length === 1 && rs.includes("VERSION_CONFLICT") && Number(pr.v) === 3 && pr.s !== "RESERVED" && (await journalOk(l.part.id));
    }
    ok("PAR2 RELEASE and CANCEL of the same RESERVED line at once (×3) → exactly one wins, the other VERSION_CONFLICT; never still RESERVED; the line = its journal; the units free",
      par2 && (await reservedOf(it2)) === 0, log2.join(" | "));
    let par3 = true; const log3: string[] = [];
    for (let i = 0; i < 3; i++) {
      const i1 = await newItem(A, 2), i2 = await newItem(A, 2);
      const c = await openFIELD(A);
      const l1 = await stockLine(A, c.id, i1), l2 = await stockLine(A, c.id, i2);
      await pact(A, l1.part.id, { type: "RESERVE" }, 1); await pact(A, l2.part.id, { type: "RESERVE" }, 1);
      const cv = Number((await caseRow(c.id)).v);
      const rs = await Promise.all([code(() => act(A, c.id, { type: "CANCEL", reason: "ביטול א" }, cv)), code(() => act(A, c.id, { type: "CANCEL", reason: "ביטול ב" }, cv))]);
      const rel = await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "caseId" = $1 AND kind = 'RELEASED'`, c.id);
      const cancels = await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND "toStatus" = 'CANCELLED'`, c.id);
      log3.push(`${rs.map((r) => r.slice(0, 30)).join("/")}→rel${rel},cx${cancels}`);
      par3 &&= rs.filter((r) => r === "OK").length === 1 && (await caseRow(c.id)).s === "CANCELLED" && rel === 2 && cancels === 1
        && (await journalOk(l1.part.id)) && (await journalOk(l2.part.id)) && (await reservedOf(i1)) === 0 && (await reservedOf(i2)) === 0;
    }
    ok("PAR3 two different CANCEL requests of one case with 2 reservations at once (×3) → one wins; each line released exactly once; one CANCELLED case event",
      par3, log3.join(" | "));
    let par4 = true; const log4: string[] = [];
    for (let i = 0; i < 4; i++) {
      const i1 = await newItem(A, 1);
      const c = await openFIELD(A);
      const l1 = await stockLine(A, c.id, i1);
      const v = (await pact(A, l1.part.id, { type: "RESERVE" }, 1)).part.version;
      const cv = Number((await caseRow(c.id)).v);
      const rs = await Promise.all([code(() => act(A, c.id, { type: "CANCEL", reason: "ביטול" }, cv)), code(() => pact(A, l1.part.id, { type: "RELEASE" }, v))]);
      const rel = await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "partId" = $1 AND kind = 'RELEASED'`, l1.part.id);
      const pr = await partRow(l1.part.id);
      log4.push(`${rs.map((r) => r.slice(0, 25)).join("/")}→${pr.s},rel${rel}`);
      par4 &&= rs[0] === "OK" && (await caseRow(c.id)).s === "CANCELLED" && pr.s === "NEEDED" && rel === 1 && (await journalOk(l1.part.id)) && (await reservedOf(i1)) === 0;
    }
    ok("PAR4 case CANCEL racing a RELEASE of its reserved line (×4) → the cancel always succeeds; the line released exactly once (one RELEASED event), NEEDED, consistent",
      par4, log4.join(" | "));
    const sItem = await newItem(A, 4);
    const held: { id: number; v: number }[] = [];
    for (let i = 0; i < 2; i++) { const c = await openFIELD(A); const l = await stockLine(A, c.id, sItem); held.push({ id: l.part.id, v: (await pact(A, l.part.id, { type: "RESERVE" }, 1)).part.version }); }
    const fresh: number[] = [];
    for (let i = 0; i < 8; i++) { const c = await openFIELD(A); fresh.push((await stockLine(A, c.id, sItem)).part.id); }
    const storm = await Promise.all([
      ...fresh.map((id) => code(() => pact(A, id, { type: "RESERVE" }, 1))),
      ...held.map((h) => code(() => pact(A, h.id, { type: "RELEASE" }, h.v))),
    ]);
    const okRes = storm.slice(0, 8).filter((r) => r === "OK").length;
    const consistent = (await Promise.all([...fresh, ...held.map((h) => h.id)].map(journalOk))).every(Boolean);
    ok("PAR5 8 RESERVEs and 2 RELEASEs of one item (4 on hand, 2 held) at once → both releases OK, 2..4 reserves win, the rest PART_NOT_AVAILABLE; reserved = the winners, never above 4; every line = its journal",
      storm.slice(8).every((r) => r === "OK") && okRes >= 2 && okRes <= 4 && storm.slice(0, 8).every((r) => r === "OK" || r.includes("PART_NOT_AVAILABLE"))
        && (await reservedOf(sItem)) === okRes && consistent, JSON.stringify(storm));
    const kA = key();
    const pc = await openFIELD(A);
    const adds = await Promise.all(Array.from({ length: 4 }, () => add(A, pc.id, { source: "STOCK", inventoryItemId: sItem, name: "חלק", quantity: 1 }, kA)
      .then((r) => `${r.part.id}:${r.replayed}`, (e) => `E:${(e as ServiceDeskError).code ?? (e as Error).message}`)));
    ok("PAR6 one add Idempotency-Key four times at once → one line, one ADDED event; every answer names that line (one fresh, three replays)",
      new Set(adds.map((r) => r.split(":")[0])).size === 1 && adds.filter((r) => r.endsWith(":false")).length === 1
        && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, pc.id)) === 1 && (await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "idempotencyKey" = $1`, kA)) === 1, JSON.stringify(adds));
    const wd = await diagnosing(A);
    const ws = await send(A, wd.id, wd.v);
    const rr = await Promise.all([code(() => ret(A, ws.work.id, 1, ws.case.version)), code(() => ret(A, ws.work.id, 1, ws.case.version))]);
    ok("PAR7 two returns (two keys) of the same external work at once → exactly one wins, the other VERSION_CONFLICT; one RETURNED event, one case event for it",
      rr.filter((r) => r === "OK").length === 1 && rr.includes("VERSION_CONFLICT") && (await n(`SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "workId" = $1 AND kind = 'RETURNED'`, ws.work.id)) === 1
        && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, wd.id)) === ws.case.version + 1, JSON.stringify(rr));
  }

  // ── 8. FAIL — a failure in the middle of an operation rolls everything back ─────────────────────────────────
  // A temporary trigger (lab only, created and dropped here by the lab owner) raises AFTER the operation's first writes
  // are already done inside its transaction; the answer must be an error and the database exactly as before.
  console.log("FAIL — failure mid-operation");
  {
    await x(`CREATE OR REPLACE FUNCTION public.u16b_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'U16B_INJECTED_FAILURE on %', TG_TABLE_NAME; END $f$`);
    const inject = (table: string, when: string) => x(`CREATE TRIGGER u16b_fail AFTER INSERT ON "${table}" FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.u16b_inject_failure()`);
    const clear = (table: string) => x(`DROP TRIGGER IF EXISTS u16b_fail ON "${table}"`);
    const injected = (r: string) => r.includes("U16B_INJECTED_FAILURE");
    try {
      const fItem = await newItem(A, 3);
      const fBefore = await itemRow(fItem);
      const mov0 = await movements(A.b);
      const fc = await openFIELD(A);
      await inject("ServicePartEvent", `NEW."caseId" = ${fc.id}`);
      const kAdd = key();
      const f1 = await code(() => add(A, fc.id, { source: "STOCK", inventoryItemId: fItem, name: "חלק", quantity: 1 }, kAdd));
      const linesAfter = await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, fc.id);
      await clear("ServicePartEvent");
      const f1b = await add(A, fc.id, { source: "STOCK", inventoryItemId: fItem, name: "חלק", quantity: 1 }, kAdd);
      ok("FAIL1 add: the ADDED event fails after the line was inserted → error, NO line, no event; the same key afterwards → a fresh line (the failed try left no ledger entry)",
        injected(f1) && linesAfter === 0 && !f1b.replayed && (await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "caseId" = $1`, fc.id)) === 1, f1);
      const fl = f1b.part.id;
      const snap2 = JSON.stringify(await partRow(fl));
      await inject("ServicePartEvent", `NEW."partId" = ${fl} AND NEW.kind = 'RESERVED'`);
      const kR = key();
      const f2 = await code(() => pact(A, fl, { type: "RESERVE" }, 1, kR));
      const after2 = JSON.stringify(await partRow(fl));
      const ev2 = await partEvents(fl), res2 = await reservedOf(fItem);
      await clear("ServicePartEvent");
      const f2b = await pact(A, fl, { type: "RESERVE" }, 1, kR);
      ok("FAIL2 RESERVE: the RESERVED event fails after the line was set RESERVED → error; the line byte-for-byte NEEDED v1, 1 event, 0 reserved; the same key afterwards reserves fresh (v2)",
        injected(f2) && after2 === snap2 && ev2 === 1 && res2 === 0 && !f2b.replayed && f2b.part.version === 2 && (await partEvents(fl)) === 2, f2);
      const i1 = await newItem(A, 2), i2 = await newItem(A, 2);
      const cc = await openFIELD(A);
      const l1 = await stockLine(A, cc.id, i1), l2 = await stockLine(A, cc.id, i2);
      await pact(A, l1.part.id, { type: "RESERVE" }, 1); await pact(A, l2.part.id, { type: "RESERVE" }, 1);
      const snapC = async () => JSON.stringify([await caseRow(cc.id), await partRow(l1.part.id), await partRow(l2.part.id),
        await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "caseId" = $1`, cc.id), await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, cc.id),
        await reservedOf(i1), await reservedOf(i2), await itemRow(i1), await itemRow(i2)]);
      const c0 = await snapC();
      const ccv = Number((await caseRow(cc.id)).v);
      const kC = key();
      await inject("ServicePartEvent", `NEW."partId" = ${Math.max(l1.part.id, l2.part.id)} AND NEW.kind = 'RELEASED'`);
      const f3 = await code(() => act(A, cc.id, { type: "CANCEL", reason: "ביטול" }, ccv, kC));
      const c3 = await snapC();
      await clear("ServicePartEvent");
      ok("FAIL3 case CANCEL: the first line's release is written, the second's event fails → error; the case, BOTH lines (still RESERVED), both journals, the case journal and the items exactly as before",
        injected(f3) && c3 === c0, `${f3} | ${c0} | ${c3}`);
      await inject("ServiceCaseEvent", `NEW."caseId" = ${cc.id}`);
      const f4 = await code(() => act(A, cc.id, { type: "CANCEL", reason: "ביטול" }, ccv, kC));
      const c4 = await snapC();
      await clear("ServiceCaseEvent");
      ok("FAIL4 case CANCEL: both releases and the case row written, the case event (the last write) fails → error; everything exactly as before (no released line, no RELEASED event, the case not cancelled)",
        injected(f4) && c4 === c0, `${f4} | ${c4}`);
      const f5 = await act(A, cc.id, { type: "CANCEL", reason: "ביטול" }, ccv, kC);
      ok("FAIL5 the same cancel key once the failure is gone → a fresh cancel (not a replay): CANCELLED, each line released exactly once, 0 reserved",
        !f5.replayed && f5.case.status === "CANCELLED" && (await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "caseId" = $1 AND kind = 'RELEASED'`, cc.id)) === 2
          && (await reservedOf(i1)) === 0 && (await reservedOf(i2)) === 0 && (await journalOk(l1.part.id)) && (await journalOk(l2.part.id)));
      const sd = await diagnosing(A);
      const sSnap = async () => JSON.stringify([await caseRow(sd.id), await n(`SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE "caseId" = $1`, sd.id),
        await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, sd.id)]);
      const s0 = await sSnap();
      await inject("ServiceExternalWorkEvent", `NEW."caseId" = ${sd.id}`);
      const f6 = await code(() => send(A, sd.id, sd.v));
      const s6 = await sSnap();
      await clear("ServiceExternalWorkEvent");
      ok("FAIL6 send to a supplier: case → EXTERNAL, its event and the work row written, the work's SENT event fails → error; the case (status, version), works and case journal exactly as before",
        injected(f6) && s6 === s0, `${f6} | ${s0} | ${s6}`);
      const sw = await send(A, sd.id, sd.v);
      const rSnap = async () => JSON.stringify([await caseRow(sd.id), (await q(`SELECT state::text s, version v FROM "ServiceExternalWork" WHERE id = $1`, sw.work.id))[0], await workEvents(sw.work.id),
        await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, sd.id)]);
      const r0 = await rSnap();
      await inject("ServiceCaseEvent", `NEW."caseId" = ${sd.id}`);
      const f7 = await code(() => ret(A, sw.work.id, 1, sw.case.version));
      const r7 = await rSnap();
      await clear("ServiceCaseEvent");
      ok("FAIL7 return from the supplier: the work (RETURNED) and the case row written, the case event fails → error; the work still AT_SUPPLIER, the case and both journals exactly as before",
        injected(f7) && r7 === r0 && r0.includes("AT_SUPPLIER"), `${f7} | ${r0} | ${r7}`);
      ok("FAIL8 no failed operation left an inventory trace: the item row unchanged, no InventoryMovement",
        (await itemRow(fItem)) === fBefore && (await movements(A.b)) === mov0);
    } finally {
      for (const tb of ["ServicePartEvent", "ServiceCaseEvent", "ServiceExternalWorkEvent"]) await clear(tb);
      await x(`DROP FUNCTION IF EXISTS public.u16b_inject_failure()`);
    }
    ok("FAIL9 the injected triggers and their function are gone (the lab is left as the migrations built it)",
      (await n(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'u16b_fail'`)) === 0 && (await n(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'u16b_inject_failure'`)) === 0);
  }

  // ── 9. INV — consistency with the inventory ──────────────────────────────────────────────────────────────────
  console.log("INV — inventory consistency");
  {
    let ownerMovements = 0; // movements this section writes itself, as the inventory module would (never the parts service)
    const vItem = await newItem(A, 4);
    const vc = await openFIELD(A);
    const vl = await stockLine(A, vc.id, vItem, 2);
    const vv = (await pact(A, vl.part.id, { type: "RESERVE" }, 1)).part.version;
    const vRow0 = JSON.stringify(await partRow(vl.part.id));
    const vBefore = [vRow0, await itemRow(vItem), await movements(A.b), await partEvents(vl.part.id)].join("|");
    const moving = ["ISSUE", "RETURN", "INSTALL", "WRITE_OFF", "SEND_WITH_EXTERNAL", "RESOLVE_FROM_EXTERNAL", "CORRECT_COST", "MARK_ON_ORDER", "UPDATE_ORDER", "RECORD_QUOTED"];
    const inv1 = await Promise.all(moving.map((type) => code(() => pact(A, vl.part.id, { type }, vv))));
    ok("INV1 every action that would move stock or needs an issued line (ISSUE, RETURN, INSTALL, WRITE_OFF, SEND/RESOLVE external, CORRECT_COST, orders, quoted) → ACTION_NOT_IN_SCOPE; line, item, movements, journal unchanged",
      inv1.every((r) => r.startsWith("ACTION_NOT_IN_SCOPE")) && [JSON.stringify(await partRow(vl.part.id)), await itemRow(vItem), await movements(A.b), await partEvents(vl.part.id)].join("|") === vBefore, JSON.stringify(inv1));
    const labels = (await q(`SELECT e.enumlabel l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'InventoryMovementReason'`)).map((r) => String(r.l));
    ok("INV2 the inventory has no SERVICE_PART movement reason yet (M0 not applied), so no OUT movement can satisfy a part issue — a STOCK line cannot reach ISSUED today (no double issue possible)",
      labels.length > 0 && !labels.includes("SERVICE_PART"), JSON.stringify(labels));
    const sale = Number((await q(`INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", reason, "quantityDelta", "quantityBefore", "quantityAfter", note)
      VALUES ($1, $2, 'OUT', 'SALE', -2, 4, 2, 'u16b sim') RETURNING id`, A.b, vItem))[0].id);
    ownerMovements++;
    const fakeIssue = (movement: number | null) => asRuntime(A.b, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'ISSUED', "issueMovementId" = $2, "unitCostAgorot" = 100, "costSource" = 'MANUAL', version = version + 1, "lastEventKind" = 'ISSUED', "updatedAt" = now() WHERE id = $1`, vl.part.id, movement);
      await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey", "movementId")
        VALUES ($1, $2, $3, $4, 'ISSUED', 'RESERVED', 'ISSUED', 2, 'OWNER_USER', $5, '{}'::jsonb, $6, $7)`, A.b, vl.part.id, vc.id, vv + 1, A.u, key(), movement);
      return "COMMITTED";
    });
    const fi1 = await fakeIssue(sale);
    const fi2 = await fakeIssue(null);
    ok("INV3 the runtime role issuing a line against a real OUT movement of the same item and quantity that is NOT a service-part issue (a SALE) → SERVICE_PART_MOVEMENT_MISMATCH; with no movement → SERVICE_PART_ISSUE; the line unchanged",
      /SERVICE_PART_MOVEMENT_MISMATCH/.test(String(fi1)) && /SERVICE_PART_ISSUE/.test(String(fi2)) && JSON.stringify(await partRow(vl.part.id)) === vRow0, `${String(fi1).slice(0, 100)} | ${String(fi2).slice(0, 100)}`);
    const silent = await asRuntime(A.b, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'NEEDED', version = version + 1, "lastEventKind" = 'RELEASED', "updatedAt" = now() WHERE id = $1`, vl.part.id);
      return "COMMITTED";
    });
    ok("INV4 the runtime role releasing a line WITHOUT its journal event → refused at COMMIT (SERVICE_PART_SILENT_CHANGE); the line still RESERVED, 2 reserved",
      /SERVICE_PART_SILENT_CHANGE/.test(String(silent)) && JSON.stringify(await partRow(vl.part.id)) === vRow0 && (await reservedOf(vItem)) === 2, String(silent).slice(0, 120));
    // the inventory sells under a soft reservation (simulated as the inventory module: its movements + its quantity)
    await x(`INSERT INTO "InventoryMovement" ("businessId", "itemId", "movementType", reason, "quantityDelta", "quantityBefore", "quantityAfter", note) VALUES ($1, $2, 'OUT', 'SALE', -1, 2, 1, 'u16b sim')`, A.b, vItem);
    ownerMovements++;
    await x(`UPDATE "InventoryItem" SET "currentQuantity" = 1, "updatedAt" = now() WHERE id = $1`, vItem);
    const vc2 = await openFIELD(A);
    const vl2 = await stockLine(A, vc2.id, vItem, 1);
    ok("INV5 the till sold below the soft reservation (on hand 1, 2 reserved): the reservation stays RESERVED (soft, M1), a new reservation of 1 is refused PART_NOT_AVAILABLE, the item still 1 (parts wrote nothing to it)",
      (await partRow(vl.part.id)).s === "RESERVED" && (await code(() => pact(A, vl2.part.id, { type: "RESERVE" }, 1))).includes("PART_NOT_AVAILABLE")
        && Number((await q(`SELECT "currentQuantity" q FROM "InventoryItem" WHERE id = $1`, vItem))[0].q) === 1);
    await pact(A, vl.part.id, { type: "RELEASE" }, vv);
    ok("INV6 after the over-reserved line is released, the 1 unit left can be reserved by the other case (available = on hand − other reservations)",
      (await pact(A, vl2.part.id, { type: "RESERVE" }, 1)).part.state === "RESERVED" && (await reservedOf(vItem)) === 1);
    const over = await q(`SELECT i.id, i."currentQuantity" q, COALESCE(sum(p.quantity) FILTER (WHERE p.state = 'RESERVED'), 0)::float8 r
      FROM "InventoryItem" i LEFT JOIN "ServicePart" p ON p."inventoryItemId" = i.id WHERE i."businessId" = ANY($1::int[])
      GROUP BY i.id HAVING COALESCE(sum(p.quantity) FILTER (WHERE p.state = 'RESERVED'), 0) > i."currentQuantity" + 1e-9`, [A.b, B.b]);
    ok("INV7 for every item of both businesses the RESERVED quantity is within on hand after everything above (no over-reservation through the service)",
      over.length === 0, JSON.stringify(over));
    const left = await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "businessId" = ANY($1::int[]) AND (state IN ('ISSUED','INSTALLED','RETURNED','WRITTEN_OFF') OR "issueMovementId" IS NOT NULL OR "returnMovementId" IS NOT NULL)`, [A.b, B.b]);
    ok("INV8 no part line of either business left the stock or links a movement (0 ISSUED / INSTALLED / RETURNED / WRITTEN_OFF, 0 links); the only new movements are the 2 this section wrote as the inventory",
      left === 0 && (await movements(A.b)) === movA0 + ownerMovements && (await movements(B.b)) === movB0);
    const bad = await q(`SELECT p.id FROM "ServicePart" p WHERE p."businessId" = ANY($1::int[]) AND (p.version <> (SELECT count(*) FROM "ServicePartEvent" e WHERE e."partId" = p.id)
      OR p."lastEventKind" <> (SELECT e.kind FROM "ServicePartEvent" e WHERE e."partId" = p.id ORDER BY seq DESC LIMIT 1)
      OR p.state <> (SELECT e."stateAfter" FROM "ServicePartEvent" e WHERE e."partId" = p.id ORDER BY seq DESC LIMIT 1))`, [A.b, B.b]);
    ok("INV9 every part line of both businesses equals its journal (version = events, last kind and state = the last event's)", bad.length === 0, JSON.stringify(bad));
    const cxRes = await q(`SELECT p.id FROM "ServicePart" p JOIN "ServiceCase" c ON c.id = p."caseId" WHERE p."businessId" = ANY($1::int[]) AND c.status IN ('CANCELLED','CLOSED') AND p.state = 'RESERVED'`, [A.b, B.b]);
    ok("INV10 no cancelled or closed case of either business holds a RESERVED line after everything above (the app rule; see the GAP probe for the database)", cxRes.length === 0, JSON.stringify(cxRes));
  }

  // ── GAP probe (informational, not counted): does the database alone stop a RESERVED line on a CANCELLED case? ──
  {
    const gItem = await newItem(A, 1);
    const gc = await openFIELD(A);
    const gl = await stockLine(A, gc.id, gItem);
    await act(A, gc.id, { type: "CANCEL", reason: "בדיקה" }, Number((await caseRow(gc.id)).v));
    const g = await asRuntime(A.b, async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "ServicePart" SET state = 'RESERVED', version = 2, "lastEventKind" = 'RESERVED', "updatedAt" = now() WHERE id = $1`, gl.part.id);
      await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey")
        VALUES ($1, $2, $3, 2, 'RESERVED', 'NEEDED', 'RESERVED', 1, 'OWNER_USER', $4, '{}'::jsonb, $5)`, A.b, gl.part.id, gc.id, A.u, key());
      return "COMMITTED";
    });
    console.log(`  [GAP] the runtime role writing RESERVED (with a matching event) on a CANCELLED case's line, bypassing the service: ${String(g).slice(0, 140)}`
      + (g === "COMMITTED" ? " — the database ACCEPTS it today (app-only rule; a DB guard is pending in a separate PR)" : " — refused by the database"));
    if (g === "COMMITTED") await pact(A, gl.part.id, { type: "CANCEL", reason: "ניקוי בדיקה" }, 2); // leave no RESERVED line on a cancelled case
  }

  console.log("\nper section: " + Object.entries(tally).map(([s, [p, f]]) => `${s} ${p}/${p + f}`).join(", "));
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); console.log(`\n${pass} passed, ${failures.length} failed`); })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); process.exit(failures.length ? 1 : 0); });
