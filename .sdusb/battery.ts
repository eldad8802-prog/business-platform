/**
 * Service Desk — migration 20261124090000_service_user_same_business_fix, AS the real roles, on the Production-topology
 * lab (.sdusb/lab.sh: Production's Service Desk state 20261112 … 20261122, then this migration by `prisma migrate deploy`).
 *
 *   node tsx .sdusb/battery.ts seed   BEFORE the migration: writes the LEGACY rows (business "usb-legacy") — a quote sent
 *                                     AND decided by one user, external work sent AND returned by one user, a text
 *                                     created AND legally approved by one user, a warranty offer created AND presented by
 *                                     one user, a quote sent by one user and decided by another — and proves the defect
 *                                     is live: deleting each of those users is refused (SERVICE_USER_OTHER_BUSINESS),
 *                                     nothing changed.
 *   node tsx .sdusb/battery.ts        AFTER the migration:
 *     S  structure: the function replaced in place (same oid as every trigger's), invoker, search_path, no PUBLIC
 *        execute; every trigger using it BEFORE / ROW / enabled; every column it checks has exactly one NOT DEFERRABLE
 *        "User" FK ON DELETE SET NULL.
 *     L  the legacy rows written before the migration: each user deleted → the references NULL, the rows and their facts
 *        (state, decision, approval, hashes, journal) intact.
 *     R  the real tables as the runtime role: one user in BOTH columns of a quote, an external work, a text and an offer
 *        AND in the single-column tables, deleted in one statement; two different users; a user anonymised; a cross-business user refused on every INSERT and every attaching UPDATE
 *        (quote send / decision, return, legal approval, presentation, photo, event); a user id that does not exist.
 *     P  the function itself on a scratch table (inside a rolled-back transaction) with three user columns, as the owner: every combination of
 *        changed / unchanged / NULL / same business / other business / missing user, several columns in one statement,
 *        the business changed under the users, a user moved to another business, the exception's four conditions one by
 *        one (nested trigger, unchanged value, user missing), a user id renumbered (ON UPDATE CASCADE), a mistyped column; a superuser-forced dangling id
 *        is NOT carried by an ordinary UPDATE (SUPER_URL).
 *     E  erasure: the five erase functions of a business being deleted, with one user in two columns of every table,
 *        then the user deleted.
 *
 * env: OWNER_URL (lab owner), RUNTIME_URL (app_runtime_prod), SUPER_URL (lab superuser — the P dangling check only).
 * Synthetic only. Raw SQL only.
 */
import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";

const MODE = process.argv[2] ?? "verify";
const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=8&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: withPool(process.env.OWNER_URL!) });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });
const superuser = process.env.SUPER_URL ? new PrismaClient({ datasourceUrl: withPool(process.env.SUPER_URL) }) : null;

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => e.message);
}
const q = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>);
const x = (c: PrismaClient, g: number | null, sql: string, ...a: unknown[]) => inTx(c, g, (tx) => tx.$executeRawUnsafe(sql, ...a));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, k = "n") => Number(rows(r)[0]?.[k] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const succeeded = (r: unknown) => typeof r !== "string";
const OTHER = /SERVICE_USER_OTHER_BUSINESS/;
const H = (c: string) => c.repeat(64);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
let keySeq = 0;
const run = Date.now().toString(36);
const ikey = () => `usb-lab-key-${run}-${String(++keySeq).padStart(6, "0")}`;

// ── fixtures (owner) ─────────────────────────────────────────────────────────────────────────────────────────
const one = async (sql: string, ...a: unknown[]) => {
  const r = await q(owner, null, sql, ...a);
  if (typeof r === "string") throw new Error(`fixture: ${r}`);
  return num(r, "id");
};
async function newUser(biz: number, tag: string) {
  return one(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `usb-${tag}-${run}-${++keySeq}@lab.invalid`, biz);
}
async function business(name: string) {
  const biz = await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name);
  const cust = await one(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, biz);
  const user = await newUser(biz, "main");
  const staff = await one(`INSERT INTO "StaffMember" ("businessId", "displayName", "updatedAt") VALUES ($1, 'טכנאי', now()) RETURNING id`, biz);
  const supplier = await one(`INSERT INTO "Supplier" ("businessId", name, "updatedAt") VALUES ($1, 'מעבדה חיצונית', now()) RETURNING id`, biz);
  return { biz, cust, user, staff, supplier };
}
type B = Awaited<ReturnType<typeof business>>;
const must = <T>(label: string, r: T | string): T => { if (typeof r === "string") throw new Error(`${label}: ${r}`); return r; };

// ── runtime helpers (the writes the Service Desk services make) ──────────────────────────────────────────────
async function caseTx(tx: Tx, b: B) {
  const n = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCaseNumberSequence" ("businessId", "nextValue") VALUES ($1, 2)
    ON CONFLICT ("businessId") DO UPDATE SET "nextValue" = "ServiceCaseNumberSequence"."nextValue" + 1, "updatedAt" = now() RETURNING "nextValue" - 1 AS n`, b.biz)) as Rows)[0].n);
  const id = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "updatedAt")
    VALUES ($1, $2, 'IN_SHOP', $3, 'המסך לא נדלק', now()) RETURNING id`, b.biz, n, b.cust)) as Rows)[0].id);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, 1, 'case.opened', 'OPEN', NULL, 'OPEN', false, false, 'OWNER_USER', $3, '{}', $4)`, b.biz, id, b.user, ikey());
  return id;
}
const openCase = async (b: B) => must("openCase", await inTx(runtime, b.biz, (tx) => caseTx(tx, b)));
async function moveTx(tx: Tx, biz: number, caseId: number, set: string, action: string, type: string, from: string, to: string, outcome: string | null = null) {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET ${set}, version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", outcome, actor, payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", false, false, $8::"ServiceOutcome", 'SYSTEM', '{}', $9)`,
    biz, caseId, v, type, action, from, to, outcome, ikey());
}

