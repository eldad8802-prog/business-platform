/**
 * Service Desk 1.2a PR-2 — account erasure through the REAL adapter, as the runtime role (.sdf/lab.sh --with-sdf).
 *
 * `prismaAccountDeletionStore.purgeOperationalData()` is the code account deletion runs. It calls
 * public.service_erase_business() inside its purge transaction (declared in DB_FUNCTION_ERASURES, proven
 * statically by the erasure contract). This battery proves the same path end to end on PostgreSQL 17:
 *
 *   E1. a business that is not being deleted: the purge refuses and nothing changes;
 *   E2. the function cannot run (EXECUTE revoked) / is missing (renamed): the whole purge rolls back —
 *       users, staff and Service rows exactly as before;
 *   E3. a business being deleted: every declared Service column cleared, erasedAt stamped, journal actors and
 *       digests and quote user ids nulled, no row removed; the kept columns and the business facts stay;
 *   E4. another business's Service rows are untouched;
 *   E5. a business with no Service data: the purge succeeds;
 *   E6. the runtime still holds no DELETE on any Service table; a second purge changes nothing;
 *   E7. regression: the existing erasures in the same purge still run (users anonymised, staff blanked).
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
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const one = async (sql: string, ...a: unknown[]) => (await q(sql, ...a))[0] ?? {};
const n = async (sql: string, ...a: unknown[]) => Number((await one(sql, ...a)).n);
const purge = (biz: number) => prismaAccountDeletionStore.purgeOperationalData(biz).then(() => null, (e: Error) => e.message);
const H = (c: string) => c.repeat(64);

async function business(name: string) {
  const biz = Number((await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name)).id);
  const user = Number((await one(`INSERT INTO "User" (email, name, "businessId", "updatedAt") VALUES ($1, 'בעל עסק', $2, now()) RETURNING id`, `${name}@lab.invalid`, biz)).id);
  const cust = Number((await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח', now()) RETURNING id`, biz)).id);
  const staff = Number((await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאית דנה', now()) RETURNING id`, biz)).id);
  const doc = Number((await one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, 'QUOTE', now()) RETURNING id`, biz)).id);
  return { biz, user, cust, staff, doc };
}

/** One full Service Desk history, written as the runtime in the business's tenant context. */
async function serviceData(b: Awaited<ReturnType<typeof business>>, tag: string) {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${b.biz}', true)`);
    const dev = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceDevice" ("businessId", "customerId", category, brand, model, "serialNumber", "serialNormalized", description, "updatedAt")
      VALUES ($1, $2, 'phone', 'Samsung', 'A54', 'SN ${tag}', 'SN${tag}', 'כחול סדוק', now()) RETURNING id`, b.biz, b.cust)) as Rows)[0].id);
    const kase = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "deviceId", "staffMemberId", "problemDescription", "updatedAt")
      VALUES ($1, 1, 'IN_SHOP', $2, $3, $4, 'המסך לא נדלק ${tag}', now()) RETURNING id`, b.biz, b.cust, dev, b.staff)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey", "requestDigest", "digestKeyId")
      VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{"kind":"IN_SHOP"}', $4, $5, 'k1')`, b.biz, kase, b.user, `sdf-erase-${tag}-0001`, H("a"));
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseIntake" ("businessId", "caseId", "deviceSnapshot", "conditionNote", "accessoriesNote", "conditionRecorded", "accessoriesRecorded", "termsVersion", "updatedAt")
      VALUES ($1, $2, '{"serial":"SN${tag}"}', 'שריטה', 'מטען', true, true, 'v1', now())`, b.biz, kase);
    await tx.$executeRawUnsafe(`UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = $2 WHERE "caseId" = $1`, kase, `biz/${b.biz}/service/sig/${kase}.png`);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
      VALUES ($1, $2, 1, $3, 45000, $4, $5, $6, $7)`, b.biz, kase, b.doc, H("1"), `biz/${b.biz}/service/quotes/${kase}.pdf`, H("f"), b.user);
    // With the handover record (migration 20261130090000) in place a new handover is a version-2 record: the full balance
    // (no overpayment) and the open debt's approver, who today is the acting user. Without it, the legacy shape as before.
    const v2 = Number(((await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = '"ServiceHandover"'::regclass AND attname = 'recordVersion' AND NOT attisdropped`)) as Rows)[0].n) === 1;
    if (v2) await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "signatureKey", "openBalanceAgorot", "debtOverrideReason", "actorUserId", "recordVersion", "overpaidAgorot", "debtApprovedByUserId", "debtApprovedAt")
      VALUES ($1, $2, 'ישראל ישראלי', true, $3, 500, 'ישלם מחר', $4, 2, 0, $4, now())`, b.biz, kase, `biz/${b.biz}/service/sig/h${kase}.png`, b.user);
    else await tx.$executeRawUnsafe(`INSERT INTO "ServiceHandover" ("businessId", "caseId", "receivedByName", "signatureCaptured", "signatureKey", "openBalanceAgorot", "debtOverrideReason", "actorUserId")
      VALUES ($1, $2, 'ישראל ישראלי', true, $3, 500, 'ישלם מחר', $4)`, b.biz, kase, `biz/${b.biz}/service/sig/h${kase}.png`, b.user);
    return { dev, kase };
  });
}

