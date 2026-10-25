/**
 * Bank file import (milestone B1) — the application code on the lab database, as the RUNTIME role
 * (app_runtime_prod: NOSUPERUSER NOBYPASSRLS), through the same service the routes call.
 *
 *   A. Analyze writes nothing; it classifies every line and binds a token.
 *   B. Commit: the new lines land in ExternalTransaction (OWNER_UPLOAD, the account, the value date), one
 *      ImportRun with the file's hash, one audit event; nothing else.
 *   C. Replays: the same commit again, a fresh analyze + commit, the same file with another mapping — 0 rows.
 *   D. Both paths, every order this path can see: old without account → new; old with account → new;
 *      new → old with the account. And the one order it cannot see (new → old WITHOUT an account), recorded
 *      as a GAP: it closes only with the proposed old-path change (docs/bank-file-import-b1.md).
 *   E. Overlapping statements, identical lines, CSV then Excel of the same statement.
 *   F. Concurrency: the same file committed four times at once; two overlapping files at once; the old path
 *      and this path on the same file at once.
 *   G. Tenant isolation: another business's account, token, runs and lines.
 *   H. Tokens: forged, for another file, for another mapping.
 *   I. The flag: no row ⇒ OFF; policy OFF + business override ⇒ ON for that business only.
 *   J. Facts stay immutable; the existing systems are byte-identical before and after.
 *   K. The old path alone, unchanged: idempotent re-upload, its own identities.
 *
 * env: OWNER_URL (fixtures, BYPASSRLS), RUNTIME_URL (the app). Synthetic only. ZERO network.
 */
const RUNTIME_URL = process.env.RUNTIME_URL?.trim();
const OWNER_URL = process.env.OWNER_URL?.trim();
if (!RUNTIME_URL || !OWNER_URL || !/^postgres(ql)?:\/\//i.test(RUNTIME_URL) || /neon\.tech|vercel/i.test(RUNTIME_URL + OWNER_URL)) {
  console.error("ABORT (DB safety guard): OWNER_URL and RUNTIME_URL must name the ephemeral lab database.");
  process.exit(1);
}
process.env.DATABASE_URL = RUNTIME_URL;
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "bfi-lab-synthetic-token-secret";