/** Check-in of an OPEN case by the owner user `by`: the case moves, then its event names the acting user. */
const checkIn = (b: B, caseId: number, by: number) => inTx(runtime, b.biz, async (tx) => {
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceCase" SET status = 'CHECKED_IN', version = version + 1, "updatedAt" = now() WHERE id = $1 RETURNING version`, caseId)) as Rows)[0].version);
  return tx.$executeRawUnsafe(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore", "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, 'case.checked_in', 'CHECK_IN', 'OPEN', 'CHECKED_IN', false, false, 'OWNER_USER', $4, '{}', $5)`, b.biz, caseId, v, by, ikey());
});

/** A quote sent by `sentBy`, decided (REJECTED) by `decidedBy` (null = stays SENT). */
async function quote(b: B, sentBy: number, decidedBy: number | null) {
  const c = await openCase(b);
  const doc = await one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, 'QUOTE'::"BillingDocumentType", now()) RETURNING id`, b.biz);
  const id = num(must("quote", await q(runtime, b.biz, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
    VALUES ($1, $2, 1, $3, 45000, $4, $5, $6, $7) RETURNING id`, b.biz, c, doc, H("d"), `biz/${b.biz}/service/cases/${c}/quotes/v1-${H("e")}.pdf`, H("e"), sentBy)), "id");
  if (decidedBy !== null) must("decide", await decide(b, id, decidedBy));
  return id;
}
const decide = (b: B, id: number, by: number) => x(runtime, b.biz,
  `UPDATE "ServiceQuote" SET state = 'REJECTED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "decidedByUserId" = $2 WHERE id = $1`, id, by);

/** External work sent by `sentBy`; returned by `returnedBy` (null = stays at the supplier). */
async function externalWork(b: B, sentBy: number, returnedBy: number | null) {
  const r = await inTx(runtime, b.biz, async (tx) => {
    const c = await caseTx(tx, b);
    await moveTx(tx, b.biz, c, `status = 'EXTERNAL'`, "SEND_TO_EXTERNAL", "external.sent", "OPEN", "EXTERNAL");
    const w = Number(((await tx.$queryRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "requestedWork", "conditionAtSend", "expectedBackOn", "updatedAt")
      VALUES ($1, $2, 1, $3, $4, 'אין לנו ציוד', 'החלפת מסך', 'סדק בפינה', DATE '2026-11-20', now()) RETURNING id`, b.biz, c, b.supplier, sentBy)) as Rows)[0].id);
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "expectedBackOn", actor, "actorUserId", payload, "idempotencyKey")
      VALUES ($1, $2, $3, 1, 'SENT', 'SENT', DATE '2026-11-20', 'OWNER_USER', $4, '{"round":1}', $5)`, b.biz, w, c, sentBy, ikey());
    return { c, w };
  });
  const { c, w } = must("externalWork", r);
  if (returnedBy !== null) must("return", await returnWork(b, c, w, returnedBy));
  return w;
}
const returnWork = (b: B, c: number, w: number, by: number) => inTx(runtime, b.biz, async (tx) => {
  await moveTx(tx, b.biz, c, `status = 'READY', outcome = 'NOT_REPAIRED'`, "RETURN_FROM_EXTERNAL", "external.returned", "EXTERNAL", "READY", "NOT_REPAIRED");
  const v = Number(((await tx.$queryRawUnsafe(`UPDATE "ServiceExternalWork" SET state = 'RETURNED', "returnedAt" = now(), "returnedByUserId" = $2, "returnResult" = 'NOT_REPAIRED',
      "workPerformed" = 'בדיקה בלבד', "unresolvedIssue" = 'לוח אם', "followUpRequired" = true, "receivedByStaffMemberId" = $3,
      version = version + 1, "lastEventKind" = 'RETURNED', "updatedAt" = now() WHERE id = $1 RETURNING version`, w, by, b.staff)) as Rows)[0].version);
  await tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWorkEvent" ("businessId", "workId", "caseId", seq, kind, "progressStage", "expectedBackOn", actor, "actorUserId", payload, "idempotencyKey")
    VALUES ($1, $2, $3, $4, 'RETURNED', 'SENT', DATE '2026-11-20', 'OWNER_USER', NULL, '{}', $5)`, b.biz, w, c, v, ikey());
  return v;
});

/** A text version created by `createdBy`; legally approved by `approvedBy` (null = stays DRAFT). */
async function text(b: B, kind: "TERMS" | "STATUTORY_NOTICE", createdBy: number, approvedBy: number | null) {
  const body = `נוסח ${kind} ${run}-${++keySeq}`;
  const id = num(must("text", await q(runtime, b.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId")
    VALUES ($1, $2::"ServiceTextKind", (SELECT COALESCE(max(version), 0) + 1 FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = $2::"ServiceTextKind"),
      $3, $4, $5) RETURNING id`, b.biz, kind, body, sha(body), createdBy)), "id");
  if (approvedBy !== null) must("approve", await approve(b, id, approvedBy));
  return id;
}
const approve = (b: B, id: number, by: number) => x(runtime, b.biz,
  `UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE id = $1`, id, by);

/** A warranty offer created by `createdBy`; presented by `presentedBy` (null = stays DRAFT). */
async function warrantyOffer(b: B, notice: number, createdBy: number, presentedBy: number | null) {
  const c = await openCase(b);
  const id = num(must("offer", await q(runtime, b.biz, `INSERT INTO "ServiceWarrantyOffer" ("businessId", "caseId", seq, state, source, "durationValue", "durationUnit", "scopeText",
      "statutoryNoticeVersionId", "contentSha256", "createdByUserId", "updatedAt")
    VALUES ($1, $2, 1, 'DRAFT', 'INTAKE', 90, 'DAYS', 'החלפת מסך', $3, $4, $5, now()) RETURNING id`, b.biz, c, notice, H("a"), createdBy)), "id");
  if (presentedBy !== null) must("present", await present(b, id, presentedBy));
  return id;
}
const present = (b: B, id: number, by: number) => x(runtime, b.biz,
  `UPDATE "ServiceWarrantyOffer" SET state = 'PRESENTED', "presentedAt" = now(), "presentedByUserId" = $2 WHERE id = $1`, id, by);

const photo = (b: B, c: number, by: number) => {
  const h = sha(`photo-${run}-${++keySeq}`);
  return x(runtime, b.biz, `INSERT INTO "ServiceIntakePhoto" ("businessId", "caseId", "storageKey", sha256, "mimeType", "byteSize", "createdByUserId")
    VALUES ($1, $2, $3, $4, 'image/jpeg', 250000, $5)`, b.biz, c, `biz/${b.biz}/service/cases/${c}/intake/photos/${h}.jpg`, h, by);
};
const delUser = (id: number) => x(owner, null, `DELETE FROM "User" WHERE id = $1`, id);
const pick = async (sql: string, ...a: unknown[]) => rows(await q(owner, null, sql, ...a))[0] ?? {};

const LEGACY = "usb-legacy";
async function legacyFixture() {
  const r = rows(await q(owner, null, `SELECT id FROM "Business" WHERE name = $1 ORDER BY id DESC LIMIT 1`, LEGACY));
  return r.length ? Number(r[0].id) : null;
}

// ── seed: BEFORE the migration ───────────────────────────────────────────────────────────────────────────────
async function seed() {
  const fixed = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'service_user_same_business' AND prosrc LIKE '%SERVICE_USER_COLUMN_UNKNOWN%'`));
  if (fixed !== 0) { ok("seed runs only BEFORE 20261124090000 (the function must still be the foundation's)", false); return; }
  if (await legacyFixture() !== null) { ok("the legacy business is seeded once", false); return; }
  console.log("seed. legacy rows written BEFORE the migration (business usb-legacy)");
  const L = await business(LEGACY);
  const uQ = await newUser(L.biz, "quote"), uX = await newUser(L.biz, "ext"), uT = await newUser(L.biz, "text"), uW = await newUser(L.biz, "offer");
  const uS = await newUser(L.biz, "sender"), uD = await newUser(L.biz, "decider");
  const qBoth = await quote(L, uQ, uQ);
  const xBoth = await externalWork(L, uX, uX);
  const tBoth = await text(L, "TERMS", uT, uT);
  const notice = await text(L, "STATUTORY_NOTICE", L.user, L.user);
  const wBoth = await warrantyOffer(L, notice, uW, uW);
  const qTwo = await quote(L, uS, uD);
  // The ids are found again after the migration by the business name and these markers (no state outside the database).
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uQ, "usb-legacy-quote");
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uX, "usb-legacy-ext");
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uT, "usb-legacy-text");
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uW, "usb-legacy-offer");
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uS, "usb-legacy-sender");
  await x(owner, null, `UPDATE "User" SET name = $2 WHERE id = $1`, uD, "usb-legacy-decider");
  ok("seed: the four double-column rows and the two-user quote exist with the user in both columns",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE id = $1 AND "sentByUserId" = $2 AND "decidedByUserId" = $2`, qBoth, uQ)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWork" WHERE id = $1 AND "sentByUserId" = $2 AND "returnedByUserId" = $2`, xBoth, uX)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceTextVersion" WHERE id = $1 AND "createdByUserId" = $2 AND "legallyApprovedByUserId" = $2`, tBoth, uT)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceWarrantyOffer" WHERE id = $1 AND "createdByUserId" = $2 AND "presentedByUserId" = $2`, wBoth, uW)) === 1
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE id = $1 AND "sentByUserId" = $2 AND "decidedByUserId" = $3`, qTwo, uS, uD)) === 1);
  // The defect, live: each of the four users cannot be deleted (and nothing changes).
  for (const [label, u, re] of [["quote", uQ, /"ServiceQuote"\."(sentByUserId|decidedByUserId)"/], ["external work", uX, /"ServiceExternalWork"\."(sentByUserId|returnedByUserId)"/],
    ["text", uT, /"ServiceTextVersion"\."(createdByUserId|legallyApprovedByUserId)"/], ["warranty offer", uW, /"ServiceWarrantyOffer"\."(createdByUserId|presentedByUserId)"/]] as const) {
    const r = await delUser(u);
    ok(`seed: BEFORE the fix, deleting the user in both columns of the ${label} → refused SERVICE_USER_OTHER_BUSINESS (the defect)`, refused(r, OTHER) && refused(r, re), String(r));
  }
  let controlDeleted = false;
  await inTx(owner, null, async (tx) => { controlDeleted = (await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, uS)) === 1; throw new Error("rollback"); });
  ok("seed: the two-user quote — deleting one of two DIFFERENT users already worked before the fix (control; rolled back)", controlDeleted);
  ok("seed: nothing was deleted", num(await q(owner, null, `SELECT count(*)::int AS n FROM "User" WHERE id = ANY($1::int[])`, [uQ, uX, uT, uW, uS, uD])) === 6);
}

// ── verify: AFTER the migration ──────────────────────────────────────────────────────────────────────────────
async function structure() {
  console.log("S. structure");
  const f = (await pick(`SELECT p.oid::int AS oid, p.prosecdef AS d, array_to_string(p.proconfig, ',') AS cfg, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
      p.prosrc LIKE '%SERVICE_USER_COLUMN_UNKNOWN%' AND p.prosrc LIKE '%pg_trigger_depth() > 1%' AS fixed
    FROM pg_proc p WHERE p.oid = 'public.service_user_same_business()'::regprocedure`)) as Record<string, unknown>;
  ok("S1 the function carries the fix, SECURITY INVOKER, search_path pg_catalog, public, pg_temp, no PUBLIC execute",
    f.fixed === true && f.d === false && f.cfg === "search_path=pg_catalog, public, pg_temp" && f.pub === false, JSON.stringify(f));
  const t = (await pick(`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & (8 | 32 | 64)) = 0 AND tgconstraint = 0 AND tgenabled = 'O')::int AS good
    FROM pg_trigger WHERE tgfoid = 'public.service_user_same_business()'::regprocedure`)) as Record<string, unknown>;
  ok("S2 every trigger using it (14 in Production's state, more with the Drafts) is BEFORE, FOR EACH ROW, INSERT/UPDATE, enabled",
    Number(t.n) >= 14 && Number(t.n) === Number(t.good), JSON.stringify(t));
  const bad = num(await q(owner, null, `WITH args AS (
      SELECT t.tgrelid, a.col FROM pg_trigger t
      CROSS JOIN LATERAL unnest((string_to_array(encode(t.tgargs, 'escape'), '\\000'))[1:t.tgnargs]) AS a(col)
      WHERE t.tgfoid = 'public.service_user_same_business()'::regprocedure)
    SELECT count(*)::int AS n FROM args WHERE (SELECT count(*) FROM pg_constraint k JOIN pg_attribute att ON att.attrelid = k.conrelid AND att.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.conrelid = args.tgrelid AND cardinality(k.conkey) = 1 AND att.attname = args.col
        AND k.confrelid = 'public."User"'::regclass AND k.confdeltype = 'n' AND NOT k.condeferrable) <> 1`));
  ok("S3 every column it checks has exactly one NOT DEFERRABLE \"User\" FK ON DELETE SET NULL", bad === 0, String(bad));
}

async function legacy() {
  console.log("L. legacy rows written before the migration");
  const lb = await legacyFixture();
  if (lb === null) { ok("L0 the legacy business exists (run `seed` before the migration)", false); return; }
  const u = async (name: string) => num(await q(owner, null, `SELECT id AS n FROM "User" WHERE "businessId" = $1 AND name = $2`, lb, name));
  const [uQ, uX, uT, uW, uS, uD] = await Promise.all(["usb-legacy-quote", "usb-legacy-ext", "usb-legacy-text", "usb-legacy-offer", "usb-legacy-sender", "usb-legacy-decider"].map(u));
  ok("L0 the six legacy users are still there (the migration changed no row)", [uQ, uX, uT, uW, uS, uD].every((v) => Number.isInteger(v) && v > 0));
  const events = num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1`, lb));
  const xEvents = num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1`, lb));

  const d1 = await delUser(uQ);
  const q1 = await pick(`SELECT state::text AS s, "sentByUserId" AS a, "decidedByUserId" AS b, "decidedAt" IS NOT NULL AS dd, "decidedByActor"::text AS da, "docHash" AS h, "totalAgorot" AS t
    FROM "ServiceQuote" WHERE "businessId" = $1 AND "decidedByActor" IS NOT NULL ORDER BY id LIMIT 1`, lb);
  ok("L1 the quote sent AND decided by one user: the user is deleted; both references NULL; REJECTED, decision time, actor, hash, total intact",
    succeeded(d1) && q1.s === "REJECTED" && q1.a === null && q1.b === null && q1.dd === true && q1.da === "OWNER_USER" && q1.h === H("d") && Number(q1.t) === 45000, `${d1} ${JSON.stringify(q1)}`);
  const d2 = await delUser(uX);
  const x2 = await pick(`SELECT state::text AS s, "sentByUserId" AS a, "returnedByUserId" AS b, "returnResult"::text AS r, "workPerformed" AS wp FROM "ServiceExternalWork" WHERE "businessId" = $1`, lb);
  ok("L2 the external work sent AND returned by one user: deleted; both NULL; RETURNED, result and texts intact",
    succeeded(d2) && x2.s === "RETURNED" && x2.a === null && x2.b === null && x2.r === "NOT_REPAIRED" && x2.wp === "בדיקה בלבד", `${d2} ${JSON.stringify(x2)}`);
  const d3 = await delUser(uT);
  const t3 = await pick(`SELECT "legalStatus"::text AS s, "createdByUserId" AS a, "legallyApprovedByUserId" AS b, "legallyApprovedAt" IS NOT NULL AS at, "bodySha256" = encode(sha256(convert_to(body, 'UTF8')), 'hex') AS h
    FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = 'TERMS'`, lb);
  ok("L3 the text created AND legally approved by one user: deleted; both NULL; LEGALLY_APPROVED, approval time, body hash intact",
    succeeded(d3) && t3.s === "LEGALLY_APPROVED" && t3.a === null && t3.b === null && t3.at === true && t3.h === true, `${d3} ${JSON.stringify(t3)}`);
  const d4 = await delUser(uW);
  const w4 = await pick(`SELECT state::text AS s, "createdByUserId" AS a, "presentedByUserId" AS b, "presentedAt" IS NOT NULL AS pa, "durationValue" AS v FROM "ServiceWarrantyOffer" WHERE "businessId" = $1`, lb);
  ok("L4 the warranty offer created AND presented by one user: deleted; both NULL; PRESENTED, presentation time, duration intact",
    succeeded(d4) && w4.s === "PRESENTED" && w4.a === null && w4.b === null && w4.pa === true && Number(w4.v) === 90, `${d4} ${JSON.stringify(w4)}`);
  const d5 = await delUser(uS);
  const q5 = await pick(`SELECT "sentByUserId" AS a, "decidedByUserId" AS b FROM "ServiceQuote" WHERE "businessId" = $1 AND "decidedByUserId" = $2`, lb, uD);
  const d6 = await delUser(uD);
  const q6 = num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE "businessId" = $1 AND "sentByUserId" IS NULL AND "decidedByUserId" IS NULL`, lb));
  ok("L5 the quote of two different users: the sender deleted → only sentBy NULL, decidedBy still the decider; then the decider deleted → NULL",
    succeeded(d5) && q5.a === null && Number(q5.b) === uD && succeeded(d6) && q6 === 2, `${d5} ${d6} ${JSON.stringify(q5)} ${q6}`);
  ok("L6 the journals are untouched by the deletions (same number of case and external-work events)",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "businessId" = $1`, lb)) === events
    && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceExternalWorkEvent" WHERE "businessId" = $1`, lb)) === xEvents);
}