/** Everything erasure may touch, as one comparable snapshot (owner view, all rows). */
async function snapshot(biz: number) {
  return JSON.stringify(await q(`SELECT
      (SELECT json_agg(json_build_object('e', email, 'n', name) ORDER BY id) FROM "User" WHERE "businessId" = $1) AS users,
      (SELECT json_agg("displayName" ORDER BY id) FROM "StaffMember" WHERE "businessId" = $1) AS staff,
      (SELECT json_agg(row_to_json(c) ORDER BY id) FROM "ServiceCase" c WHERE "businessId" = $1) AS cases,
      (SELECT json_agg(row_to_json(d) ORDER BY id) FROM "ServiceDevice" d WHERE "businessId" = $1) AS devices,
      (SELECT json_agg(row_to_json(i) ORDER BY id) FROM "ServiceCaseIntake" i WHERE "businessId" = $1) AS intakes,
      (SELECT json_agg(row_to_json(h) ORDER BY id) FROM "ServiceHandover" h WHERE "businessId" = $1) AS handovers,
      (SELECT json_agg(row_to_json(e) ORDER BY id) FROM "ServiceCaseEvent" e WHERE "businessId" = $1) AS events,
      (SELECT json_agg(row_to_json(qq) ORDER BY id) FROM "ServiceQuote" qq WHERE "businessId" = $1) AS quotes`, biz));
}

