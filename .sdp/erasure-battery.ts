/**
 * Service Desk spare parts M2 PR-2 — account erasure of the part lines through the REAL adapter, as the runtime role
 * (.sdp/lab.sh --with-m2, then .sdf/erasure-prereq.sh).
 *
 * `prismaAccountDeletionStore.purgeOperationalData()` is the code account deletion runs. It calls
 * public.service_parts_erase_business() inside its purge transaction, next to service_external_erase_business()
 * (declared in DB_FUNCTION_ERASURES, proven statically by the erasure contract). This battery proves the same path
 * end to end on PostgreSQL, with the M2 migration applied as Production has it (guards, triggers, RLS, grants):
 *
 *   P1. a business that is not being deleted: the purge refuses and nothing changes;
 *   P2. the function cannot run (EXECUTE revoked) / is missing (renamed): the whole purge rolls back —
 *       users, staff, the 1.2a / 1.2b rows and the part lines exactly as before;
 *   P3. a business being deleted (M2-3): a hand-typed name → the fixed text and its sku → NULL (NON_STOCK and supplier
 *       parts); a name / sku copied from the inventory item kept; reason, note and the creating user cleared; in the
 *       journal the actors, digests and reasons cleared; erasedAt stamped; no row removed; states, quantities, costs,
 *       prices, links and versions stay;
 *   P4. another business's part lines and journal are untouched;
 *   P5. the runtime still holds no DELETE on either M2 table; a second purge changes nothing;
 *   P6. regression: the 1.2a / 1.2b erasures and the user / staff erasures ran in the same purge.
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
const ikey = (tag: string) => `sdp-erase-${tag}-${String(++keySeq).padStart(4, "0")}`;

async function business(name: string) {
  const biz = Number((await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name)).id);
  const user = Number((await one(`INSERT INTO "User" (email, name, "businessId", "updatedAt") VALUES ($1, 'בעל עסק', $2, now()) RETURNING id`, `${name}@lab.invalid`, biz)).id);
  const cust = Number((await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz)).id);
  const staff = Number((await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאית דנה', now()) RETURNING id`, biz)).id);
  const supplier = Number((await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz)).id);
  const item = Number((await one(`INSERT INTO "InventoryItem" ("businessId", name, "unitType", "currentQuantity", "updatedAt") VALUES ($1, 'מסך iPhone 14', 'UNIT', 10, now()) RETURNING id`, biz)).id);
  return { biz, user, cust, staff, supplier, item };
}
type B = Awaited<ReturnType<typeof business>>;

async function openCase(tx: Tx, b: B, number: number, tag: string) {
  const kase = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "staffMemberId", "problemDescription", "updatedAt")
    VALUES ($1, $2, 'IN_SHOP', $3, $4, 'המסך לא נדלק ${tag}', now()) RETURNING id`, b.biz, number, b.cust, b.staff)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, b.biz, kase, b.user, ikey(tag));
  return kase;
}

/** A part line with its ADDED event (an acting user and a request digest on it). */
async function addPart(tx: Tx, b: B, kase: number, o: { source: "STOCK" | "NON_STOCK"; name: string; sku: string | null; note?: string }, tag: string) {
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "inventoryItemId", "nameSnapshot", "skuSnapshot", quantity, "unitType", note, "lastEventKind", "createdByUserId", "updatedAt")
    VALUES ($1, $2, $3::"ServicePartSource", 'NEEDED', $4, $5, $6, 1, 'UNIT', $7, 'ADDED', $8, now()) RETURNING id`,
    b.biz, kase, o.source, o.source === "STOCK" ? b.item : null, o.name, o.sku, o.note ?? null, b.user)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
    VALUES ($1, $2, $3, 1, 'ADDED', NULL, 'NEEDED', 1, 'OWNER_USER', $4, '{"source":"${o.source}"}', $5, $6, 'k1')`, b.biz, id, kase, b.user, ikey(tag), H("d"));
  return id;
}

/** Cancel a part line with a reason (row + its CANCELLED event), as a service step writes it. */
async function cancelPart(tx: Tx, b: B, partId: number, reason: string, tag: string) {
  const r = ((await tx.$queryRawUnsafe(`UPDATE "ServicePart" SET state = 'CANCELLED', "lastEventKind" = 'CANCELLED', reason = $2, "closedAt" = now(), version = version + 1, "updatedAt" = now()
    WHERE id = $1 RETURNING version, "caseId"`, partId, reason)) as Rows)[0];
  await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateBefore", "stateAfter", quantity, reason, actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, 'CANCELLED', 'NEEDED', 'CANCELLED', 1, $5, 'OWNER_USER', $6, '{}', $7)`, b.biz, partId, r.caseId, Number(r.version), reason, b.user, ikey(tag));
}