async function realTables(A: B, Bz: B) {
  console.log("R. the real tables, as the runtime role");
  const notice = await text(A, "STATUTORY_NOTICE", A.user, A.user);
  // One user in BOTH columns of every double-column table, and in single-column tables, deleted in one statement.
  const U = await newUser(A.biz, "everywhere");
  const qU = await quote(A, U, U);
  const xU = await externalWork(A, U, U);
  const tU = await text(A, "TERMS", U, U);
  const wU = await warrantyOffer(A, notice, U, U);
  const cU = await openCase(A);
  must("photo", await photo(A, cU, U));
  must("event", await checkIn(A, cU, U));
  const refsBefore = num(await q(owner, null, `SELECT ((SELECT count(*) FROM "ServiceQuote" WHERE "sentByUserId" = $1 AND "decidedByUserId" = $1)
      + (SELECT count(*) FROM "ServiceExternalWork" WHERE "sentByUserId" = $1 AND "returnedByUserId" = $1)
      + (SELECT count(*) FROM "ServiceTextVersion" WHERE "createdByUserId" = $1 AND "legallyApprovedByUserId" = $1)
      + (SELECT count(*) FROM "ServiceWarrantyOffer" WHERE "createdByUserId" = $1 AND "presentedByUserId" = $1)
      + (SELECT count(*) FROM "ServiceIntakePhoto" WHERE "createdByUserId" = $1)
      + (SELECT count(*) FROM "ServiceCaseEvent" WHERE "actorUserId" = $1)
      + (SELECT count(*) FROM "ServiceExternalWorkEvent" WHERE "actorUserId" = $1))::int AS n`, U));
  ok("R1 setup: one user in both columns of a quote, an external work, a text, an offer, and in a photo, case events and an external-work event",
    refsBefore === 7, String(refsBefore));
  const dU = await delUser(U);
  const after = await pick(`SELECT (SELECT "sentByUserId" IS NULL AND "decidedByUserId" IS NULL AND state = 'REJECTED' FROM "ServiceQuote" WHERE id = $1) AS q,
      (SELECT "sentByUserId" IS NULL AND "returnedByUserId" IS NULL AND state = 'RETURNED' FROM "ServiceExternalWork" WHERE id = $2) AS x,
      (SELECT "createdByUserId" IS NULL AND "legallyApprovedByUserId" IS NULL AND "legalStatus" = 'LEGALLY_APPROVED' FROM "ServiceTextVersion" WHERE id = $3) AS t,
      (SELECT "createdByUserId" IS NULL AND "presentedByUserId" IS NULL AND state = 'PRESENTED' FROM "ServiceWarrantyOffer" WHERE id = $4) AS w,
      (SELECT count(*) FROM "ServiceIntakePhoto" WHERE "caseId" = $5 AND "createdByUserId" IS NULL)::int AS p,
      (SELECT count(*) FROM "ServiceCaseEvent" WHERE "caseId" = $5)::int AS e`, qU, xU, tU, wU, cU);
  ok("R2 that user deleted in ONE statement → every reference NULL, every row and its state kept (quote, work, text, offer, photo, journal)",
    succeeded(dU) && after.q === true && after.x === true && after.t === true && after.w === true && after.p === 1 && after.e === 2, `${dU} ${JSON.stringify(after)}`);

  // Two different users in the two columns: deleting one leaves the other.
  const u1 = await newUser(A.biz, "one"), u2 = await newUser(A.biz, "two");
  const t12 = await text(A, "TERMS", u1, u2);
  const d12 = await delUser(u2);
  const r12 = await pick(`SELECT "createdByUserId" AS a, "legallyApprovedByUserId" AS b FROM "ServiceTextVersion" WHERE id = $1`, t12);
  ok("R3 two different users: the approver deleted → only legallyApprovedBy NULL; createdBy still names the creator",
    succeeded(d12) && Number(r12.a) === u1 && r12.b === null, `${d12} ${JSON.stringify(r12)}`);

  // Anonymisation (what account deletion does to "User"): the user row stays, the references stay, nothing refused.
  const uA = await newUser(A.biz, "anon");
  const qA = await quote(A, uA, uA);
  const dA = await x(owner, null, `UPDATE "User" SET email = $2, name = NULL, password = NULL WHERE id = $1`, uA, `deleted-${uA}-${run}@anon.invalid`);
  ok("R5 a user anonymised in place → no refusal; the quote still names that (same-business) user in both columns",
    succeeded(dA) && num(await q(owner, null, `SELECT count(*)::int AS n FROM "ServiceQuote" WHERE id = $1 AND "sentByUserId" = $2 AND "decidedByUserId" = $2`, qA, uA)) === 1, String(dA));

  // Cross-business: refused on every INSERT and every attaching UPDATE.
  const cX = await openCase(A);
  const docX = await one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "updatedAt") VALUES ($1, 'QUOTE'::"BillingDocumentType", now()) RETURNING id`, A.biz);
  const insQ = (by: number) => x(runtime, A.biz, `INSERT INTO "ServiceQuote" ("businessId", "caseId", version, "billingDocumentId", "totalAgorot", "docHash", "sentPdfKey", "sentPdfSha256", "sentByUserId")
    VALUES ($1, $2, 1, $3, 100, $4, $5, $6, $7)`, A.biz, cX, docX, H("d"), `biz/${A.biz}/service/cases/${cX}/quotes/v1-${H("e")}.pdf`, H("e"), by);
  ok("R6 send a quote naming a user of ANOTHER business → refused SERVICE_USER_OTHER_BUSINESS", refused(await insQ(Bz.user), OTHER));
  ok("R7 send a quote naming a user id that does not exist → refused by the guard (before the FK)", refused(await insQ(2_000_000_000), OTHER));
  const qOpen = await quote(A, A.user, null);
  ok("R8 decide a quote naming a user of another business → refused; still SENT",
    refused(await decide(A, qOpen, Bz.user), OTHER) && (await pick(`SELECT state::text AS s FROM "ServiceQuote" WHERE id = $1`, qOpen)).s === "SENT");
  const tOpen = await text(A, "TERMS", A.user, null);
  ok("R9 legally approve a text naming a user of another business → refused; still DRAFT",
    refused(await approve(A, tOpen, Bz.user), OTHER) && (await pick(`SELECT "legalStatus"::text AS s FROM "ServiceTextVersion" WHERE id = $1`, tOpen)).s === "DRAFT");
  const wOpen = await warrantyOffer(A, notice, A.user, null);
  ok("R10 present an offer naming a user of another business → refused; still DRAFT",
    refused(await present(A, wOpen, Bz.user), OTHER) && (await pick(`SELECT state::text AS s FROM "ServiceWarrantyOffer" WHERE id = $1`, wOpen)).s === "DRAFT");
  const wX = await externalWork(A, A.user, null);
  const cW = Number((await pick(`SELECT "caseId" AS c FROM "ServiceExternalWork" WHERE id = $1`, wX)).c);
  ok("R11 return external work naming a user of another business → refused; still at the supplier",
    refused(await returnWork(A, cW, wX, Bz.user), OTHER) && (await pick(`SELECT state::text AS s FROM "ServiceExternalWork" WHERE id = $1`, wX)).s === "AT_SUPPLIER");
  ok("R12 an external work SENT by a user of another business → refused", refused(await inTx(runtime, A.biz, async (tx) => {
    const c = await caseTx(tx, A);
    await moveTx(tx, A.biz, c, `status = 'EXTERNAL'`, "SEND_TO_EXTERNAL", "external.sent", "OPEN", "EXTERNAL");
    return tx.$executeRawUnsafe(`INSERT INTO "ServiceExternalWork" ("businessId", "caseId", round, "supplierId", "sentByUserId", "sendReason", "requestedWork", "conditionAtSend", "expectedBackOn", "updatedAt")
      VALUES ($1, $2, 1, $3, $4, 'א', 'ב', 'ג', DATE '2026-11-20', now())`, A.biz, c, A.supplier, Bz.user);
  }), OTHER));
  ok("R13 a text CREATED by a user of another business → refused", refused(await q(runtime, A.biz, `INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId")
    VALUES ($1, 'TERMS', (SELECT max(version) + 1 FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = 'TERMS'), 'x', encode(sha256('x'), 'hex'), $2) RETURNING id`, A.biz, Bz.user), OTHER));
  ok("R14 single-column tables still checked: a photo / a case event by a user of another business → refused",
    refused(await photo(A, cX, Bz.user), OTHER)
    && refused(await checkIn(A, cX, Bz.user), OTHER));
  ok("R15 the table owner (no RLS in its way) is refused the same: decidedBy of another business",
    refused(await x(owner, null, `UPDATE "ServiceQuote" SET state = 'REJECTED', "decidedAt" = now(), "decidedByActor" = 'OWNER_USER', "decidedByUserId" = $2 WHERE id = $1`, qOpen, Bz.user), OTHER));
  // A user deleted while named in an UNDECIDED quote → sentBy NULL; the quote can then be decided by a same-business user.
  const uL = await newUser(A.biz, "later");
  const qL = await quote(A, uL, null);
  const dL = await delUser(uL);
  ok("R16 after the sender is deleted, the quote is decided by a user of the business → accepted; by another business's → refused",
    succeeded(dL) && refused(await decide(A, qL, Bz.user), OTHER) && succeeded(await decide(A, qL, A.user)));
}

/** The function itself on a scratch table (created and dropped inside ONE rolled-back transaction — a TEMP table cannot
 * reference "User"): every combination, on one owner connection (savepoints keep it going). */
async function probe(A: B, Bz: B) {
  console.log("P. the function on a scratch table (owner; created inside a transaction that is rolled back)");
  // Every user first: the scratch table's foreign keys lock "User" until the transaction ends.
  const a2 = await newUser(A.biz, "p-a2"), a3 = await newUser(A.biz, "p-a3"), b2 = await newUser(Bz.biz, "p-b2");
  const d1 = await newUser(A.biz, "p-del1"), d2 = await newUser(A.biz, "p-del2"), mv = await newUser(A.biz, "p-move"), rn = await newUser(A.biz, "p-renum");
  const results: [string, boolean, string][] = [];
  await owner.$transaction(async (tx) => {
    const sp = async (sql: string, ...a: unknown[]): Promise<string | number> => {
      await tx.$executeRawUnsafe("SAVEPOINT p");
      try { const n = await tx.$executeRawUnsafe(sql, ...a); await tx.$executeRawUnsafe("RELEASE SAVEPOINT p"); return n; }
      catch (e) { await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT p"); return (e as Error).message; }
    };
    const row = async (id: number) => ((await tx.$queryRawUnsafe(`SELECT "businessId" AS biz, a, b, c FROM public.usb_probe WHERE id = $1`, id)) as Rows)[0] ?? {};
    const rec = (name: string, cond: boolean, detail: unknown = "") => results.push([name, cond, typeof detail === "string" ? detail : JSON.stringify(detail)]);
    await tx.$executeRawUnsafe(`CREATE TABLE usb_probe (id integer PRIMARY KEY, "businessId" integer NOT NULL, note text,
      a integer REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE, b integer REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
      c integer REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE)`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER usb_probe_user_same_business BEFORE INSERT OR UPDATE OF "businessId", a, b, c ON public.usb_probe
      FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('a', 'b', 'c')`);
    // A driver whose AFTER INSERT trigger runs the given statement — a write at trigger depth 2, as an FK action is.
    await tx.$executeRawUnsafe(`CREATE TABLE usb_driver (stmt text NOT NULL)`);
    await tx.$executeRawUnsafe(`CREATE FUNCTION public.usb_drive() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN EXECUTE NEW.stmt; RETURN NULL; END $f$`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER usb_driver_run AFTER INSERT ON public.usb_driver FOR EACH ROW EXECUTE FUNCTION public.usb_drive()`);
    const nested = (stmt: string) => sp(`INSERT INTO public.usb_driver (stmt) VALUES ($1)`, stmt);
    const ins = (id: number, biz: number, a: number | null, b: number | null, c: number | null) =>
      sp(`INSERT INTO public.usb_probe (id, "businessId", a, b, c) VALUES ($1, $2, $3, $4, $5)`, id, biz, a, b, c);
    const isOther = (r: unknown, col?: string) => typeof r === "string" && OTHER.test(r) && (!col || r.includes(`usb_probe.${col}`));

    rec("P1 INSERT: three users of the business (one repeated) → accepted", (await ins(1, A.biz, A.user, A.user, a2)) === 1);
    rec("P2 INSERT: one column naming another business's user → refused, whichever column", isOther(await ins(2, A.biz, A.user, b2, null), "b") && isOther(await ins(2, A.biz, null, null, b2), "c"));
    rec("P3 INSERT: a user id that does not exist → refused by the guard (no exception on INSERT)", isOther(await ins(2, A.biz, 2_000_000_001, null, null), "a"));
    rec("P4 INSERT: all NULL → accepted", (await ins(2, A.biz, null, null, null)) === 1);
    rec("P5 UPDATE: one column to another business's user → refused", isOther(await sp(`UPDATE public.usb_probe SET b = $1 WHERE id = 1`, b2), "b"));
    rec("P6 UPDATE several columns at once: a → NULL, b → another business's user → refused (b)", isOther(await sp(`UPDATE public.usb_probe SET a = NULL, b = $1 WHERE id = 1`, b2), "b"));
    rec("P7 UPDATE several columns at once: a → another business's user, b → a user of the business → refused (a)", isOther(await sp(`UPDATE public.usb_probe SET a = $1, b = $2 WHERE id = 1`, b2, a3), "a"));
    rec("P8 UPDATE swapping columns between users of the business → accepted", (await sp(`UPDATE public.usb_probe SET a = c, c = a WHERE id = 1`)) === 1);
    rec("P9 UPDATE the business under unchanged users → refused (every column's final value is judged)", isOther(await sp(`UPDATE public.usb_probe SET "businessId" = $1 WHERE id = 1`, Bz.biz)));
    rec("P10 UPDATE a column to a user id that does not exist → refused by the guard", isOther(await sp(`UPDATE public.usb_probe SET a = 2000000002 WHERE id = 1`), "a"));
    // Deleting a user in two / three columns of one row, and across rows.
    await ins(3, A.biz, d1, d1, d1); await ins(4, A.biz, d1, A.user, null);
    const del1 = await sp(`DELETE FROM "User" WHERE id = $1`, d1);
    const r3 = await row(3), r4 = await row(4);
    rec("P11 DELETE a user named in all three columns of one row and in another row → accepted; every reference NULL; other values kept",
      del1 === 1 && r3.a === null && r3.b === null && r3.c === null && r4.a === null && Number(r4.b) === A.user, { del1, r3, r4 });
    await ins(5, A.biz, null, d2, d2);
    const del2 = await sp(`DELETE FROM "User" WHERE id = $1`, d2);
    rec("P12 DELETE a user named in the two LAST columns (the first one NULL) → accepted", del2 === 1 && (await row(5)).b === null && (await row(5)).c === null, String(del2));
    // The exception, condition by condition (each is needed: removing any one of them lets one of these through).
    rec("P13 [nested write, CHANGED column] a nested UPDATE setting a column to a missing user → refused by the guard (unchanged-value condition)",
      isOther(await nested(`UPDATE public.usb_probe SET a = 2000000003 WHERE id = 4`), "a"));
    // A legacy illegal row: b names another business's user (the guard switched off by the owner to write it).
    await tx.$executeRawUnsafe(`ALTER TABLE public.usb_probe DISABLE TRIGGER usb_probe_user_same_business`);
    await ins(6, A.biz, A.user, b2, null);
    await tx.$executeRawUnsafe(`ALTER TABLE public.usb_probe ENABLE TRIGGER usb_probe_user_same_business`);
    rec("P14 [nested write, UNCHANGED column, user EXISTS in another business] a nested UPDATE of a → NULL on a row whose b names another business's user → refused (user-missing condition)",
      isOther(await nested(`UPDATE public.usb_probe SET a = NULL WHERE id = 6`), "b"));
    rec("P15 [ordinary write] the same UPDATE at depth 1 → refused (a legacy illegal value is never carried forward)",
      isOther(await sp(`UPDATE public.usb_probe SET a = NULL WHERE id = 6`), "b"));
    // A user moved to another business after being attached: unchanged, existing, other business → refused.
    await ins(7, A.biz, mv, A.user, null);
    await tx.$executeRawUnsafe(`UPDATE "User" SET "businessId" = $2 WHERE id = $1`, mv, Bz.biz);
    rec("P16 a user moved to another business stays refused on the next UPDATE of the row (b changed, a unchanged)",
      isOther(await sp(`UPDATE public.usb_probe SET b = $1 WHERE id = 7`, a2), "a"));
    rec("P17 … and deleting that moved user still works (the FK nulls a)", (await sp(`DELETE FROM "User" WHERE id = $1`, mv)) === 1 && (await row(7)).a === null);
    // A user renumbered while in two columns: both columns follow.
    await ins(8, A.biz, rn, rn, null);
    const rnr = await sp(`UPDATE "User" SET id = $2 WHERE id = $1`, rn, rn + 2_000_000);
    rec("P18 a user renumbered (ON UPDATE CASCADE) in two columns → accepted, both follow", rnr === 1 && Number((await row(8)).a) === rn + 2_000_000 && Number((await row(8)).b) === rn + 2_000_000);
    // A mistyped trigger argument is refused instead of passing as NULL.
    await tx.$executeRawUnsafe(`CREATE TABLE usb_typo ("businessId" integer NOT NULL, a integer)`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER usb_typo_user BEFORE INSERT ON public.usb_typo FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('a', 'actorUserID')`);
    const typo = await sp(`INSERT INTO public.usb_typo VALUES ($1, $2)`, A.biz, A.user);
    rec("P19 a trigger naming a column the table does not have → refused SERVICE_USER_COLUMN_UNKNOWN", typeof typo === "string" && /SERVICE_USER_COLUMN_UNKNOWN/.test(typo), String(typo));
    throw new Error("usb-probe-rollback");
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => { if (e.message !== "usb-probe-rollback") results.push(["P crashed", false, e.message]); });
  for (const [n, c, d] of results) ok(n, c, d);

  // P20 needs a superuser: a dangling id forced in with the foreign keys off (session_replication_role = replica).
  if (!superuser) { ok("P20 SUPER_URL is set (the dangling-reference check needs a superuser)", false); return; }
  const dg = await newUser(A.biz, "p-dangle");
  const out: string[] = [];
  await superuser.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TABLE usb_probe2 (id integer PRIMARY KEY, "businessId" integer NOT NULL,
      a integer REFERENCES "User"(id) ON DELETE SET NULL, b integer REFERENCES "User"(id) ON DELETE SET NULL)`);
    await tx.$executeRawUnsafe(`CREATE TRIGGER usb_probe2_user BEFORE INSERT OR UPDATE OF "businessId", a, b ON public.usb_probe2
      FOR EACH ROW EXECUTE FUNCTION public.service_user_same_business('a', 'b')`);
    await tx.$executeRawUnsafe(`INSERT INTO public.usb_probe2 VALUES (1, $1, $2, $2)`, A.biz, dg);
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, dg);
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`);
    await tx.$executeRawUnsafe("SAVEPOINT p");
    try { await tx.$executeRawUnsafe(`UPDATE public.usb_probe2 SET a = NULL WHERE id = 1`); out.push("accepted"); }
    catch (e) { out.push((e as Error).message); await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT p"); }
    throw new Error("usb-probe-rollback");
  }, { timeout: 60_000, maxWait: 60_000 }).catch((e: Error) => { if (e.message !== "usb-probe-rollback") out.push(`crash: ${e.message}`); });
  ok("P20 [ordinary write, UNCHANGED column, user MISSING] a dangling id forced in by a superuser is not carried by a depth-1 UPDATE → refused (nested-trigger condition)",
    out.length === 1 && OTHER.test(out[0]) && out[0].includes("usb_probe2.b"), out.join(" | "));
  ok("P21 the superuser's forced deletion was rolled back (the user exists)", num(await q(owner, null, `SELECT count(*)::int AS n FROM "User" WHERE id = $1`, dg)) === 1);
}