import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
const gaps: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
function gap(name: string, observed: string) {
  gaps.push(`${name} (${observed})`);
  console.log(`  [GAP]  ${name} — ${observed}`);
}
async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e)); }
}

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
const day = (d: number) => `${String(d).padStart(2, "0")}/10/2026`;
/** A statement for days [from, to]: one debit per day, plus a salary credit on day 1. */
function statement(from: number, to: number, extra: string[][] = []): string[][] {
  const rows: string[][] = [["תאריך", "תיאור", "אסמכתא", "חובה", "זכות", "יתרה"]];
  for (let d = from; d <= to; d++) {
    if (d === 1) rows.push([day(d), "משכורת", "S1", "", "10000.00", ""]);
    rows.push([day(d), `ספק ${d}`, `R${d}`, `${(100 + d).toFixed(2)}`, "", ""]);
  }
  return [...rows, ...extra];
}
/** The same lines as the old path reads them: date, signed amount, description, reference. */
function oldCsv(rows: string[][]): string {
  return rows.map((r) => r.join(",")).join("\n");
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const svc = await import("@/lib/services/bank-file-import/bank-file-import.service");
  const { bankFileImportEnabled } = await import("@/lib/services/bank-file-import/http");
  const obs = await import("@/lib/services/payables/payables-observation.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const one = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { id: number }[])[0].id);
  const business = (name: string) => one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const user = (biz: number, tag: string) => one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${Date.now()}@bfi.lab`, biz);
  const account = (biz: number, tag: string) => one(
    `INSERT INTO "BusinessBankAccount" ("businessId", "label", "coordinatesEncrypted", "coordinatesIv", "coordinatesTag", "encryptionKeyId", "accountLast4", "fingerprint", "updatedAt")
     VALUES ($1, $2, 'lab', 'lab', 'lab', 'lab', '0000', $3, now()) RETURNING "id"`, biz, `חשבון ${tag}`, `fp-${tag}-${Date.now()}`);

  const lines = async (biz: number) => Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ExternalTransaction" WHERE "businessId" = $1`, biz)) as { n: number }[])[0].n);
  const distinctFacts = async (biz: number) => Number(((await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM (SELECT DISTINCT "bookedAt"::date, "direction", "amount", coalesce("reference", ''), coalesce("description", ''), "id" IS NOT NULL FROM "ExternalTransaction" WHERE "businessId" = $1) x`, biz)) as { n: number }[])[0].n);
  let accB = 0;
  const snapshot = async () => JSON.stringify(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentEvidence" t) AS pe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BusinessBankAccount" t WHERE t."id" <= ${accB}) AS ba`));

  // Fixtures.
  const bizA = await business("bfi-A");
  const bizB = await business("bfi-B");
  const userA = await user(bizA, "a");
  const userB = await user(bizB, "b");
  const accA = await account(bizA, "A1");
  const accA2 = await account(bizA, "A2");
  accB = await account(bizB, "B1");

  const input = (biz: number, uid: number, acc: number | null, bytes: Buffer, filename = "statement.csv", mapping: import("@/lib/services/bank-file-import/bank-file-core").BankMapping | null = null) =>
    ({ businessId: biz, userId: uid, accountId: acc, filename, bytes, sheetName: null, mapping });
  const analyze = (i: ReturnType<typeof input>) => runWithTenantContext({ businessId: i.businessId }, () => svc.analyzeBankFile(i));
  const commit = (i: ReturnType<typeof input>, token: unknown) => runWithTenantContext({ businessId: i.businessId }, () => svc.commitBankFile({ ...i, token }));
  const importFile = async (i: ReturnType<typeof input>) => { const p = await analyze(i); return { preview: p, result: await commit(i, p.token) }; };
  const oldUpload = (biz: number, uid: number, acc: number | null, text: string) =>
    runWithTenantContext({ businessId: biz }, () => obs.uploadStatement({ businessId: biz, actorUserId: uid, sourceBankAccountId: acc, csvText: text }));

  const before = await snapshot(); // after the first fixtures: later sections add businesses and accounts of their own

  // ── I. The flag ────────────────────────────────────────────────────────────────────────────────
  console.log("I. the flag");
  ok("no feature row: OFF for every business", !(await bankFileImportEnabled(bizA)) && !(await bankFileImportEnabled(bizB)));
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable", "createdAt")
    VALUES ('bank_file_import', 'קליטת קובצי בנק', 'integrations', 'lab', false, true, now()) ON CONFLICT ("key") DO NOTHING`);
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
    VALUES ('bank_file_import', false, false, now()) ON CONFLICT ("featureKey") DO NOTHING`);
  ok("the migration's rows (OFF): still OFF", !(await bankFileImportEnabled(bizA)));
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'bank_file_import', 'ENABLED', now())`, bizA);
  ok("a business override opens it for that business only", (await bankFileImportEnabled(bizA)) && !(await bankFileImportEnabled(bizB)));

  // ── A / B. Analyze, then commit ───────────────────────────────────────────────────────────────
  console.log("A/B. analyze writes nothing; commit writes the new lines, one run, one audit event");
  const fileAB = csv(statement(1, 5, [["xx/10/2026", "שבור", "", "1", "", ""]]));
  const auditBefore = await owner.payablesAuditEvent.count({ where: { businessId: bizA } });
  const p1 = await analyze(input(bizA, userA, accA, fileAB));
  ok("analyze: 6 lines, 6 new, 1 unreadable row", p1.counts.lines === 6 && p1.counts.new === 6 && p1.counts.invalid === 1, JSON.stringify(p1.counts));
  ok("analyze: the identity fields are locked to the payables upload's columns", p1.lockedFields.includes("date") && p1.lockedFields.includes("description"));
  ok("analyze: totals of the new lines (credit 10000.00, debit 515.00) in ILS", p1.newTotals.creditMinor === 1000000 && p1.newTotals.debitMinor === 51500 && p1.newTotals.currency === "ILS", JSON.stringify(p1.newTotals));
  ok("analyze: wrote nothing", (await lines(bizA)) === 0 && (await owner.importRun.count({ where: { businessId: bizA } })) === 0 && (await owner.payablesAuditEvent.count({ where: { businessId: bizA } })) === auditBefore);
  const r1 = await commit(input(bizA, userA, accA, fileAB), p1.token);
  ok("commit: 6 inserted", !r1.replayed && r1.inserted === 6 && r1.invalid === 1, JSON.stringify(r1));
  const rows = await owner.externalTransaction.findMany({ where: { businessId: bizA }, orderBy: { id: "asc" } });
  ok("rows: OWNER_UPLOAD, the chosen account, batch bnk-<run>", rows.every((r) => r.source === "OWNER_UPLOAD" && r.sourceBankAccountId === accA && r.importBatchId === `bnk-${r1.importRunId}`));
  ok("rows: the credit is CREDIT 10000.00, a debit is DEBIT 101.00", rows.some((r) => r.direction === "CREDIT" && r.amount.toFixed(2) === "10000.00") && rows.some((r) => r.direction === "DEBIT" && r.amount.toFixed(2) === "101.00"));
  const run = await owner.importRun.findUnique({ where: { id: r1.importRunId } });
  ok("ImportRun: bank_statement, COMPLETED, counts, the file's sha-256 (the file itself is not stored)", run?.domain === "bank_statement" && run.status === "COMPLETED" && run.createdCount === 6 && run.skippedCount === 0 && run.failedCount === 1 && /^[0-9a-f]{64}$/.test(run.contentHash));
  ok("one audit event for the commit", (await owner.payablesAuditEvent.count({ where: { businessId: bizA } })) === auditBefore + 1);

  // ── C. Replays ───────────────────────────────────────────────────────────────────────────────
  console.log("C. replays add nothing");
  const r1b = await commit(input(bizA, userA, accA, fileAB), p1.token);
  ok("the same commit again: replayed, the first outcome, 0 new rows", r1b.replayed && r1b.importRunId === r1.importRunId && (await lines(bizA)) === 6);
  const p1c = await analyze(input(bizA, userA, accA, fileAB));
  ok("a fresh analyze: all 6 known, and it says when this file was imported", p1c.counts.existing === 6 && p1c.counts.new === 0 && p1c.previouslyImportedAt !== null, JSON.stringify(p1c.counts));
  const p1d = await analyze(input(bizA, userA, accA, fileAB, "statement.csv", { balance: null }));
  const r1d = await commit(input(bizA, userA, accA, fileAB, "statement.csv", { balance: null }), p1d.token);
  ok("the same file with another mapping: a new run, 0 inserted", !r1d.replayed && r1d.inserted === 0 && (await lines(bizA)) === 6, JSON.stringify(r1d));

  // ── D. Both paths ────────────────────────────────────────────────────────────────────────────
  console.log("D. the payables upload (old path) and this path, both orders");
  const fileD1 = statement(6, 8);
  const oldNoAcc = await oldUpload(bizA, userA, null, oldCsv(fileD1));
  const afterOld = await lines(bizA);
  const nD1 = await importFile(input(bizA, userA, accA, csv(fileD1)));
  ok("old path WITHOUT an account, then this path: 0 inserted (both identities checked)", oldNoAcc.inserted === 3 && nD1.result.inserted === 0 && nD1.preview.counts.existing === 3 && (await lines(bizA)) === afterOld, JSON.stringify(nD1.result));

  const fileD2 = statement(9, 11);
  const oldAcc = await oldUpload(bizA, userA, accA, oldCsv(fileD2));
  const nD2 = await importFile(input(bizA, userA, accA, csv(fileD2)));
  ok("old path WITH the account, then this path: 0 inserted", oldAcc.inserted === 3 && nD2.result.inserted === 0, JSON.stringify(nD2.result));

  const fileD3 = statement(12, 14);
  const nD3 = await importFile(input(bizA, userA, accA, csv(fileD3)));
  const oldAfterNew = await oldUpload(bizA, userA, accA, oldCsv(fileD3));
  ok("this path, then the old path WITH the same account: 0 inserted (same identity, same unique key)", nD3.result.inserted === 3 && oldAfterNew.inserted === 0 && oldAfterNew.alreadyKnown === 3, JSON.stringify(oldAfterNew));

  const fileD4 = statement(15, 16);
  await importFile(input(bizA, userA, accA, csv(fileD4)));
  const oldNoAccAfterNew = await oldUpload(bizA, userA, null, oldCsv(fileD4));
  if (oldNoAccAfterNew.inserted === 0) ok("this path, then the old path WITHOUT an account: 0 inserted", true);
  else gap("this path, then the OLD path WITHOUT an account duplicates — the old path checks only its own identity", `${oldNoAccAfterNew.inserted} duplicate row(s)`);

  // ── E. Overlaps, identical lines, CSV then Excel ─────────────────────────────────────────────
  console.log("E. overlapping statements, identical lines, CSV then Excel");
  const bizE = await business("bfi-E");
  const userE = await user(bizE, "e");
  const accE = await account(bizE, "E1");
  const e1 = await importFile(input(bizE, userE, accE, csv(statement(1, 10))));
  const e2 = await importFile(input(bizE, userE, accE, csv(statement(5, 15))));
  ok("days 1–10 then days 5–15: 11 then 5 (only days 11–15 are new)", e1.result.inserted === 11 && e2.result.inserted === 5 && (await lines(bizE)) === 16, `${e1.result.inserted}/${e2.result.inserted}`);
  const twice = [["תאריך", "תיאור", "אסמכתא", "חובה", "זכות"], [day(20), "חניה", "", "20.00", ""], [day(20), "חניה", "", "20.00", ""]];
  const e3 = await importFile(input(bizE, userE, accE, csv(twice)));
  const thrice = [...twice, [day(20), "חניה", "", "20.00", ""]];
  const e4 = await importFile(input(bizE, userE, accE, csv(thrice)));
  ok("two identical charges are two rows; a later statement with three adds exactly one", e3.result.inserted === 2 && e4.result.inserted === 1 && e3.preview.counts.repeatedInFile === 1, `${e3.result.inserted}/${e4.result.inserted}`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("תנועות");
  ws.addRow(["תאריך", "תיאור", "אסמכתא", "חובה", "זכות"]);
  for (let d = 21; d <= 23; d++) ws.addRow([new Date(Date.UTC(2026, 9, d)), `ספק ${d}`, `R${d}`, 100 + d, null]);
  const xbytes = Buffer.from(await wb.xlsx.writeBuffer());
  const csvSame = [["תאריך", "תיאור", "אסמכתא", "חובה", "זכות"], ...[21, 22, 23].map((d) => [day(d), `ספק ${d}`, `R${d}`, `${100 + d}.00`, ""])];
  const e5 = await importFile(input(bizE, userE, accE, csv(csvSame)));
  const e6 = await importFile(input(bizE, userE, accE, xbytes, "statement.xlsx"));
  ok("CSV, then the Excel export of the same statement: 3 then 0", e5.result.inserted === 3 && e6.result.inserted === 0, `${e5.result.inserted}/${e6.result.inserted}`);
  const e7 = await importFile(input(bizE, userE, accE, csv(statement(1, 3)).subarray(0), "statement.csv"));
  ok("an account's lines do not hide another account's: the same file into the second account is new", (await importFile(input(bizA, userA, accA2, csv(statement(1, 2))))).result.inserted === 3 && e7.result.inserted === 0);

  // ── F. Concurrency ───────────────────────────────────────────────────────────────────────────
  console.log("F. concurrency");
  const bizF = await business("bfi-F");
  const userF = await user(bizF, "f");
  const accF = await account(bizF, "F1");
  const fileF = csv(statement(1, 20));
  const pF = await analyze(input(bizF, userF, accF, fileF));
  const four = await Promise.all([0, 1, 2, 3].map(() => commit(input(bizF, userF, accF, fileF), pF.token)));
  ok("the same file committed four times at once: one run inserts 21, three replay it", (await lines(bizF)) === 21 && four.filter((r) => !r.replayed).length === 1 && four.filter((r) => r.replayed).length === 3, JSON.stringify(four.map((r) => [r.replayed, r.inserted])));
  const bizF2 = await business("bfi-F2");
  const userF2 = await user(bizF2, "f2");
  const accF2 = await account(bizF2, "F2");
  const [x, y] = [csv(statement(1, 12)), csv(statement(8, 20))];
  const [px, py] = await Promise.all([analyze(input(bizF2, userF2, accF2, x)), analyze(input(bizF2, userF2, accF2, y))]);
  await Promise.all([commit(input(bizF2, userF2, accF2, x), px.token), commit(input(bizF2, userF2, accF2, y), py.token)]);
  ok("two overlapping files at once: exactly the union (21 lines), no line twice", (await lines(bizF2)) === 21 && (await distinctFacts(bizF2)) === 21);
  const bizF3 = await business("bfi-F3");
  const userF3 = await user(bizF3, "f3");
  const accF3 = await account(bizF3, "F3");
  const z = statement(1, 15);
  const pz = await analyze(input(bizF3, userF3, accF3, csv(z)));
  await Promise.all([commit(input(bizF3, userF3, accF3, csv(z)), pz.token), oldUpload(bizF3, userF3, accF3, oldCsv(z))]);
  ok("the old path and this path on the same file and account at once: 16 lines, not 32", (await lines(bizF3)) === 16);

  // ── G. Tenant isolation ──────────────────────────────────────────────────────────────────────
  console.log("G. tenant isolation");
  await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'bank_file_import', 'ENABLED', now())`, bizB);
  ok("another business's account is not found", (await errorCode(() => analyze(input(bizB, userB, accA, fileAB)))) === "ACCOUNT_NOT_FOUND");
  ok("another business's token is refused", (await errorCode(() => commit(input(bizB, userB, accB, fileAB), p1.token))) === "TOKEN_INVALID");
  const seenRuns = await tenantTx(bizB, (tx) => tx.importRun.count({ where: { businessId: bizA } }));
  const seenLines = await tenantTx(bizB, (tx) => tx.externalTransaction.count({ where: { businessId: bizA } }));
  ok("as the runtime in business B: none of A's runs or lines are visible", seenRuns === 0 && seenLines === 0);
  const gB = await importFile(input(bizB, userB, accB, fileAB));
  ok("the same file in business B is B's own: 6 inserted, A's lines untouched", gB.result.inserted === 6 && (await lines(bizB)) === 6);

  // ── H. Tokens ────────────────────────────────────────────────────────────────────────────────
  console.log("H. tokens");
  const fresh = csv(statement(25, 26));
  const pH = await analyze(input(bizA, userA, accA, fresh));
  const forged = pH.token.slice(0, -2) + (pH.token.endsWith("AA") ? "BB" : "AA");
  ok("a forged token is refused", (await errorCode(() => commit(input(bizA, userA, accA, fresh), forged))) === "TOKEN_INVALID");
  ok("the token for another user is refused", (await errorCode(() => commit(input(bizA, userA + 999, accA, fresh), pH.token))) === "TOKEN_INVALID");
  ok("the token for another account is refused", (await errorCode(() => commit(input(bizA, userA, accA2, fresh), pH.token))) === "TOKEN_INVALID");
  const edited = Buffer.concat([fresh, Buffer.from("\n")]);
  ok("a changed file with the old token is refused", (await errorCode(() => commit(input(bizA, userA, accA, edited), pH.token))) === "FILE_CHANGED");
  ok("another mapping with the old token is refused", (await errorCode(() => commit(input(bizA, userA, accA, fresh, "statement.csv", { balance: null }), pH.token))) === "FILE_CHANGED");
  ok("no account: refused before reading anything", (await errorCode(() => analyze(input(bizA, userA, null, fresh)))) === "ACCOUNT_REQUIRED");

  // ── J. Immutability, the existing systems ───────────────────────────────────────────────────
  console.log("J. facts immutable, the existing systems untouched");
  const target = (await owner.externalTransaction.findFirst({ where: { businessId: bizA, importBatchId: { startsWith: "bnk-" } } }))!;
  const upd = await errorCode(() => tenantTx(bizA, (tx) => tx.externalTransaction.update({ where: { id: target.id }, data: { description: "changed" } })));
  ok("an imported line's facts cannot be changed (trigger)", /immutable/i.test(upd), upd);
  ok("FinancialEvent, FinancialRecord, BillingDocument, PaymentTransaction, PaymentEvidence and the accounts present before: byte-identical", (await snapshot()) === before);

  // ── K. The old path alone ────────────────────────────────────────────────────────────────────
  console.log("K. the payables upload alone, unchanged");
  const bizK = await business("bfi-K");
  const userK = await user(bizK, "k");
  const accK = await account(bizK, "K1");
  const k = oldCsv(statement(1, 4));
  const k1 = await oldUpload(bizK, userK, accK, k);
  const k2 = await oldUpload(bizK, userK, accK, k);
  ok("old path: 5 inserted, then a re-upload adds 0", k1.inserted === 5 && k2.inserted === 0 && k2.alreadyKnown === 5, `${k1.inserted}/${k2.inserted}`);
  const kRows = await owner.externalTransaction.findMany({ where: { businessId: bizK }, select: { externalId: true, importBatchId: true, valueDate: true } });
  ok("old path: its own identity scheme and batch id, no value date (as before)", kRows.every((r) => r.externalId.startsWith("upl:") && (r.importBatchId ?? "").startsWith("upl-") && r.valueDate === null));
  const kList = await runWithTenantContext({ businessId: bizK }, () => obs.listObservations({ businessId: bizK, scope: "open" }));
  ok("old path: the payables list shows its 4 debit lines and not the salary credit", kList.length === 4 && kList.every((l) => l.direction === "DEBIT"), JSON.stringify(kList.map((l) => l.direction)));
  const eList = await runWithTenantContext({ businessId: bizE }, () => obs.listObservations({ businessId: bizE, scope: "open" }));
  const eDebits = await owner.externalTransaction.count({ where: { businessId: bizE, direction: "DEBIT" } });
  ok("lines imported by this path appear in the payables list exactly like uploaded ones (debits only)", eList.length === eDebits && eList.every((l) => l.direction === "DEBIT"), `${eList.length}/${eDebits}`);

  console.log(`\n${pass}/${pass + failures.length} passed${gaps.length ? `, ${gaps.length} known gap(s)` : ""}`);
  for (const g of gaps) console.log(`  GAP: ${g}`);
  await owner.$disconnect();
  if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