async function main() {
  const X = await business("sdf-erase-x"), Y = await business("sdf-erase-y"), Z = await business("sdf-erase-z");
  const xs = await serviceData(X, "x");
  await serviceData(Y, "y");
  ok("0.1 synthetic service data for two businesses, written as the runtime", xs.kase > 0);

  // E1 — not being deleted
  const before = await snapshot(X.biz);
  const e1 = await purge(X.biz);
  ok("E1 a business that is not being deleted: the purge refuses", e1 !== null, String(e1));
  ok("E1 … and nothing changed (users, staff, every Service row)", (await snapshot(X.biz)) === before);

  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, X.biz);

  // E2 — the function cannot run, or is missing: the WHOLE purge rolls back
  await x(`REVOKE EXECUTE ON FUNCTION public.service_erase_business() FROM app_runtime`);
  const e2a = await purge(X.biz);
  await x(`GRANT EXECUTE ON FUNCTION public.service_erase_business() TO app_runtime`);
  ok("E2 EXECUTE revoked: the purge fails", e2a !== null && /permission denied|service_erase_business/i.test(e2a), String(e2a));
  ok("E2 … and rolls back whole: users, staff and Service rows as before", (await snapshot(X.biz)) === before);
  await x(`ALTER FUNCTION public.service_erase_business() RENAME TO service_erase_business_away`);
  const e2b = await purge(X.biz);
  await x(`ALTER FUNCTION public.service_erase_business_away() RENAME TO service_erase_business`);
  ok("E2 the function missing: the purge fails", e2b !== null && /does not exist|service_erase_business/i.test(e2b), String(e2b));
  ok("E2 … and rolls back whole", (await snapshot(X.biz)) === before);

  // E3 — the real erasure
  const ySnap = await snapshot(Y.biz);
  const rowCount = async (biz: number) => n(`SELECT (SELECT count(*) FROM "ServiceCase" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceDevice" WHERE "businessId" = $1)
      + (SELECT count(*) FROM "ServiceCaseIntake" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceHandover" WHERE "businessId" = $1)
      + (SELECT count(*) FROM "ServiceCaseEvent" WHERE "businessId" = $1) + (SELECT count(*) FROM "ServiceQuote" WHERE "businessId" = $1) AS n`, biz);
  const rowsBefore = await rowCount(X.biz);
  const e3 = await purge(X.biz);
  ok("E3 a business being deleted: the purge succeeds", e3 === null, String(e3));
  const c = await one(`SELECT "problemDescription" p, "diagnosisNote" d, "cancelReason" r1, "abandonReason" r2, "erasedAt" IS NOT NULL e, status::text s, version v FROM "ServiceCase" WHERE id = $1`, xs.kase);
  ok("E3 ServiceCase: every declared column cleared, erasedAt stamped, status and version kept",
    c.p === null && c.d === null && c.r1 === null && c.r2 === null && c.e === true && c.s === "OPEN" && Number(c.v) === 1, JSON.stringify(c));
  const d = await one(`SELECT "serialNumber" s, "serialNormalized" sn, description ds, brand b, model m, category cat, "erasedAt" IS NOT NULL e FROM "ServiceDevice" WHERE id = $1`, xs.dev);
  ok("E3 ServiceDevice: serial and description cleared; category / brand / model kept (declared)",
    d.s === null && d.sn === null && d.ds === null && d.b === "Samsung" && d.m === "A54" && d.cat === "phone" && d.e === true, JSON.stringify(d));
  const i = await one(`SELECT "deviceSnapshot"::text snap, "conditionNote" c, "accessoriesNote" a, "signatureKey" k, "termsVersion" t, "erasedAt" IS NOT NULL e FROM "ServiceCaseIntake" WHERE "caseId" = $1`, xs.kase);
  ok("E3 ServiceCaseIntake: snapshot, notes and signature key cleared; termsVersion kept",
    i.snap === "{}" && i.c === null && i.a === null && i.k === null && i.t === "v1" && i.e === true, JSON.stringify(i));
  const h = await one(`SELECT "receivedByName" r, "signatureKey" k, "debtOverrideReason" dr, "loanerOverrideReason" lr, "actorUserId" u, "openBalanceAgorot" b, "erasedAt" IS NOT NULL e FROM "ServiceHandover" WHERE "caseId" = $1`, xs.kase);
  ok("E3 ServiceHandover: receiver, signature key, reasons and actor cleared; the balance kept",
    h.r === null && h.k === null && h.dr === null && h.lr === null && h.u === null && Number(h.b) === 500 && h.e === true, JSON.stringify(h));
  const ev = await one(`SELECT "actorUserId" u, "requestDigest" g, "digestKeyId" k, "eventType"::text t, seq FROM "ServiceCaseEvent" WHERE "caseId" = $1`, xs.kase);
  ok("E3 ServiceCaseEvent: actor and digests nulled; the opening event kept", ev.u === null && ev.g === null && ev.k === null && ev.t === "case.opened" && Number(ev.seq) === 1, JSON.stringify(ev));
  const qt = await one(`SELECT "sentByUserId" u, "totalAgorot" t, "docHash" hsh FROM "ServiceQuote" WHERE "caseId" = $1`, xs.kase);
  ok("E3 ServiceQuote: the sending user nulled; total and hash kept", qt.u === null && Number(qt.t) === 45000 && qt.hsh === H("1"), JSON.stringify(qt));
  ok("E3 no Service row removed (erased in place)", (await rowCount(X.biz)) === rowsBefore);

  // E4 — the other business
  ok("E4 business Y's Service rows are untouched", (await snapshot(Y.biz)) === ySnap);

  // E5 — a business with no Service data
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, Z.biz);
  const e5 = await purge(Z.biz);
  ok("E5 a business with no Service data: the purge succeeds", e5 === null, String(e5));

  // E6 — no DELETE for the runtime; a second purge changes nothing
  ok("E6 the runtime holds no DELETE on any Service table",
    await n(`SELECT count(*)::int AS n FROM unnest(ARRAY['ServiceCaseNumberSequence','ServiceDevice','ServiceCase','ServiceCaseIntake','ServiceQuote','ServiceCaseEvent','ServiceHandover']) t
      WHERE has_table_privilege('app_runtime', format('public.%I', t), 'DELETE')`) === 0);
  const after = await snapshot(X.biz);
  const e6 = await purge(X.biz);
  ok("E6 a second purge succeeds and changes no Service row", e6 === null && JSON.parse(await snapshot(X.biz)).cases === JSON.parse(after).cases, String(e6));

  // E7 — regression: the purge's other erasures ran in the same transaction
  const u = await one(`SELECT email e, name nm FROM "User" WHERE id = $1`, X.user);
  const s = await one(`SELECT "displayName" dn, "erasedAt" IS NOT NULL e FROM "StaffMember" WHERE id = $1`, X.staff);
  ok("E7 regression: the user is anonymised and the staff member blanked by the same purge",
    u.e !== `sdf-erase-x@lab.invalid` && s.dn === "" && s.e === true, JSON.stringify({ u, s }));
  const yu = await one(`SELECT email e FROM "User" WHERE id = $1`, Y.user);
  ok("E7 regression: business Y's user is untouched", yu.e === "sdf-erase-y@lab.invalid");

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
