/**
 * SEC-F migration battery — append-only audit trails, chain linkage, fiscal
 * immutability, SecurityEvent. Runs against a FRESH lab (./lab.mjs) every time.
 *
 *   phase 0  build the lab (main's schema + main's RLS rules, over-granted runtime)
 *   phase 1  BASELINE: reproduce each gap on main (the runtime rewrites an audit
 *            row; the owner rewrites an ISSUED invoice's total)
 *   phase 2  apply the SEC-F migration as the owner
 *   phase 3  every control, positive and negative, with the SPECIFIC SQLSTATE
 *
 * Output lines are `[PASS] <ID> …` / `[FAIL] <ID> …`; ids are what the negative
 * proof driver (./negative-proofs.mjs) keys on. Exit 0 = all pass, 1 = a control
 * failed, 2 = the lab could not be built (a setup crash is never a pass).
 *
 * Denials are classified, never merely "it threw": 42501 privilege / RLS,
 * DZ001 append-only, DZ002 chain link, DZ010 fiscal, 23503/23001 FK restrict, 23505 unique,
 * 23514 check. Anything else (connection error, missing table, ReferenceError)
 * fails the assertion it happened in.
 */
import { PrismaClient } from "@prisma/client";
import { SECF_MIGRATION, applyMigrationFile, freshLab } from "./lab.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function ok(id, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${id}`); }
  else { fail++; failures.push(id); console.log(`  [FAIL] ${id}${detail ? " — " + detail : ""}`); }
}

/** SQLSTATE of a Prisma raw-query error, or a label for anything that is not one. */
function sqlstate(e) {
  if (!e) return "NO_ERROR";
  const m = e?.meta?.code ?? /Code: `([0-9A-Z]{5})`/.exec(String(e?.message))?.[1];
  if (m) return m;
  const pg = /\b(4\d\d\d\d|2\d\d\d\d|DZ\d\d\d|P\d\d\d\d)\b/.exec(String(e?.message));
  return pg ? pg[1] : `NOT_SQL:${String(e?.message ?? e).slice(0, 120)}`;
}
async function attempt(fn) {
  try { const r = await fn(); return { err: null, result: r }; } catch (e) { return { err: e, result: null }; }
}
async function expectCode(id, fn, code, msgRe) {
  const { err } = await attempt(fn);
  const got = sqlstate(err);
  const msg = String(err?.meta?.message ?? err?.message ?? "");
  const codes = Array.isArray(code) ? code : [code];
  ok(id, codes.includes(got) && (!msgRe || msgRe.test(msg)), `expected ${codes.join("|")}${msgRe ? " " + msgRe : ""}, got ${got}: ${msg.slice(0, 200)}`);
}
async function expectOk(id, fn, check = () => true) {
  const { err, result } = await attempt(fn);
  let cond = !err;
  let detail = err ? `${sqlstate(err)}: ${String(err?.meta?.message ?? err?.message).slice(0, 200)}` : "";
  if (cond) {
    const c = await check(result);
    if (c !== true) { cond = false; detail = typeof c === "string" ? c : "post-condition failed"; }
  }
  ok(id, cond, detail);
  return result;
}

const AUDIT = ["BillingAuditEvent", "PaymentAuditEvent", "PayablesAuditEvent"];
const HEX = (c) => c.repeat(64);

