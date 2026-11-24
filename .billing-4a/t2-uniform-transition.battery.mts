/**
 * 4a T2 — the uniform-structure export ("מבנה אחיד") across "מעבר לעוסק מורשה", against the Production role topology
 * (.billing-4a/lab.sh). Lab proof only: NO product code changes, no migration, no Production.
 *
 * Owner decisions 2026-11-24: one file for the whole range even when it straddles the transition (D1); confirmedAt is
 * Dubiz's operational switch point (D2); the file structure, identity fields and printed reports stay as they are
 * (D3). This battery proves the existing export already behaves that way.
 *
 *   OWNER_URL     lab_owner: fixtures and read-back only
 *   DATABASE_URL  app_runtime_prod (NOBYPASSRLS LOGIN member of app_runtime): every issuance, the transition and every
 *                 export go through the application's own services on this connection, in the tenant transaction the
 *                 export route uses
 *
 *   U1 (T2-1)  identity fields are identical in the pre-transition, post-transition and straddling files:
 *              A000 1003/1015/1018, A100 1102, Z900 1152, B110 1402, C100 1202, D110 1252, D120 1302, the OPENFRMT path;
 *              1003 = the id number, 1015 empty (not a company), 1018 = the legal name
 *   U2 (T2-2)  a pre-transition range exported BEFORE and AFTER the transition: INI.TXT and BKMVDATA.TXT byte-identical,
 *              printed-report data (2.6, 5.4, summary) identical; so the profile's new kind and VAT number do not reach
 *              the file
 *   U3 (T2-3)  the straddling file = the pre and post files' documents (C100/D110/D120 identical except the running
 *              record number); receipts carry no D110 line, the new tax invoices carry their own VAT rates; INI
 *              summary counts = the records; Z900 total = the record count; report 2.6 sums = pre + post
 *   U4 (T2-4)  businesses that did not transition (an exempt and an authorized one): byte-identical before and after
 *   U5 (T2-5)  writes the three simulator packages (PRE / POST / STRADDLE, SIMULATOR software identity) +
 *              SHA256SUMS for the owner to upload to the ITA simulator; nothing is uploaded from here
 *
 * Synthetic only. ZERO secrets. ZERO network (fetch is trapped). The id number is a synthetic, check-digit-valid value.
 *
 *   OWNER_URL=… DATABASE_URL=… DIRECT_URL=… AUTH_TOKEN_SECRET=<synthetic> BILLING_PDF_STORAGE_ROOT=<tmp> \
 *   LOCAL_STORAGE_ROOT=<tmp> STORAGE_PROVIDER=local T2_OUT=<dir> npx tsx .billing-4a/t2-uniform-transition.battery.mts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts++;
  throw new Error("network disabled in this lab");
}) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}
function observed(name: string, value: unknown) {
  console.log(`  [OBSERVED] ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
type Rows = Record<string, unknown>[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}

async function main() {
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { loadUniformExportInput } = await import("@/lib/services/billing/uniform/uniform-export-loader");
  const { assembleUniformExportProjection } = await import("@/lib/services/billing/uniform/uniform-export-assembler");
  const { buildUniformExportFiles } = await import("@/lib/services/billing/uniform/uniform-file-builder");
  const { writeUniformExport } = await import("@/lib/services/billing/uniform/uniform-packaging");
  const { buildReport26Data, buildReport54Data, buildSummaryData } = await import("@/lib/services/billing/uniform/uniform-report-data");
  const { DUBIZ_SOFTWARE_CONFIG, SIMULATOR_SOFTWARE_CONFIG } = await import("@/lib/services/billing/uniform/uniform-config");
  const L = await import("@/lib/services/billing/uniform/uniform-layout-1_31");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { prisma: runtime } = await import("@/lib/prisma");

  // ------------------------------------------------------------------ posture
  const [who] = (await runtime.$queryRawUnsafe(
    `SELECT current_user::text AS who, r.rolsuper, r.rolbypassrls, pg_has_role(current_user, 'app_runtime', 'member') AS member
       FROM pg_roles r WHERE r.rolname = current_user`)) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean; member: boolean }>;
  ok("P0 the application runs as a NOBYPASSRLS, non-superuser member of app_runtime", !who.rolsuper && !who.rolbypassrls && who.member, who);
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  const replayed = await replayRepositoryRls(process.env.OWNER_URL!);
  ok("P0 replayed the repository's RLS statements (FORCE RLS on the billing tables)", replayed > 50, replayed);

  // ------------------------------------------------------------------ fixtures (owner)
  const stamp = Date.now();
  let n = 0;
  const TAX = withCheckDigit("30000000"); // synthetic, check-digit valid; path A: VAT number = id number
  const LEGAL_NAME = "דנה כהן";
  async function business(kind: "EXEMPT_DEALER" | "AUTHORIZED_DEALER", taxId: string, legalName: string) {
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t2-${stamp}-${++n}`)) as Rows;
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t2-${stamp}-${n}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`,
      businessId, kind, legalName, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    const dealer = await owner.customer.create({ data: { businessId, name: "לקוח עוסק מורשה", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    const priv = await owner.customer.create({ data: { businessId, name: "לקוח פרטי" } });
    return { businessId, userId: Number(u[0].id), dealerId: dealer.id, privateId: priv.id };
  }
  const deps = {
    executeApproval: async (input: { billingDocumentId: number }) =>
      ({ outcome: "completed_approved", billingDocumentId: input.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }),
  } as never;
  type Biz = Awaited<ReturnType<typeof business>>;
  const issue = (b: Biz, id: number) => issueBillingDocument({ businessId: b.businessId, billingDocumentId: id, actorUserId: b.userId }, deps);
  const receipt = async (b: Biz, amount: string) => {
    const d = await createReceiptDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: BillingDocumentType.RECEIPT, customerId: b.privateId, currency: "ILS",
      paymentLines: [{ method: "CASH", amount, paymentDate: new Date().toISOString() }] } as never);
    await issue(b, d.id);
    return d.id;
  };
  const invoice = async (b: Biz, documentType: BillingDocumentType, lines: Array<Record<string, string>>) => {
    const d = await createBillingDraft({ businessId: b.businessId, actorUserId: b.userId, documentType, customerId: b.privateId, initialLines: lines });
    await issue(b, d.id);
    return d.id;
  };

  // ------------------------------------------------------------------ the export, exactly as the route reads it
  const GENERATED_AT = new Date().toISOString();
  const PRIMARY_ID = "202611240000001";
  type Export = { ini: string; bkmv: string; iniBuf: Buffer; bkmvBuf: Buffer; meta: Record<string, unknown>; reports: string; built: ReturnType<typeof buildUniformExportFiles> };
  async function exportRange(b: Biz, start: string, end: string, cfg = DUBIZ_SOFTWARE_CONFIG): Promise<Export> {
    const input = await runWithTenantContext({ businessId: b.businessId }, () =>
      withTenantTransaction((tx) => loadUniformExportInput({ businessId: b.businessId, periodStart: start, periodEnd: end, client: tx as never })));
    const proj = assembleUniformExportProjection(input);
    const built = buildUniformExportFiles(proj, cfg, { primaryId: PRIMARY_ID, generatedAt: GENERATED_AT });
    const reports = JSON.stringify({ r26: buildReport26Data(proj, built.meta), r54: buildReport54Data(proj, built.meta, cfg), summary: buildSummaryData(proj, built.meta, cfg) });
    return { ini: built.iniText, bkmv: built.bkmvdataText, iniBuf: built.iniBuffer, bkmvBuf: built.bkmvdataBuffer, meta: built.meta as never, reports, built };
  }
  const recs = (text: string) => text.split("\r\n").filter((r) => r.length > 0);
  const of = (text: string, code: string) => recs(text).filter((r) => r.startsWith(code));
  function span(layout: { code: string; fields: Array<{ id: number; len: number }> }, id: number): [number, number] {
    let pos = 1;
    for (const f of layout.fields) { if (f.id === id) return [pos, pos + f.len - 1]; pos += f.len; }
    throw new Error(`field ${id} not in ${layout.code}`);
  }
  const field = (rec: string, layout: Parameters<typeof span>[0], id: number) => { const [a, z] = span(layout, id); return [...rec].slice(a - 1, z).join(""); };
  /** Every record minus its running record number (field 2: positions 5–13). */
  const body = (rec: string) => { const c = [...rec]; return c.slice(0, 4).join("") + c.slice(13).join(""); };
  function identity(e: Export) {
    const a000 = of(e.ini, "A000")[0];
    const a100 = of(e.bkmv, "A100")[0];
    const z900 = of(e.bkmv, "Z900")[0];
    const uniq = (xs: string[]) => [...new Set(xs)];
    return {
      a000_1003: field(a000, L.A000_LAYOUT, 1003), a000_1015: field(a000, L.A000_LAYOUT, 1015).trim(), a000_1018: field(a000, L.A000_LAYOUT, 1018).trim(),
      a000_1012: field(a000, L.A000_LAYOUT, 1012).trim(),
      a100_1102: field(a100, L.A100_LAYOUT, 1102), z900_1152: field(z900, L.Z900_LAYOUT, 1152),
      b110_1402: uniq(of(e.bkmv, "B110").map((r) => field(r, L.B110_LAYOUT, 1402))),
      c100_1202: uniq(of(e.bkmv, "C100").map((r) => field(r, L.C100_LAYOUT, 1202))),
      d110_1252: uniq(of(e.bkmv, "D110").map((r) => field(r, L.D110_LAYOUT, 1252))),
      d120_1302: uniq(of(e.bkmv, "D120").map((r) => field(r, L.D120_LAYOUT, 1302))),
    };
  }

  // ================================================================== before the transition
  const E = await business("EXEMPT_DEALER", TAX, LEGAL_NAME);
  const X = await business("EXEMPT_DEALER", withCheckDigit("30000001"), "יוסי לוי"); // never transitions
  const A = await business("AUTHORIZED_DEALER", withCheckDigit("30000002"), "רונית שמש"); // already authorized
  const t0 = new Date(Date.now() - 60_000).toISOString();
  console.log("\n— before the transition");
  const preReceipts = [await receipt(E, "100.00"), await receipt(E, "250.50"), await receipt(E, "75.00")];
  await receipt(X, "300.00"); await receipt(X, "40.00");
  await invoice(A, BillingDocumentType.TAX_INVOICE, [{ description: "שירות", quantity: "1", unitPrice: "500", vatRatePercent: "18" }]);
  await sleep(1100);
  const tPreEnd = new Date().toISOString();
  const PRE_before = await exportRange(E, t0, tPreEnd);
  const X_before = await exportRange(X, t0, tPreEnd);
  const A_before = await exportRange(A, t0, tPreEnd);
  ok("setup: the pre-transition file holds the 3 receipts (C100) and no D110", of(PRE_before.bkmv, "C100").length === 3 && of(PRE_before.bkmv, "D110").length === 0,
    { c100: of(PRE_before.bkmv, "C100").length, d110: of(PRE_before.bkmv, "D110").length });

  // ================================================================== the transition
  await sleep(1100);
  console.log("\n— the transition (application service → definer function)");
  const date = israelToday();
  const statementSha256 = kindTransitionStatementSha256({ businessId: E.businessId, actorUserId: E.userId, legalName: LEGAL_NAME, taxId: TAX, vatNumber: TAX, statusEffectiveDate: date });
  const result = await performKindTransition(E.businessId, E.userId, { vatNumber: TAX, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256 });
  ok("setup: performKindTransition → TRANSITIONED", result === "TRANSITIONED", result);
  const bkt = ((await owner.$queryRawUnsafe(`SELECT "confirmedAt" c FROM "BusinessKindTransition" WHERE "businessId" = $1`, E.businessId)) as Rows)[0];
  const confirmedAt = new Date(bkt.c as Date).toISOString();
  const prof = ((await owner.$queryRawUnsafe(`SELECT "billingBusinessKind" k, "billingVatNumber" v FROM "BusinessProfile" WHERE "businessId" = $1`, E.businessId)) as Rows)[0];
  ok("setup: the profile is now AUTHORIZED_DEALER with VAT number = id number", prof.k === "AUTHORIZED_DEALER" && prof.v === TAX, prof);
  observed("confirmedAt", confirmedAt);

  // ================================================================== after the transition
  await sleep(1100);
  console.log("\n— after the transition");
  await invoice(E, BillingDocumentType.TAX_INVOICE, [{ description: "שירות ייעוץ", quantity: "2", unitPrice: "450", vatRatePercent: "18" }]);
  await invoice(E, BillingDocumentType.TAX_INVOICE, [
    { description: "שירות", quantity: "1", unitPrice: "300", vatRatePercent: "18" },
    { description: "שירות לחו״ל", quantity: "1", unitPrice: "200", vatRatePercent: "0" },
  ]);
  await receipt(E, "120.00");
  await sleep(1100);
  const tEnd = new Date().toISOString();

  const PRE_after = await exportRange(E, t0, tPreEnd);
  const POST = await exportRange(E, confirmedAt, tEnd);
  const STRADDLE = await exportRange(E, t0, tEnd);
  const X_after = await exportRange(X, t0, tPreEnd);
  const A_after = await exportRange(A, t0, tPreEnd);

  // ================================================================== U1 (T2-1)
  console.log("\n— U1 (T2-1) identity fields: pre / post / straddling");
  const ids = { pre: identity(PRE_before), post: identity(POST), straddle: identity(STRADDLE) };
  observed("U1 identity (straddling file)", ids.straddle);
  // Header fields compared as values; per-record taxpayer fields compared as the set of values that occur (a file of
  // receipts only has no D110 record at all, which is content, not identity).
  const header = (i: ReturnType<typeof identity>) => JSON.stringify([i.a000_1003, i.a000_1015, i.a000_1018, i.a000_1012, i.a100_1102, i.z900_1152]);
  const perRecord = (i: ReturnType<typeof identity>) => [...new Set([...i.b110_1402, ...i.c100_1202, ...i.d110_1252, ...i.d120_1302])].sort().join(",");
  ok("U1 identity fields identical in the pre-transition, post-transition and straddling files (header + every per-record taxpayer field)",
    header(ids.pre) === header(ids.post) && header(ids.post) === header(ids.straddle)
      && perRecord(ids.pre) === perRecord(ids.post) && perRecord(ids.post) === perRecord(ids.straddle), ids);
  ok("U1 1003 (A000) = A100 1102 = Z900 1152 = every C100/D110/D120/B110 taxpayer field = the id number",
    [ids.straddle.a000_1003, ids.straddle.a100_1102, ids.straddle.z900_1152, ...ids.straddle.b110_1402, ...ids.straddle.c100_1202, ...ids.straddle.d110_1252, ...ids.straddle.d120_1302]
      .every((v) => v === TAX), ids.straddle);
  // 1015 is numeric: "empty" is written as zeros by the serializer.
  const blank = (v: string) => /^0*$/.test(v);
  ok("U1 1015 (company number) is blank (zeros): not a company, before or after", blank(ids.pre.a000_1015) && blank(ids.post.a000_1015) && blank(ids.straddle.a000_1015),
    [ids.pre.a000_1015, ids.post.a000_1015, ids.straddle.a000_1015]);
  ok("U1 1018 = the legal name, unchanged", ids.straddle.a000_1018 === LEGAL_NAME && ids.pre.a000_1018 === LEGAL_NAME, ids.straddle.a000_1018);

  // ================================================================== U2 (T2-2)
  console.log("\n— U2 (T2-2) the same pre-transition range, exported before and after the transition");
  ok("U2 BKMVDATA.TXT byte-identical (encoded bytes)", PRE_before.bkmvBuf.equals(PRE_after.bkmvBuf), { before: sha(PRE_before.bkmvBuf), after: sha(PRE_after.bkmvBuf) });
  ok("U2 INI.TXT byte-identical (encoded bytes)", PRE_before.iniBuf.equals(PRE_after.iniBuf), { before: sha(PRE_before.iniBuf), after: sha(PRE_after.iniBuf) });
  ok("U2 printed-report data (2.6, 5.4, summary) identical", PRE_before.reports === PRE_after.reports);

  // ================================================================== U3 (T2-3)
  console.log("\n— U3 (T2-3) the straddling file");
  const kinds = ["C100", "D110", "D120"];
  for (const k of kinds) {
    const want = [...of(PRE_after.bkmv, k), ...of(POST.bkmv, k)].map(body).sort();
    const got = of(STRADDLE.bkmv, k).map(body).sort();
    ok(`U3 straddling ${k} = pre ${k} + post ${k} (identical except the running record number)`, JSON.stringify(want) === JSON.stringify(got), { want: want.length, got: got.length });
  }
  const docType = (r: string) => field(r, L.C100_LAYOUT, 1203);
  const straddleTypes = of(STRADDLE.bkmv, "C100").map(docType).sort();
  observed("U3 straddling document types (C100 1203)", straddleTypes);
  ok("U3 straddling file: 4 receipts (400) + 2 tax invoices (305)", JSON.stringify(straddleTypes) === JSON.stringify(["305", "305", "400", "400", "400", "400"]), straddleTypes);
  const vatRates = of(STRADDLE.bkmv, "D110").map((r) => field(r, L.D110_LAYOUT, 1268).trim());
  observed("U3 D110 VAT rates (1268)", vatRates);
  ok("U3 D110 lines exist only for the post-transition tax invoices, each with its own VAT rate (18, 18, 0)",
    of(STRADDLE.bkmv, "D110").length === 3 && of(PRE_after.bkmv, "D110").length === 0, vatRates);
  const iniCounts = Object.fromEntries(of(STRADDLE.ini, "").filter((r) => !r.startsWith("A000")).map((r) => [r.slice(0, 4), Number(r.slice(4).trim())]));
  const actual = Object.fromEntries(["A100", "B110", "C100", "D110", "D120", "Z900"].map((k) => [k, of(STRADDLE.bkmv, k).length]));
  observed("U3 INI summary vs records", { iniCounts, actual });
  // The INI summarises the body records it lists (B110, C100, D110, D120), as in the package certified by the simulator.
  ok("U3 INI summary: every record type it lists has the BKMVDATA count", Object.keys(iniCounts).length === 4 && Object.entries(iniCounts).every(([k, v]) => actual[k] === v),
    { iniCounts, actual });
  const z = of(STRADDLE.bkmv, "Z900")[0];
  const zTotal = Number(field(z, L.Z900_LAYOUT, 1155).trim());
  ok("U3 Z900 1155 (total records) = every BKMVDATA record", zTotal === recs(STRADDLE.bkmv).length, { zTotal, records: recs(STRADDLE.bkmv).length });
  const r26 = (e: Export) => (JSON.parse(e.reports).r26.rows as Array<{ code: string; count: number; sumInclVat: string }>);
  const sumOf = (e: Export, code: string) => r26(e).filter((r) => r.code === code).reduce((s, r) => s + Number(r.sumInclVat), 0);
  const cntOf = (e: Export, code: string) => r26(e).filter((r) => r.code === code).reduce((s, r) => s + r.count, 0);
  ok("U3 report 2.6: per document type, straddling count and sum = pre + post",
    ["305", "400"].every((c) => cntOf(STRADDLE, c) === cntOf(PRE_after, c) + cntOf(POST, c) && Math.abs(sumOf(STRADDLE, c) - (sumOf(PRE_after, c) + sumOf(POST, c))) < 0.005),
    ["305", "400"].map((c) => ({ c, s: [cntOf(STRADDLE, c), sumOf(STRADDLE, c)], pre: [cntOf(PRE_after, c), sumOf(PRE_after, c)], post: [cntOf(POST, c), sumOf(POST, c)] })));

  // ================================================================== U4 (T2-4)
  console.log("\n— U4 (T2-4) businesses that did not transition");
  ok("U4 exempt business that never transitioned: INI + BKMVDATA byte-identical, report data identical",
    X_before.iniBuf.equals(X_after.iniBuf) && X_before.bkmvBuf.equals(X_after.bkmvBuf) && X_before.reports === X_after.reports);
  ok("U4 authorized business: INI + BKMVDATA byte-identical, report data identical",
    A_before.iniBuf.equals(A_after.iniBuf) && A_before.bkmvBuf.equals(A_after.bkmvBuf) && A_before.reports === A_after.reports);
  ok("U4 the other businesses' files carry only their own id number", identity(X_after).a000_1003 !== TAX && identity(A_after).a000_1003 !== TAX);

  // ================================================================== U5 (T2-5) simulator packages
  console.log("\n— U5 (T2-5) simulator packages");
  const out = process.env.T2_OUT;
  if (out) {
    const sums: string[] = [];
    const packages: Record<string, [string, string]> = { PRE: [t0, tPreEnd], POST: [confirmedAt, tEnd], STRADDLE: [t0, tEnd] };
    for (const [name, [s, e]] of Object.entries(packages)) {
      const ex = await exportRange(E, s, e, SIMULATOR_SOFTWARE_CONFIG);
      const w = await writeUniformExport(join(out, name), ex.built);
      for (const f of [w.iniPath, w.bkmvdataTxtPath]) sums.push(`${sha(readFileSync(f))}  ${relative(out, f).replace(/\\/g, "/")}`);
      observed(`U5 ${name}`, { range: [s, e], records: ex.meta.totalBkmvRecords, dir: relative(out, w.outputDir).replace(/\\/g, "/") });
    }
    writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
    const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]));
    ok("U5 three packages written (INI.TXT + BKMVDATA.TXT + BKMVDATA.zip each) + SHA256SUMS", files(out).length === 10, files(out).length);
  } else {
    console.log("  (T2_OUT not set: packages not written)");
  }

  ok("network: no fetch was attempted", networkAttempts === 0, networkAttempts);
  console.log(`\nT2 uniform-transition battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
  await owner.$disconnect();
  await runtime.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await owner.$disconnect();
});