/** One business's part lines, written as the runtime in its tenant context. */
async function partsData(b: B, tag: string) {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${b.biz}', true)`);
    const c1 = await openCase(tx, b, 1, tag);
    const handTyped = await addPart(tx, b, c1, { source: "NON_STOCK", name: `בורג של דני כהן ${tag}`, sku: `DANI-050-${tag}`, note: `להתקשר לדני ${tag}` }, tag);
    const stock = await addPart(tx, b, c1, { source: "STOCK", name: "מסך iPhone 14", sku: "SCR-IP14" }, tag);
    await cancelPart(tx, b, stock, `הלקוח דני ויתר ${tag}`, tag);
    // A supplier's part: the case went to the external supplier, the part came back installed with the work.
    const c2 = await openCase(tx, b, 2, tag);
    await tx.$executeRawUnsafe(`UPDATE "ServiceCase" SET status = 'EXTERNAL', version = version + 1, "updatedAt" = now() WHERE id = $1`, c2);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, payload, "idempotencyKey")
      VALUES ($1, $2, 2, 'external.sent', 'SEND_TO_EXTERNAL', 'OPEN', 'EXTERNAL', false, false, 'SYSTEM', '{}', $3)`, b.biz, c2, ikey(tag));
    const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "updatedAt")
      VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד ${tag}', now()) RETURNING id`, b.biz, c2, b.supplier, b.user)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'SENT', 'SENT', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, c2, b.user, ikey(tag));
    const supplierPart = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServicePart" ("businessId", "caseId", source, state, "nameSnapshot", quantity, "externalWorkId", "costIncludedInExternal", "lastEventKind", "createdByUserId", "closedAt", "updatedAt")
      VALUES ($1, $2, 'SUPPLIER', 'INSTALLED', 'סוללה מהספק של דני ${tag}', 1, $3, true, 'SUPPLIER_PART_RECORDED', $4, now(), now()) RETURNING id`, b.biz, c2, w, b.user)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServicePartEvent" ("businessId", "partId", "caseId", seq, kind, "stateAfter", quantity, actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'SUPPLIER_PART_RECORDED', 'INSTALLED', 1, 'OWNER_USER', $4, '{}', $5)`, b.biz, supplierPart, c2, b.user, ikey(tag));
    return { c1, c2, w, handTyped, stock, supplierPart };
  });
}

/** Everything erasure may touch, as one comparable snapshot (owner view, all rows). */
async function snapshot(biz: number) {
  return JSON.stringify(await q(`SELECT
      (SELECT json_agg(json_build_object('e', email, 'n', name) ORDER BY id) FROM "User" WHERE "businessId" = $1) AS users,
      (SELECT json_agg("displayName" ORDER BY id) FROM "StaffMember" WHERE "businessId" = $1) AS staff,
      (SELECT json_agg(row_to_json(c) ORDER BY id) FROM "ServiceCase" c WHERE "businessId" = $1) AS cases,
      (SELECT json_agg(row_to_json(w) ORDER BY id) FROM "ServiceExternalWork" w WHERE "businessId" = $1) AS works,
      (SELECT json_agg(row_to_json(p) ORDER BY id) FROM "ServicePart" p WHERE "businessId" = $1) AS parts,
      (SELECT json_agg(row_to_json(j) ORDER BY id) FROM "ServicePartEvent" j WHERE "businessId" = $1) AS journal`, biz));
}