async function erasure() {
  console.log("E. erasure (account deletion's database stage) with one user in two columns of every table");
  const E = await business(`usb-erase-${run}`);
  const notice = await text(E, "STATUTORY_NOTICE", E.user, E.user);
  const u = await newUser(E.biz, "erase");
  const qE = await quote(E, u, u), xE = await externalWork(E, u, u), tE = await text(E, "TERMS", u, u), wE = await warrantyOffer(E, notice, u, u);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E.biz);
  const er = await inTx(runtime, E.biz, async (tx) => {
    for (const fn of ["service_erase_business", "service_external_erase_business", "service_parts_erase_business", "service_desk_ui_erase_business", "service_settings_journal_erase_business"]) {
      await tx.$queryRawUnsafe(`SELECT public.${fn}() AS n`);
    }
    return 1;
  });
  const z = await pick(`SELECT (SELECT "sentByUserId" IS NULL AND "decidedByUserId" IS NULL AND state = 'REJECTED' FROM "ServiceQuote" WHERE id = $1) AS q,
      (SELECT "sentByUserId" IS NULL AND "returnedByUserId" IS NULL AND "erasedAt" IS NOT NULL FROM "ServiceExternalWork" WHERE id = $2) AS x,
      (SELECT "createdByUserId" IS NULL AND "legallyApprovedByUserId" IS NULL AND "erasedAt" IS NOT NULL FROM "ServiceTextVersion" WHERE id = $3) AS t,
      (SELECT "createdByUserId" IS NULL AND "presentedByUserId" IS NULL AND "erasedAt" IS NOT NULL FROM "ServiceWarrantyOffer" WHERE id = $4) AS w`, qE, xE, tE, wE);
  ok("E1 the five erase functions run for a business being deleted → every user column NULL in one pass (quote, work, text, offer)",
    succeeded(er) && z.q === true && z.x === true && z.t === true && z.w === true, `${er} ${JSON.stringify(z)}`);
  ok("E2 the user is then deleted → accepted", succeeded(await delUser(u)));
  ok("E3 a second erasure pass is harmless (idempotent)", succeeded(await inTx(runtime, E.biz, (tx) => tx.$queryRawUnsafe(`SELECT public.service_erase_business() AS n, public.service_desk_ui_erase_business() AS m`))));
  // The erasure of a business whose user is DELETED first (the references already NULL by the FK).
  const E2 = await business(`usb-erase2-${run}`);
  const notice2 = await text(E2, "STATUTORY_NOTICE", E2.user, E2.user);
  const u2 = await newUser(E2.biz, "erase2");
  await quote(E2, u2, u2); await externalWork(E2, u2, u2); await text(E2, "TERMS", u2, u2); await warrantyOffer(E2, notice2, u2, u2);
  const d2 = await delUser(u2);
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, E2.biz);
  const er2 = await inTx(runtime, E2.biz, async (tx) => {
    for (const fn of ["service_erase_business", "service_external_erase_business", "service_parts_erase_business", "service_desk_ui_erase_business", "service_settings_journal_erase_business"]) {
      await tx.$queryRawUnsafe(`SELECT public.${fn}() AS n`);
    }
    return 1;
  });
  ok("E4 user deleted first (FK nulls both columns), then the erasure → both accepted", succeeded(d2) && succeeded(er2), `${d2} ${er2}`);
}

async function main() {
  if (MODE === "seed") { await seed(); return; }
  const present = num(await q(owner, null, `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'service_user_same_business' AND prosrc LIKE '%SERVICE_USER_COLUMN_UNKNOWN%'`));
  if (present !== 1) { ok("20261124090000 is applied (run the battery after the migration)", false); return; }
  await structure();
  await legacy();
  const A = await business(`usb-a-${run}`), Bz = await business(`usb-b-${run}`);
  await realTables(A, Bz);
  await probe(A, Bz);
  await erasure();
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect(); if (superuser) await superuser.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
