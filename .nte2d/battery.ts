/**
 * Notifications docs + appointments — what migration 20261213090000_notification_docs_stuck_appointment_lead does,
 * measured with the real role topology on a Production-shaped database (.nte2d/lab.sh <db> --with-nte2d, which chains
 * the activation lab .nte2c/lab.sh --with-nte2c):
 *   owner    (lab_owner: the migration role, BYPASSRLS like Production's; fixtures),
 *   runtime  (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the application), its session in
 *            Asia/Jerusalem so a stamp in the session's zone would show.
 *
 *   1. History (NTE2D_SEED rows written before the release): every seeded document keeps its status and reads NULL
 *      in "statusChangedAt" (the one stuck in processing since October included — never flagged); the seeded
 *      settings row reads NULL lead time (the default) and keeps its other values.
 *   2. Catalog: "Document" RLS enabled + forced with exactly p7w4d_tenant and p7adm_read (unchanged); the trigger
 *      BEFORE row on a new row / a change of status or statusChangedAt; the function invoker, search_path pinned, no
 *      EXECUTE for PUBLIC / app_runtime; app_admin cannot read the new column; the runtime's column privileges equal
 *      those on status; the lead-time CHECK validated.
 *   3. The trigger, through the application's own statements as the runtime: upload INSERT (processing) is stamped at
 *      the statement's UTC wall clock (also when the statement passes its own value); the pipeline's processing →
 *      needs_review / → failed restamp; the source-missing failed → failed and a needs_review re-save do NOT; the
 *      retry failed → processing and processing → processing DO (a new attempt); writes of other columns (OCR text,
 *      hashes) and a hand-written stamp (alone or with an unchanged status) leave it; approve (needs_review →
 *      approved) restamps; a historical row's first real change stamps it, an unrelated write leaves it NULL.
 *   4. RLS in action: another business's document is invisible and unwritable for the runtime; without a tenant
 *      nothing is visible.
 *   5. NotificationSettings: the runtime stores 30 / 60 / 120 / 1440 and NULL for its own user; 0, 45, 90, 1441, -60
 *      are refused by the CHECK; another business's row is invisible / unwritable; the settings route's statements
 *      without the new column keep working.
 *   6. Erasure: a business deleted takes its documents and settings rows (cascade unchanged).
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

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
    await tx.$executeRawUnsafe(`SET LOCAL TimeZone = 'Asia/Jerusalem'`);
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => `ERR ${e.message}`);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, y) => (typeof y === "bigint" ? Number(y) : y));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const isErr = (r: unknown): r is string => typeof r === "string" && r.startsWith("ERR ");
const why = (r: unknown) => (isErr(r) ? r.slice(0, 240) : J(r).slice(0, 240));
const ts = (d: unknown) => (d instanceof Date ? d.getTime() : null);
const one = async (sql: string, ...args: unknown[]) => rows(await owner.$queryRawUnsafe(sql, ...args))[0] ?? {};

async function stamp(id: number): Promise<{ status: string; at: Date | null }> {
  const r = await one(`SELECT "status", "statusChangedAt" AS at FROM "Document" WHERE "id" = $1`, id);
  return { status: String(r.status), at: (r.at as Date | null) ?? null };
}
/** The database's UTC wall clock now, as the application's timestamp(3) columns hold it. */
async function utcNow(): Promise<number> {
  const r = await one(`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS t`);
  return ts(r.t)!;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);

  console.log("1. History — seeded rows unchanged, never stamped");
  const seedBiz = Number((await one(`SELECT "id" FROM "Business" WHERE "name" = 'nte2d-seed'`)).id);
  const seeded = rows(await owner.$queryRawUnsafe(
    `SELECT "id", "status", "statusChangedAt" AS at, "createdAt" FROM "Document" WHERE "businessId" = $1 ORDER BY "id"`, seedBiz));
  ok("four seeded documents present with their statuses", J(seeded.map((r) => r.status)) === J(["processing", "needs_review", "failed", "approved"]), why(seeded));
  ok("every seeded document reads NULL statusChangedAt (history unstamped)", seeded.length === 4 && seeded.every((r) => r.at === null), why(seeded));
  const seedSettings = await one(`SELECT "quietHoursEnabled" AS q, "quietStartMinute" AS s, "quietEndMinute" AS e, "appointmentReminderMinutes" AS lead
    FROM "NotificationSettings" WHERE "businessId" = $1`, seedBiz);
  ok("seeded settings row: lead time NULL (the default), other values kept", seedSettings.lead === null && seedSettings.q === true && seedSettings.s === 1320 && seedSettings.e === 420, why(seedSettings));

  console.log("2. Catalog");
  const docRls = await one(`SELECT relrowsecurity AND relforcerowsecurity AS forced,
      (SELECT array_agg(polname::text ORDER BY polname::text) FROM pg_policy WHERE polrelid = '"Document"'::regclass) AS pols
    FROM pg_class WHERE oid = '"Document"'::regclass`);
  ok("Document: RLS enabled + forced, exactly p7adm_read + p7w4d_tenant", docRls.forced === true && J(docRls.pols) === J(["p7adm_read", "p7w4d_tenant"]), why(docRls));
  const tg = await one(`SELECT tgtype, tgenabled,
      (SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute WHERE attrelid = t.tgrelid AND attnum = ANY (t.tgattr::int2[])) AS cols
    FROM pg_trigger t WHERE tgname = 'Document_status_changed_at'`);
  ok("trigger: BEFORE row, new row + change of status / statusChangedAt, enabled", tg.tgtype === 23 && tg.tgenabled === "O" && J(tg.cols) === J(["status", "statusChangedAt"]), why(tg));
  const fn = await one(`SELECT prosecdef, proconfig,
      has_function_privilege('app_runtime', 'public.document_status_changed_at()', 'EXECUTE') AS rt,
      EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl, acldefault('f', proowner))) a WHERE a.grantee = 0) AS pub
    FROM pg_proc WHERE proname = 'document_status_changed_at'`);
  ok("function: invoker, search_path pinned, no EXECUTE for PUBLIC / app_runtime",
    fn.prosecdef === false && J(fn.proconfig) === J(["search_path=pg_catalog, public, pg_temp"]) && fn.rt === false && fn.pub === false, why(fn));
  const priv = await one(`SELECT has_column_privilege('app_admin', '"Document"', 'statusChangedAt', 'SELECT') AS adm_new,
      has_column_privilege('app_admin', '"Document"', 'status', 'SELECT') AS adm_status,
      has_column_privilege('app_runtime', '"Document"', 'statusChangedAt', 'SELECT') = has_column_privilege('app_runtime', '"Document"', 'status', 'SELECT')
      AND has_column_privilege('app_runtime', '"Document"', 'statusChangedAt', 'UPDATE') = has_column_privilege('app_runtime', '"Document"', 'status', 'UPDATE')
      AND has_column_privilege('app_runtime', '"Document"', 'statusChangedAt', 'INSERT') = has_column_privilege('app_runtime', '"Document"', 'status', 'INSERT') AS rt_same`);
  ok("privileges: app_admin's column grants do not reach the new column (status still readable); runtime same as on status",
    priv.adm_new === false && priv.adm_status === true && priv.rt_same === true, why(priv));
  const chk = await one(`SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'NotificationSettings_appointment_reminder'`);
  ok("lead-time CHECK validated (30, 60, 120, 1440 or NULL)", chk.convalidated === true && String(chk.def).includes("ARRAY[30, 60, 120, 1440]"), why(chk));

  console.log("3. The trigger through the application's statements (runtime, session in Asia/Jerusalem)");
  const A = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('nte2d-a', now()) RETURNING "id"`);
  const B = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('nte2d-b', now()) RETURNING "id"`);
  // document-ingestion.service.ts / upload route: tx.document.create({ status: "processing", ... })
  const insertDoc = (biz: number, extra = "", vals = "") => q(runtime, biz,
    `INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "ocrText", "contentHashSha256", "originalFilename", "sizeBytes"${extra})
     VALUES ($1, 'f.pdf', 'upload', 'application/pdf', 'processing', NULL, 'abc', 'f.pdf', 10${vals}) RETURNING "id"`, biz);
  const before = await utcNow();
  const ins = await insertDoc(A);
  const after = await utcNow();
  const d1 = Number(rows(ins)[0]?.id);
  let s = await stamp(d1);
  ok("upload INSERT (processing) is stamped at the statement's UTC wall clock", s.at !== null && ts(s.at)! >= before - 1000 && ts(s.at)! <= after + 1000, `${why(ins)} ${s.at?.toISOString()} [${new Date(before).toISOString()}..]`);
  const insOwn = await insertDoc(A, `, "statusChangedAt"`, `, TIMESTAMP '2020-01-01 00:00:00'`);
  const d2 = Number(rows(insOwn)[0]?.id);
  const s2 = await stamp(d2);
  ok("an INSERT passing its own statusChangedAt is stamped by the trigger instead", s2.at !== null && s2.at.getUTCFullYear() === 2026, why(s2));

  const upd = (biz: number, set: string, id: number) => x(runtime, biz, `UPDATE "Document" SET ${set} WHERE "id" = $1 AND "businessId" = $2`, id, biz);
  const restampedBy = async (label: string, set: string, id: number, expect: boolean) => {
    const was = await stamp(id);
    await pause(30);
    const r = await upd(A, set, id);
    const now = await stamp(id);
    const moved = ts(now.at) !== ts(was.at);
    ok(`${label} → ${expect ? "restamped" : "stamp unchanged"}`, !isErr(r) && r === 1 && moved === expect, `${why(r)} was=${was.at?.toISOString()} now=${now.at?.toISOString()}`);
  };
  // process-document-pipeline.service.ts: tx.document.update({ data: { ocrText, ..., status: "needs_review" } })
  await restampedBy("pipeline: processing → needs_review (with OCR text)", `"ocrText" = 'text', "status" = 'needs_review'`, d1, true);
  await restampedBy("a re-save needs_review → needs_review", `"status" = 'needs_review'`, d1, false);
  await restampedBy("OCR text / hash write without status", `"ocrText" = 'text2', "contentHashSha256" = 'def'`, d1, false);
  await restampedBy("a hand-written stamp alone", `"statusChangedAt" = TIMESTAMP '2020-01-01 00:00:00'`, d1, false);
  await restampedBy("a hand-written stamp with an unchanged status", `"status" = 'needs_review', "statusChangedAt" = TIMESTAMP '2020-01-01 00:00:00'`, d1, false);
  // app/api/documents/[id]/approve: tx.document.updateMany({ where: { status: ... }, data: { status: "approved" } })
  await restampedBy("approve: needs_review → approved", `"status" = 'approved'`, d1, true);
  // pipeline failure: tx.document.update({ data: { status: "failed" } })
  await restampedBy("pipeline: processing → failed", `"status" = 'failed'`, d2, true);
  // process route, source missing: tx.document.updateMany({ data: { status: "failed" } }) on a failed document
  await restampedBy("source missing: failed → failed", `"status" = 'failed'`, d2, false);
  // process route, retry: tx.document.updateMany({ data: { status: "processing" } })
  await restampedBy("retry: failed → processing (a new attempt)", `"status" = 'processing'`, d2, true);
  await restampedBy("retry again: processing → processing (a new attempt)", `"status" = 'processing'`, d2, true);
  const viaPrismaShape = await inTx(runtime, A, (tx) =>
    tx.$executeRaw`UPDATE "Document" SET "status" = ${"needs_review"} WHERE "id" = ${d2} AND "businessId" = ${A} AND "status" IN (${"processing"}, ${"failed"})`);
  s = await stamp(d2);
  ok("a parameterised conditional update (Prisma's shape) works and stamps", viaPrismaShape === 1 && s.status === "needs_review" && s.at !== null, why(viaPrismaShape));
  const stampTz = await one(`SELECT abs(extract(epoch FROM ("statusChangedAt" - (now() AT TIME ZONE 'UTC')::timestamp(3)))) < 120 AS utc FROM "Document" WHERE "id" = $1`, d2);
  ok("the stamp is the UTC wall clock, not the session's Asia/Jerusalem clock", stampTz.utc === true, why(stampTz));

  // History: the seeded processing row — an unrelated write leaves it NULL; its first real change stamps it.
  const hist = Number(seeded[0].id);
  const h1 = await x(runtime, seedBiz, `UPDATE "Document" SET "originalFilename" = 'renamed.pdf' WHERE "id" = $1`, hist);
  ok("history: an unrelated write leaves a historical row unstamped", h1 === 1 && (await stamp(hist)).at === null, why(h1));
  const h2 = await x(runtime, seedBiz, `UPDATE "Document" SET "status" = 'failed' WHERE "id" = $1`, hist);
  ok("history: its first real status change stamps it", h2 === 1 && (await stamp(hist)).at !== null, why(h2));

  console.log("4. RLS in action");
  const dB = Number(rows(await insertDoc(B))[0]?.id);
  const seeB = await q(runtime, A, `SELECT count(*)::int AS n FROM "Document" WHERE "id" = $1`, dB);
  ok("tenant A cannot see B's document", rows(seeB)[0]?.n === 0, why(seeB));
  const writeB = await x(runtime, A, `UPDATE "Document" SET "status" = 'failed' WHERE "id" = $1`, dB);
  ok("tenant A cannot change B's document (0 rows; B's stamp unchanged)", writeB === 0 && (await stamp(dB)).status === "processing", why(writeB));
  const noTenant = await q(runtime, null, `SELECT count(*)::int AS n FROM "Document"`);
  ok("without a tenant nothing is visible", rows(noTenant)[0]?.n === 0, why(noTenant));
  const insCross = await q(runtime, A, `INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status") VALUES ($1, 'x', 'upload', 'x', 'processing') RETURNING "id"`, B);
  ok("tenant A cannot add a document to B", isErr(insCross), why(insCross));

  console.log("5. NotificationSettings.appointmentReminderMinutes");
  const uA = await mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('a@nte2d.lab', 'x', $1, now()) RETURNING "id"`, A);
  const uB = await mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('b@nte2d.lab', 'x', $1, now()) RETURNING "id"`, B);
  // preferences-store.ts patchSettings: upsert by (businessId, userId) — the route's statement without the new column.
  const legacy = await x(runtime, A, `INSERT INTO "NotificationSettings" ("businessId", "userId", "pushEnabled", "updatedAt") VALUES ($1, $2, true, now())
    ON CONFLICT ("businessId", "userId") DO UPDATE SET "pushEnabled" = EXCLUDED."pushEnabled", "updatedAt" = EXCLUDED."updatedAt"`, A, uA);
  ok("the settings route's upsert without the new column works (lead NULL = default)", legacy === 1
    && (await one(`SELECT "appointmentReminderMinutes" AS l FROM "NotificationSettings" WHERE "userId" = $1`, uA)).l === null, why(legacy));
  for (const v of [30, 60, 120, 1440]) {
    const r = await x(runtime, A, `UPDATE "NotificationSettings" SET "appointmentReminderMinutes" = $1 WHERE "businessId" = $2 AND "userId" = $3`, v, A, uA);
    ok(`lead ${v} accepted`, r === 1 && (await one(`SELECT "appointmentReminderMinutes" AS l FROM "NotificationSettings" WHERE "userId" = $1`, uA)).l === v, why(r));
  }
  for (const v of [0, 45, 90, 1441, -60]) {
    const r = await x(runtime, A, `UPDATE "NotificationSettings" SET "appointmentReminderMinutes" = $1 WHERE "businessId" = $2 AND "userId" = $3`, v, A, uA);
    ok(`lead ${v} refused by the CHECK`, isErr(r) && /NotificationSettings_appointment_reminder|check constraint/i.test(r), why(r));
  }
  const toNull = await x(runtime, A, `UPDATE "NotificationSettings" SET "appointmentReminderMinutes" = NULL WHERE "businessId" = $1 AND "userId" = $2`, A, uA);
  ok("lead NULL (back to the default) accepted", toNull === 1, why(toNull));
  const bRow = await x(runtime, B, `INSERT INTO "NotificationSettings" ("businessId", "userId", "appointmentReminderMinutes", "updatedAt") VALUES ($1, $2, 120, now())`, B, uB);
  ok("B's user stores its own lead (120)", bRow === 1, why(bRow));
  const crossRead = await q(runtime, A, `SELECT count(*)::int AS n FROM "NotificationSettings" WHERE "userId" = $1`, uB);
  const crossWrite = await x(runtime, A, `UPDATE "NotificationSettings" SET "appointmentReminderMinutes" = 30 WHERE "userId" = $1`, uB);
  ok("tenant A can neither read nor change B's lead time", rows(crossRead)[0]?.n === 0 && crossWrite === 0
    && (await one(`SELECT "appointmentReminderMinutes" AS l FROM "NotificationSettings" WHERE "userId" = $1`, uB)).l === 120, `${why(crossRead)} ${why(crossWrite)}`);
  const crossUser = await x(runtime, A, `INSERT INTO "NotificationSettings" ("businessId", "userId", "appointmentReminderMinutes", "updatedAt") VALUES ($1, $2, 30, now())`, A, uB);
  ok("a row for B's user under A is refused (same-business trigger / RLS)", isErr(crossUser), why(crossUser));

  console.log("6. Erasure cascade unchanged");
  const gone = await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE "id" = $1`, B);
  const left = await one(`SELECT (SELECT count(*)::int FROM "Document" WHERE "businessId" = $1) + (SELECT count(*)::int FROM "NotificationSettings" WHERE "businessId" = $1) AS n`, B);
  ok("deleting a business takes its documents and settings rows", gone === 1 && left.n === 0, why(left));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await owner.$disconnect();
  await runtime.$disconnect();
});