async function main() {
  // ── phase 0 ───────────────────────────────────────────────────────────────
  console.log("== phase 0: fresh lab ==");
  let lab;
  try {
    lab = await freshLab();
  } catch (e) {
    console.log(`[SETUP-ERROR] ${String(e?.stderr ?? "")}${String(e?.message ?? e)}`);
    process.exit(2);
  }
  console.log(`  lab ready; ${lab.replayed} RLS statements replayed from main's migrations`);
  const owner = new PrismaClient({ datasourceUrl: lab.ownerUrl });
  const rt = new PrismaClient({ datasourceUrl: lab.rtUrl });
  const adm = new PrismaClient({ datasourceUrl: lab.admUrl });

  const asTenant = (client, bid, fn) =>
    client.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(bid));
      return fn(tx);
    });
  const one = async (client, sql, ...params) => (await client.$queryRawUnsafe(sql, ...params))[0];

  // Fixtures (owner, which bypasses RLS like a managed-PG migration owner).
  const bizA = (await one(owner, `INSERT INTO "Business"("name","updatedAt") VALUES ('secf-A', now()) RETURNING id`)).id;
  const bizB = (await one(owner, `INSERT INTO "Business"("name","updatedAt") VALUES ('secf-B', now()) RETURNING id`)).id;
  const bizC = (await one(owner, `INSERT INTO "Business"("name","updatedAt") VALUES ('secf-C', now()) RETURNING id`)).id;
  const auditRow = async (client, t, bid, extra = {}) => {
    const cols = ["businessId", "eventType", "summary", "eventHash", ...Object.keys(extra)];
    const vals = [bid, "SECF_TEST", "secf", HEX("0"), ...Object.values(extra)];
    const ph = vals.map((_, i) => `$${i + 1}`).join(",");
    return client.$executeRawUnsafe(`INSERT INTO "${t}"(${cols.map((c) => `"${c}"`).join(",")}) VALUES (${ph})`, ...vals);
  };
  for (const t of AUDIT) {
    await auditRow(owner, t, bizA);
    await auditRow(owner, t, bizB);
  }
  const mkDoc = async (client, bid, type, extra = "") =>
    (await one(client, `INSERT INTO "BillingDocument"("businessId","documentType","updatedAt"${extra ? "," + extra.split("=")[0] : ""})
                        VALUES ($1, '${type}'::"BillingDocumentType", now()${extra ? "," + extra.split("=")[1] : ""}) RETURNING id`, bid)).id;
  const line = (docId, idx, total = "100.00") =>
    `INSERT INTO "BillingDocumentLine"("billingDocumentId","lineIndex","description","quantity","unitPrice","vatRatePercent","lineSubtotal","vatAmount","lineTotal","updatedAt")
     VALUES (${docId}, ${idx}, 'secf line', 1, ${total}, 0, ${total}, 0, ${total}, now())`;
  const issue = (docId, number) =>
    `UPDATE "BillingDocument" SET "status"='ISSUED', "documentNumber"=${number}, "documentNumberFormatted"='${number}',
       "issuedAt"=now(), "lockedAt"=now(), "issuedSnapshot"='{"v":1}'::jsonb, "legalSnapshotHash"='${HEX("a")}',
       "pdfRenderStatus"='PENDING', "updatedAt"=now() WHERE id=${docId}`;

  // ── phase 1: baseline, main alone ──────────────────────────────────────────
  console.log("== phase 1: BASELINE on main (the gaps, reproduced) ==");
  const baseInv = await mkDoc(owner, bizA, "TAX_INVOICE");
  await owner.$executeRawUnsafe(line(baseInv, 0));
  await owner.$executeRawUnsafe(issue(baseInv, 900));
  {
    const n = await asTenant(rt, bizA, (tx) => tx.$executeRawUnsafe(`UPDATE "BillingAuditEvent" SET "summary"='rewritten' WHERE "businessId"=${bizA}`));
    ok("B1 BASELINE runtime can rewrite its own BillingAuditEvent on main", n >= 1, `rows=${n}`);
    const d = await asTenant(rt, bizA, (tx) => tx.$executeRawUnsafe(`DELETE FROM "PayablesAuditEvent" WHERE "businessId"=${bizA}`));
    ok("B2 BASELINE runtime can delete its own PayablesAuditEvent on main", d >= 1, `rows=${d}`);
    await auditRow(owner, "PayablesAuditEvent", bizA);
    const u = await owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "totalAmount"=1 WHERE id=${baseInv}`);
    ok("B3 BASELINE owner can rewrite an ISSUED invoice total on main", u === 1, `rows=${u}`);
    const l = await asTenant(rt, bizA, (tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "lineTotal"=1 WHERE "billingDocumentId"=${baseInv}`));
    ok("B4 BASELINE runtime can rewrite a line of an ISSUED invoice on main", l === 1, `rows=${l}`);
  }

  // ── phase 2 ─────────────────────────────────────────────────────────────────
  console.log("== phase 2: apply the SEC-F migration (owner) ==");
  try {
    applyMigrationFile(SECF_MIGRATION, lab.ownerUrl);
  } catch (e) {
    console.log(`[SETUP-ERROR] migration apply failed: ${String(e?.stderr ?? "")}${String(e?.message ?? e)}`);
    process.exit(2);
  }
  // Idempotent: a second apply is a no-op, not an error.
  await expectOk("M0 migration re-apply is idempotent", async () => applyMigrationFile(SECF_MIGRATION, lab.ownerUrl));

  // ── phase 3a: privileges ────────────────────────────────────────────────────
  console.log("== phase 3a: privileges ==");
  for (const t of AUDIT) {
    const p = await one(owner, `SELECT has_table_privilege('secf_rt', '"${t}"', 'UPDATE') AS u, has_table_privilege('secf_rt', '"${t}"', 'DELETE') AS d,
                                       has_table_privilege('secf_rt', '"${t}"', 'TRUNCATE') AS tr, has_table_privilege('secf_rt', '"${t}"', 'INSERT') AS i,
                                       has_table_privilege('secf_rt', '"${t}"', 'SELECT') AS s`);
    ok(`G1 ${t}: runtime holds SELECT+INSERT only`, p.s && p.i && !p.u && !p.d && !p.tr, JSON.stringify(p));
  }
  {
    const p = await one(owner, `SELECT has_table_privilege('secf_rt', '"SecurityEvent"', 'INSERT') AS i, has_table_privilege('secf_rt', '"SecurityEvent"', 'SELECT') AS s,
                                       has_table_privilege('secf_rt', '"SecurityEvent"', 'UPDATE') AS u, has_table_privilege('secf_rt', '"SecurityEvent"', 'DELETE') AS d,
                                       has_table_privilege('secf_adm', '"SecurityEvent"', 'SELECT') AS a, has_table_privilege('secf_adm', '"SecurityEvent"', 'INSERT') AS ai`);
    ok("G2 SecurityEvent: runtime INSERT only; admin SELECT only", p.i && !p.s && !p.u && !p.d && p.a && !p.ai, JSON.stringify(p));
  }

  // ── phase 3b: append-only ──────────────────────────────────────────────────
  console.log("== phase 3b: audit trails are append-only ==");
  for (const t of AUDIT) {
    await expectCode(`A-RT-UPD ${t}`, () => asTenant(rt, bizA, (tx) => tx.$executeRawUnsafe(`UPDATE "${t}" SET "summary"='x' WHERE "businessId"=${bizA}`)), "42501", /permission denied/);
    await expectCode(`A-RT-DEL ${t}`, () => asTenant(rt, bizA, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId"=${bizA}`)), "42501", /permission denied/);
    await expectCode(`A-RT-TRUNC ${t}`, () => rt.$executeRawUnsafe(`TRUNCATE "${t}"`), "42501", /permission denied/);
    await expectCode(`A-OWN-UPD ${t}`, () => owner.$executeRawUnsafe(`UPDATE "${t}" SET "summary"='x' WHERE "businessId"=${bizA}`), "DZ001", /AUDIT_APPEND_ONLY/);
    await expectCode(`A-OWN-DEL ${t}`, () => owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId"=${bizA}`), "DZ001", /AUDIT_APPEND_ONLY/);
    await expectCode(`A-OWN-TRUNC ${t}`, () => owner.$executeRawUnsafe(`TRUNCATE "${t}"`), "DZ001", /AUDIT_APPEND_ONLY/);
    await expectOk(`A-RT-INS ${t}`, () => asTenant(rt, bizA, (tx) => auditRow(tx, t, bizA)), (n) => n === 1 || `rows=${n}`);
    await expectCode(`A-RT-XTEN ${t}`, () => asTenant(rt, bizA, (tx) => auditRow(tx, t, bizB)), "42501", /row-level security/);
    await expectOk(`A-RT-READ ${t} (own tenant only)`, () => asTenant(rt, bizA, (tx) => tx.$queryRawUnsafe(`SELECT DISTINCT "businessId" FROM "${t}"`)),
      (rows) => (rows.length === 1 && rows[0].businessId === bizA) || JSON.stringify(rows));
    const cnt = await one(owner, `SELECT count(*)::int AS c FROM "${t}" WHERE "businessId"=${bizA}`);
    ok(`A-SURVIVES ${t} (rows intact after every refused rewrite)`, cnt.c >= 2, `count=${cnt.c}`);
  }

  // ── phase 3c: chain linkage ────────────────────────────────────────────────
  console.log("== phase 3c: chain linkage (database side) ==");
  for (const t of AUDIT) {
    const chained = (seq, prev, hash) => ({ chainSeq: seq, prevHash: prev, chainHash: hash, chainKeyId: "k1" });
    await expectCode(`C-BAD-GENESIS ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(1, "nope", HEX("1")))), "DZ002", /AUDIT_CHAIN_LINK/);
    await expectOk(`C-GENESIS ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(1, "GENESIS", HEX("1")))));
    await expectOk(`C-LINK ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(2, HEX("1"), HEX("2")))));
    await expectCode(`C-WRONG-PREV ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(3, HEX("9"), HEX("3")))), "DZ002", /AUDIT_CHAIN_LINK/);
    await expectCode(`C-GAP ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(5, HEX("2"), HEX("5")))), "DZ002", /AUDIT_CHAIN_LINK/);
    await expectCode(`C-FORK ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, chained(2, HEX("1"), HEX("7")))), "23505");
    await expectCode(`C-SHAPE ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC, { chainSeq: 3, prevHash: HEX("2"), chainHash: "not-hex", chainKeyId: "k1" })), "23514");
    await expectOk(`C-UNCHAINED-ACCEPTED ${t}`, () => asTenant(rt, bizC, (tx) => auditRow(tx, t, bizC)));
  }

  // ── phase 3d: payables trail survives its tenant ───────────────────────────
  console.log("== phase 3d: PayablesAuditEvent FK ==");
  {
    const bizD = (await one(owner, `INSERT INTO "Business"("name","updatedAt") VALUES ('secf-D', now()) RETURNING id`)).id;
    await auditRow(owner, "PayablesAuditEvent", bizD);
    await expectCode("P-FK-RESTRICT deleting a Business does not erase its payables trail", () => owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE id=${bizD}`),
      // PostgreSQL 17 reports a RESTRICT refusal as 23503 (Production runs 17), 18 as 23001;
      // both are the foreign key refusing — and never DZ001, which is what CASCADE hits.
      ["23503", "23001"], /PayablesAuditEvent_businessId_fkey/);
  }

  // ── phase 3e: fiscal lifecycle ─────────────────────────────────────────────
  console.log("== phase 3e: fiscal immutability — the legitimate lifecycle passes ==");
  const T = (fn) => asTenant(rt, bizA, fn);
  const inv = await expectOk("F-DRAFT-CREATE invoice + lines (runtime)", () => T(async (tx) => {
    const id = await mkDoc(tx, bizA, "TAX_INVOICE");
    await tx.$executeRawUnsafe(line(id, 0));
    await tx.$executeRawUnsafe(line(id, 1));
    return id;
  }));
  await expectOk("F-DRAFT-EDIT totals, customer, status→PENDING_REVIEW→DRAFT (runtime)", () => T(async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "subtotalAmount"=200, "totalAmount"=200, "customerNameSnapshot"='c', "updatedAt"=now() WHERE id=${inv}`);
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "status"='PENDING_REVIEW' WHERE id=${inv}`);
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "status"='DRAFT' WHERE id=${inv}`);
  }));
  await expectOk("F-DRAFT-LINES-REPLACE deleteMany + createMany on a draft (runtime)", () => T(async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM "BillingDocumentLine" WHERE "billingDocumentId"=${inv}`);
    await tx.$executeRawUnsafe(line(inv, 0, "150.00"));
  }));
  await expectOk("F-ISSUE draft → ISSUED with number/snapshot/hash (runtime)", () => T((tx) => tx.$executeRawUnsafe(issue(inv, 1))), (n) => n === 1 || `rows=${n}`);
  await expectOk("F-PDF operational columns on ISSUED (runtime)", () => T((tx) => tx.$executeRawUnsafe(
    `UPDATE "BillingDocument" SET "pdfRenderStatus"='RENDERED', "pdfStorageKey"='k', "pdfHash"='h', "pdfRenderedAt"=now(), "pdfTemplateVersion"='v2',
       "pdfRenderError"=NULL, "signedPdfStorageKey"='s', "signedPdfHash"='sh', "signedAt"=now(), "updatedAt"=now() WHERE id=${inv}`)), (n) => n === 1 || `rows=${n}`);
  await expectOk("F-PROJ-SET-ONCE allocation projection on ISSUED (runtime)", () => T((tx) => tx.$executeRawUnsafe(
    `UPDATE "BillingDocument" SET "allocationNumber"='ALLOC-1', "allocationApprovedAt"=now(), "isEmergencyAllocation"=false, "pdfRenderStatus"='PENDING' WHERE id=${inv}`)), (n) => n === 1 || `rows=${n}`);
  await expectOk("F-PROJ-IDEMPOTENT same projection re-written (runtime)", () => T((tx) => tx.$executeRawUnsafe(
    `UPDATE "BillingDocument" SET "allocationNumber"='ALLOC-1' WHERE id=${inv}`)));
  await expectOk("F-LOCK SELECT … FOR UPDATE on ISSUED is not a write (runtime)", () => T((tx) => tx.$queryRawUnsafe(`SELECT id FROM "BillingDocument" WHERE id=${inv} FOR UPDATE`)));

  // credit note against the issued invoice
  await expectOk("F-CREDIT-NOTE draft → ISSUED referencing the invoice (runtime)", () => T(async (tx) => {
    const cn = await mkDoc(tx, bizA, "CREDIT_NOTE", `"referenceDocumentId"=${inv}`);
    await tx.$executeRawUnsafe(line(cn, 0, "50.00"));
    await tx.$executeRawUnsafe(issue(cn, 2));
  }));
  // receipt: draft with payments and an allocation to the issued invoice, then issue
  const rcpt = await expectOk("F-RECEIPT draft + payments + allocation, edited, then ISSUED (runtime)", () => T(async (tx) => {
    const r = await mkDoc(tx, bizA, "RECEIPT");
    const pay = (idx, amt) => tx.$executeRawUnsafe(
      `INSERT INTO "BillingReceiptPayment"("billingDocumentId","lineIndex","method","amount","paymentDate","updatedAt") VALUES (${r}, ${idx}, 'CASH', ${amt}, now(), now())`);
    await pay(0, 10);
    await tx.$executeRawUnsafe(`DELETE FROM "BillingReceiptPayment" WHERE "billingDocumentId"=${r}`);
    await pay(0, 20);
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "totalAmount"=20 WHERE id=${r}`);
    const alloc = () => tx.$executeRawUnsafe(
      `INSERT INTO "BillingPaymentAllocation"("businessId","receiptDocumentId","invoiceDocumentId","allocatedAmount") VALUES (${bizA}, ${r}, ${inv}, 20)`);
    await alloc();
    await tx.$executeRawUnsafe(`DELETE FROM "BillingPaymentAllocation" WHERE "receiptDocumentId"=${r}`);
    await alloc();
    await tx.$executeRawUnsafe(issue(r, 3));
    return r;
  }));
  // quote lifecycle (never ISSUED): number set, conversion link set
  await expectOk("F-QUOTE number allocation + conversion link (runtime)", () => T(async (tx) => {
    const q = await mkDoc(tx, bizA, "QUOTE");
    await tx.$executeRawUnsafe(line(q, 0));
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "documentNumber"=7, "documentNumberFormatted"='Q-7' WHERE id=${q} AND "documentNumber" IS NULL`);
    const target = await mkDoc(tx, bizA, "TAX_INVOICE");
    await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "convertedToInvoiceId"=${target} WHERE id=${q}`);
  }));
  await expectOk("F-DRAFT-DELETE a draft document, lines cascading (owner)", async () => {
    const d = await mkDoc(owner, bizA, "TAX_INVOICE");
    await owner.$executeRawUnsafe(line(d, 0));
    return owner.$executeRawUnsafe(`DELETE FROM "BillingDocument" WHERE id=${d}`);
  }, (n) => n === 1 || `rows=${n}`);

  console.log("== phase 3f: fiscal immutability — tampering with an ISSUED document ==");
  await expectCode("F-TOTAL-RT runtime UPDATE totalAmount on ISSUED", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "totalAmount"=1 WHERE id=${inv}`)), "DZ010", /FISCAL_IMMUTABLE.*totalAmount/);
  await expectCode("F-TOTAL-OWN owner UPDATE totalAmount on ISSUED", () => owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "totalAmount"=1, "vatAmount"=0 WHERE id=${inv}`), "DZ010", /FISCAL_IMMUTABLE.*totalAmount/);
  await expectCode("F-STATUS-REVERT ISSUED → DRAFT", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "status"='DRAFT' WHERE id=${inv}`)), "DZ010", /FISCAL_IMMUTABLE.*status/);
  await expectCode("F-SNAPSHOT issuedSnapshot / legalSnapshotHash", () => owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "issuedSnapshot"='{"v":2}'::jsonb, "legalSnapshotHash"='${HEX("b")}' WHERE id=${inv}`), "DZ010", /FISCAL_IMMUTABLE/);
  await expectCode("F-NUMBER documentNumber", () => owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "documentNumber"=99 WHERE id=${inv}`), "DZ010", /FISCAL_IMMUTABLE.*documentNumber/);
  await expectCode("F-CUSTOMER customerNameSnapshot", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "customerNameSnapshot"='other' WHERE id=${inv}`)), "DZ010", /FISCAL_IMMUTABLE/);
  await expectCode("F-TENANT businessId", () => owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "businessId"=${bizB} WHERE id=${inv}`), "DZ010", /FISCAL_IMMUTABLE.*businessId/);
  await expectCode("F-PROJ-CHANGE allocationNumber once set", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "allocationNumber"='ALLOC-2' WHERE id=${inv}`)), "DZ010", /FISCAL_IMMUTABLE.*allocationNumber/);
  await expectCode("F-PROJ-CLEAR allocationNumber → NULL", () => owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "allocationNumber"=NULL WHERE id=${inv}`), "DZ010", /FISCAL_IMMUTABLE/);
  // The runtime holds no DELETE rule on BillingDocument at all (main's tenant rules), so its
  // delete matches no row before any trigger could fire; the trigger is what stops the owner.
  await expectOk("F-DELETE-RT runtime delete of ISSUED matches no row", () => T((tx) => tx.$executeRawUnsafe(`DELETE FROM "BillingDocument" WHERE id=${inv}`)), (n) => n === 0 || `rows=${n}`);
  await expectCode("F-DELETE-OWN delete ISSUED (owner)", () => owner.$executeRawUnsafe(`DELETE FROM "BillingDocument" WHERE id=${inv}`), "DZ010", /cannot be deleted/);
  await expectCode("F-LINE-INS add a line to ISSUED", () => T((tx) => tx.$executeRawUnsafe(line(inv, 5))), "DZ010", /BillingDocumentLine/);
  await expectCode("F-LINE-UPD-RT rewrite a line of ISSUED", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "lineTotal"=1 WHERE "billingDocumentId"=${inv}`)), "DZ010", /BillingDocumentLine/);
  await expectCode("F-LINE-UPD-OWN rewrite a line of ISSUED (owner)", () => owner.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "unitPrice"=1 WHERE "billingDocumentId"=${inv}`), "DZ010", /BillingDocumentLine/);
  await expectCode("F-LINE-DEL delete a line of ISSUED", () => T((tx) => tx.$executeRawUnsafe(`DELETE FROM "BillingDocumentLine" WHERE "billingDocumentId"=${inv}`)), "DZ010", /BillingDocumentLine/);
  await expectCode("F-LINE-MOVE move a draft line onto ISSUED", async () => {
    const d = await mkDoc(owner, bizA, "TAX_INVOICE");
    await owner.$executeRawUnsafe(line(d, 0));
    return owner.$executeRawUnsafe(`UPDATE "BillingDocumentLine" SET "billingDocumentId"=${inv}, "lineIndex"=40 WHERE "billingDocumentId"=${d}`);
  }, "DZ010", /BillingDocumentLine/);
  await expectCode("F-TRUNC-LINE TRUNCATE lines (owner)", () => owner.$executeRawUnsafe(`TRUNCATE "BillingDocumentLine" CASCADE`), "DZ010", /FISCAL_IMMUTABLE/);
  await expectCode("F-RCPT-PAY-UPD rewrite an ISSUED receipt's payment", () => T((tx) => tx.$executeRawUnsafe(`UPDATE "BillingReceiptPayment" SET "amount"=1 WHERE "billingDocumentId"=${rcpt}`)), "DZ010", /BillingReceiptPayment/);
  await expectCode("F-RCPT-PAY-DEL delete an ISSUED receipt's payment", () => owner.$executeRawUnsafe(`DELETE FROM "BillingReceiptPayment" WHERE "billingDocumentId"=${rcpt}`), "DZ010", /BillingReceiptPayment/);
  await expectCode("F-ALLOC-DEL delete an ISSUED receipt's allocation", () => T((tx) => tx.$executeRawUnsafe(`DELETE FROM "BillingPaymentAllocation" WHERE "receiptDocumentId"=${rcpt}`)), "DZ010", /BillingPaymentAllocation/);
  await expectCode("F-ALLOC-UPD re-amount an ISSUED receipt's allocation", () => owner.$executeRawUnsafe(`UPDATE "BillingPaymentAllocation" SET "allocatedAmount"=1 WHERE "receiptDocumentId"=${rcpt}`), "DZ010", /BillingPaymentAllocation/);
  await expectCode("F-ALLOC-INS add an allocation to an ISSUED receipt", async () => {
    const inv2 = await mkDoc(owner, bizA, "TAX_INVOICE");
    return T((tx) => tx.$executeRawUnsafe(`INSERT INTO "BillingPaymentAllocation"("businessId","receiptDocumentId","invoiceDocumentId","allocatedAmount") VALUES (${bizA}, ${rcpt}, ${inv2}, 1)`));
  }, "DZ010", /BillingPaymentAllocation/);
  await expectCode("F-XTEN cross-tenant line insert still denied by RLS, not masked", () => asTenant(rt, bizB, (tx) => tx.$executeRawUnsafe(line(inv, 60))), "42501", /row-level security/);
  {
    const d = await one(owner, `SELECT "totalAmount"::text AS t, status::text AS s, "allocationNumber" AS a FROM "BillingDocument" WHERE id=${inv}`);
    const ln = await one(owner, `SELECT count(*)::int AS c, sum("lineTotal")::text AS s FROM "BillingDocumentLine" WHERE "billingDocumentId"=${inv}`);
    ok("F-INTACT the ISSUED invoice is exactly as issued", d.t === "200.00" && d.s === "ISSUED" && d.a === "ALLOC-1" && ln.c === 1 && ln.s === "150.00", JSON.stringify({ d, ln }));
  }

  // ── phase 3g: SecurityEvent ────────────────────────────────────────────────
  console.log("== phase 3g: SecurityEvent ==");
  const se = (client, cols) => {
    const keys = Object.keys(cols);
    return client.$executeRawUnsafe(
      `INSERT INTO "SecurityEvent"(${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      ...Object.values(cols));
  };
  await expectOk("S-RT-INS pre-auth event, no tenant (runtime, no RETURNING)", () => se(rt, { eventType: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", reasonClass: "invalid_credentials", actorKind: "ANONYMOUS", ipHash: "0123456789abcdef" }), (n) => n === 1 || `rows=${n}`);
  await expectOk("S-RT-INS-OWN own-tenant event", () => asTenant(rt, bizA, (tx) => se(tx, { eventType: "DATA_EXPORT", outcome: "SUCCESS", businessId: bizA, userId: 1 })));
  await expectCode("S-RT-XTEN event attributed to another tenant", () => asTenant(rt, bizA, (tx) => se(tx, { eventType: "DATA_EXPORT", outcome: "SUCCESS", businessId: bizB })), "42501", /row-level security/);
  await expectCode("S-RT-SELECT runtime cannot read security events", () => rt.$queryRawUnsafe(`SELECT * FROM "SecurityEvent"`), "42501", /permission denied/);
  await expectCode("S-RT-UPD", () => rt.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "outcome"='SUCCESS'`), "42501", /permission denied/);
  await expectCode("S-RT-DEL", () => rt.$executeRawUnsafe(`DELETE FROM "SecurityEvent"`), "42501", /permission denied/);
  await expectOk("S-ADM-READ platform admin reads across tenants", () => adm.$queryRawUnsafe(`SELECT "eventType" FROM "SecurityEvent"`), (rows) => rows.length === 2 || `rows=${rows.length}`);
  await expectCode("S-ADM-INS admin cannot write", () => se(adm, { eventType: "X_EVENT", outcome: "INFO" }), "42501", /permission denied/);
  await expectCode("S-OWN-UPD owner cannot rewrite", () => owner.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "outcome"='SUCCESS'`), "DZ001", /AUDIT_APPEND_ONLY/);
  await expectCode("S-OWN-DEL owner cannot delete", () => owner.$executeRawUnsafe(`DELETE FROM "SecurityEvent"`), "DZ001", /AUDIT_APPEND_ONLY/);
  await expectCode("S-CHK-TYPE free-text event type refused", () => se(rt, { eventType: "user@example.com logged in", outcome: "INFO" }), "23514");
  await expectCode("S-CHK-IP raw IP refused", () => se(rt, { eventType: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", ipHash: "203.0.113.7" }), "23514");
  await expectCode("S-CHK-META oversized payload refused", () => rt.$executeRawUnsafe(
    `INSERT INTO "SecurityEvent"("eventType","outcome","metadata") VALUES ('BIG_EVENT','INFO', jsonb_build_object('x', repeat(md5(random()::text), 400)))`), "23514");

  await owner.$disconnect(); await rt.$disconnect(); await adm.$disconnect();
  console.log(`\nSEC-F migration battery: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) { console.log(`FAILED: ${failures.join(" | ")}`); process.exit(1); }
}

main().catch((e) => {
  console.log(`[SETUP-ERROR] ${String(e?.stack ?? e)}`);
  process.exit(2);
});