async function main() {
  const X = await business("sdp-erase-x"), Y = await business("sdp-erase-y");
  const xs = await partsData(X, "x");
  await partsData(Y, "y");
  ok("0.1 synthetic part lines for two businesses (hand-typed, from stock, from the supplier), written as the runtime",
    await n(`SELECT count(*)::int AS n FROM "ServicePart" WHERE "businessId" IN ($1, $2)`, X.biz, Y.biz) === 6
    && await n(`SELECT count(*)::int AS n FROM "ServicePartEvent" WHERE "businessId" = $1`, X.biz) === 4);

  // P1 — not being deleted
  const before = await snapshot(X.biz);
  const p1 = await purge(X.biz);
  ok("P1 a business that is not being deleted: the purge refuses", p1 !== null, String(p1));
  ok("P1 … and nothing changed (users, staff, cases, works, parts, journal)", (await snapshot(X.biz)) === before);

  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, X.biz);

  // P2 — the M2 function cannot run, or is missing: the WHOLE purge rolls back
  await x(`REVOKE EXECUTE ON FUNCTION public.service_parts_erase_business() FROM app_runtime`);
  const p2a = await purge(X.biz);
  await x(`GRANT EXECUTE ON FUNCTION public.service_parts_erase_business() TO app_runtime`);
  ok("P2 EXECUTE revoked: the purge fails", p2a !== null && /permission denied|service_parts_erase_business/i.test(p2a), String(p2a));
  ok("P2 … and rolls back whole: users, staff, the 1.2a / 1.2b erasures and the part lines as before", (await snapshot(X.biz)) === before);
  await x(`ALTER FUNCTION public.service_parts_erase_business() RENAME TO service_parts_erase_business_away`);
  const p2b = await purge(X.biz);
  await x(`ALTER FUNCTION public.service_parts_erase_business_away() RENAME TO service_parts_erase_business`);
  ok("P2 the function missing: the purge fails", p2b !== null && /does not exist|service_parts_erase_business/i.test(p2b), String(p2b));
  ok("P2 … and rolls back whole", (await snapshot(X.biz)) === before);

  // P3 — the real erasure
  const ySnap = await snapshot(Y.biz);
  const rowCount = (biz: number) => n(`SELECT (SELECT count(*) FROM "ServicePart" WHERE "businessId" = $1)
      + (SELECT count(*) FROM "ServicePartEvent" WHERE "businessId" = $1) AS n`, biz);
  const rowsBefore = await rowCount(X.biz);
  const p3 = await purge(X.biz);
  ok("P3 a business being deleted: the purge succeeds", p3 === null, String(p3));
  const part = (id: number) => one(`SELECT "nameSnapshot" nm, "skuSnapshot" sku, reason r, note nt, "createdByUserId" u, "erasedAt" IS NOT NULL e,
      state::text st, source::text src, quantity qty, "inventoryItemId" item, "externalWorkId" w, "costIncludedInExternal" cie, version v, "lastEventKind"::text k
    FROM "ServicePart" WHERE id = $1`, id);
  const h = await part(xs.handTyped), s = await part(xs.stock), sp = await part(xs.supplierPart);
  ok("P3 hand-typed NON_STOCK line: name → the fixed text, sku and note cleared, user cleared; erasedAt stamped",
    h.nm === "חלק שנמחק" && h.sku === null && h.nt === null && h.u === null && h.e === true, JSON.stringify(h));
  ok("P3 supplier's part: the hand-typed name → the fixed text, user cleared; INSTALLED / work link / cost flag kept",
    sp.nm === "חלק שנמחק" && sp.u === null && sp.e === true && sp.st === "INSTALLED" && Number(sp.w) === xs.w && sp.cie === true, JSON.stringify(sp));
  ok("P3 line from stock: the inventory item's name and sku kept; the cancel reason and user cleared; CANCELLED / item / version kept",
    s.nm === "מסך iPhone 14" && s.sku === "SCR-IP14" && s.r === null && s.u === null && s.e === true
    && s.st === "CANCELLED" && Number(s.item) === X.item && Number(s.v) === 2 && s.k === "CANCELLED", JSON.stringify(s));
  const j = await one(`SELECT count(*)::int n,
      count(*) FILTER (WHERE "actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL OR reason IS NOT NULL OR "erasedAt" IS NULL)::int leftover,
      string_agg(kind::text || ':' || seq, ',' ORDER BY "partId", seq) seqs
    FROM "ServicePartEvent" WHERE "businessId" = $1`, X.biz);
  ok("P3 journal: actors, digests and the cancel reason cleared on every event; erasedAt stamped",
    Number(j.n) === 4 && Number(j.leftover) === 0, JSON.stringify(j));
  ok("P3 journal: kinds and seqs kept", j.seqs === "ADDED:1,ADDED:1,CANCELLED:2,SUPPLIER_PART_RECORDED:1", JSON.stringify(j));
  ok("P3 no M2 row removed (erased in place)", (await rowCount(X.biz)) === rowsBefore);

  // P4 — the other business
  ok("P4 business Y's rows (cases, works, parts, journal) are untouched", (await snapshot(Y.biz)) === ySnap);

  // P5 — no DELETE for the runtime; a second purge changes nothing
  ok("P5 the runtime holds no DELETE on either M2 table",
    await n(`SELECT count(*)::int AS n FROM unnest(ARRAY['ServicePart','ServicePartEvent']) t
      WHERE has_table_privilege('app_runtime', format('public.%I', t), 'DELETE')`) === 0);
  const after = await snapshot(X.biz);
  const p5 = await purge(X.biz);
  const again = JSON.parse(await snapshot(X.biz))[0], was = JSON.parse(after)[0];
  ok("P5 a second purge succeeds and changes no M2 row",
    p5 === null && JSON.stringify(again.parts) === JSON.stringify(was.parts) && JSON.stringify(again.journal) === JSON.stringify(was.journal), String(p5));

  // P6 — regression: the purge's other erasures ran in the same transaction
  const c = await one(`SELECT "problemDescription" p, "erasedAt" IS NOT NULL e, status::text s FROM "ServiceCase" WHERE id = $1`, xs.c2);
  ok("P6 regression: the 1.2a erasure ran in the same purge (case text cleared, EXTERNAL kept)", c.p === null && c.e === true && c.s === "EXTERNAL", JSON.stringify(c));
  const w = await one(`SELECT "sendReason" r, "sentByUserId" u, "erasedAt" IS NOT NULL e FROM "ServiceExternalWork" WHERE id = $1`, xs.w);
  ok("P6 regression: the 1.2b erasure ran in the same purge (send reason and user cleared)", w.r === null && w.u === null && w.e === true, JSON.stringify(w));
  const u = await one(`SELECT email e FROM "User" WHERE id = $1`, X.user);
  const st = await one(`SELECT "displayName" dn, "erasedAt" IS NOT NULL e FROM "StaffMember" WHERE id = $1`, X.staff);
  ok("P6 regression: the user is anonymised and the staff member blanked by the same purge",
    u.e !== "sdp-erase-x@lab.invalid" && st.dn === "" && st.e === true, JSON.stringify({ u, st }));

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
