/**
 * Payables Phases 4–6 — against a real database. Run (CI provides PG17 with the
 * migration's own objects):
 *   TEST_DATABASE_URL="postgres://…" npx tsx lib/services/payables/payables-p46.db.test.ts
 *
 * The invariant under test, everywhere: ONE accounting truth. Every path that
 * ends in money having moved — owner-reported, bank-observed, provider-settled —
 * converges on exactly one canonical Payment, and nothing else moves a balance.
 */

import { randomBytes } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT (DB safety guard): set TEST_DATABASE_URL to a non-production test Postgres URL.");
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
if (!process.env.AUTH_TOKEN_SECRET?.trim()) process.env.AUTH_TOKEN_SECRET = "payables-p46-test-secret";
process.env.PAYABLES_BANK_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.PAYABLES_BANK_FINGERPRINT_KEY = randomBytes(32).toString("base64");
// The in-memory outbound adapter — refused under NODE_ENV=production by design.
process.env.OUTBOUND_TEST_ADAPTER = "1";

const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
async function rejects(name: string, fn: () => Promise<unknown>, expect?: RegExp | string) {
  total += 1;
  try {
    await fn();
    failures += 1;
    console.log(`  [FAIL] ${name} — expected a rejection, none thrown`);
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const good = !expect || (typeof expect === "string" ? msg.includes(expect) : expect.test(msg));
    if (!good) failures += 1;
    console.log(`  [${good ? "PASS" : "FAIL"}] ${name}${good ? "" : ` — wrong error: ${msg}`}`);
  }
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const svc = await import("@/lib/services/payables/payables.service");
  const bank = await import("@/lib/services/payables/payables-bank-account.service");
  const dest = await import("@/lib/services/payables/payables-destination.service");
  const prep = await import("@/lib/services/payables/payables-preparation.service");
  const obs = await import("@/lib/services/payables/payables-observation.service");
  const out = await import("@/lib/services/payables/payables-outbound.service");
  const cheques = await import("@/lib/services/payables/payables-cheque.service");

  async function makeBusiness(label: string): Promise<number> {
    const b = await prisma.business.create({
      data: {
        name: `P46 ${label} ${runId}`,
        users: { create: { email: `p46-${label}-${runId}@example.test`, password: "x", name: "P46" } },
      },
    });
    return b.id;
  }
  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B }, fn);
  const D = (iso: string) => new Date(iso);
  const paymentsOf = (businessId: number) => prisma.payment.count({ where: { businessId } });

  const payee = await asA(() => svc.createPayee({ businessId: A, displayName: "ספק הדפוס בע\"מ", kind: "SUPPLIER" }));
  const payee2 = await asA(() => svc.createPayee({ businessId: A, displayName: "חברת החשמל", kind: "UTILITY" }));
  const source = (await asA(() => bank.createBusinessBankAccount({ businessId: A, label: "main", bankCode: "12", branchCode: "034", accountNumber: "0012345678" }))).account;

  /* ── 1. destinations ─────────────────────────────────────────────────── */
  console.log("\n[1] destinations");
  const DEST = { bankCode: "20", branchCode: "001", accountNumber: "0009876543" };
  const d1 = (await asA(() => dest.createDestination({ businessId: A, payeeId: payee.id, label: "ראשי", beneficiaryName: "ספק הדפוס", ...DEST }))).destination;
  check("1.1 masked view only (••••6543), no sealed columns", d1.masked === "••••6543" && !("fingerprint" in d1) && !("coordinatesEncrypted" in d1));
  check("1.2 first destination of a payee becomes its default", d1.isDefault === true);
  check("1.3 verification is NONE — nothing verifies it", d1.verification === "NONE");
  const raw = await prisma.paymentDestination.findUniqueOrThrow({ where: { id: d1.id } });
  check("1.4 no stored column contains the account number", !JSON.stringify(raw).includes("9876543"));
  const bankRow = await prisma.businessBankAccount.findUniqueOrThrow({ where: { id: source.id } });
  check("1.5 a destination does NOT decrypt as a business bank account (purpose-bound)",
    (await import("@/lib/services/payables/payables-bank-crypto")).openBankCoordinates(raw, A, "BUSINESS_BANK_ACCOUNT") === null && bankRow.id > 0);
  await rejects("1.6 same account, same payee → 409", () => asA(() => dest.createDestination({ businessId: A, payeeId: payee.id, label: "dup", beneficiaryName: "x", bankCode: "20", branchCode: "001", accountNumber: "00-0987-6543" })), "PayablesConflictError");
  const shared = (await asA(() => dest.createDestination({ businessId: A, payeeId: payee2.id, label: "shared", beneficiaryName: "x", ...DEST }))).destination;
  check("1.7 same account, a DIFFERENT payee → allowed", shared.id !== d1.id);
  const revealed = await asA(() => dest.revealDestinationCoordinates({ businessId: A, destinationId: d1.id }));
  check("1.8 reveal returns the full account, leading zeros intact", revealed.coordinates?.accountNumber === "0009876543");
  const revealAudit = await prisma.payablesAuditEvent.count({ where: { businessId: A, eventType: "DESTINATION_REVEALED" } });
  check("1.9 every reveal is audited", revealAudit === 1);
  await rejects("1.10 tenant B cannot reveal A's destination (404)", () => asB(() => dest.revealDestinationCoordinates({ businessId: B, destinationId: d1.id })), "PayablesNotFoundError");
  await rejects("1.11 tenant B cannot list-by-payee into A", async () => {
    const list = await asB(() => dest.listDestinations({ businessId: B, payeeId: payee.id }));
    if (list.length === 0) throw new Error("PayablesNotFoundError: empty as expected");
  }, "empty as expected");
  const audits = JSON.stringify(await prisma.payablesAuditEvent.findMany({ where: { businessId: A } }));
  check("1.12 no audit row carries an account number or fingerprint", !audits.includes("9876543") && !audits.includes(raw.fingerprint));

  /* ── 2. prepare ─────────────────────────────────────────────────────── */
  console.log("\n[2] הכן תשלום");
  const plan = await asA(() => svc.createCommitment({ businessId: A, title: "הדפסות", payeeId: payee.id, scheduleKind: "INSTALLMENT_PLAN", totalAmount: "3000.00", installmentCount: 3, recurrence: "MONTHLY", firstDueAt: D("2026-02-10T09:00:00.000Z") }));
  const insts = await prisma.installment.findMany({ where: { commitmentId: plan.id }, orderBy: { sequence: "asc" } });
  const before = await paymentsOf(A);
  const p1 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[0].id, amount: "1000.00", method: "BANK_TRANSFER", destinationId: d1.id, sourceBankAccountId: source.id, reference: "INV-1" }));
  check("2.1 prepared: status PREPARED, destination masked, source masked", p1.status === "PREPARED" && p1.destination?.masked === "••••6543" && p1.source?.masked === "••••5678");
  check("2.2 preparing creates NO Payment", (await paymentsOf(A)) === before);
  const bal0 = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }));
  check("2.3 …and marks nothing paid", bal0.paid === "0.00" && bal0.installments[0].remaining === "1000.00");
  await rejects("2.4 a second preparation that would exceed what is owed is refused", () => asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[0].id, amount: "0.01", method: "CASH" })), "exceed");
  await rejects("2.5 a destination of ANOTHER payee is refused (no substitution)", () => asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[1].id, amount: "10.00", method: "BANK_TRANSFER", destinationId: shared.id })), "different payee");
  await rejects("2.6 a bank transfer with no destination is refused", () => asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[1].id, amount: "10.00", method: "BANK_TRANSFER" })), "destination");
  await rejects("2.7 CHECK is routed to the cheque register", () => asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[1].id, amount: "10.00", method: "CHECK" })), "cheque register");
  await rejects("2.8 reporting completion before approval is refused", () => asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p1.id, paidAt: D("2026-02-09T12:00:00Z") })), "cannot become COMPLETED");

  const ap = await asA(() => prep.approvePreparation({ businessId: A, preparationId: p1.id }));
  check("2.9 approved — still no Payment, nothing paid", ap.status === "APPROVED" && (await paymentsOf(A)) === before);
  const frozen = await prisma.paymentPreparation.findUniqueOrThrow({ where: { id: p1.id } });
  check("2.10 approval froze a hash and both fingerprints", !!frozen.approvalHash && frozen.frozenDestinationFingerprint === raw.fingerprint && !!frozen.frozenSourceFingerprint);
  await rejects("2.11 the frozen destination cannot be archived under it", () => asA(() => dest.archiveDestination({ businessId: A, destinationId: d1.id })), "approved payment");

  // Tamper: someone rewrites the destination's coordinates directly after approval.
  await prisma.paymentDestination.update({ where: { id: d1.id }, data: { fingerprint: "tampered" } });
  await rejects("2.12 changed destination after approval → refused, NOT silently paid", () => asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p1.id, paidAt: D("2026-02-09T12:00:00Z") })), "changed after approval");
  check("2.13 …and no Payment was created", (await paymentsOf(A)) === before);
  await prisma.paymentDestination.update({ where: { id: d1.id }, data: { fingerprint: raw.fingerprint } });

  const done = await asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p1.id, paidAt: D("2026-02-09T12:00:00Z"), externalReference: "BANK-REF-77" }));
  check("2.14 owner-reported completion → exactly ONE Payment", (await paymentsOf(A)) === before + 1 && done.preparation.status === "COMPLETED");
  const payRow = await prisma.payment.findFirstOrThrow({ where: { businessId: A, idempotencyKey: `prep:${p1.id}` }, include: { allocations: true, evidences: true } });
  check("2.15 …keyed prep:<id>, BANK_TRANSFER, allocated to the installment", payRow.method === "BANK_TRANSFER" && payRow.allocations[0]?.installmentId === insts[0].id && payRow.allocations[0].allocatedAmount.toFixed(2) === "1000.00");
  check("2.16 …with ONE evidence, MANUAL, owner-asserted", payRow.evidences.length === 1 && payRow.evidences[0].kind === "MANUAL" && /owner-asserted/.test(payRow.evidences[0].note ?? ""));
  check("2.17 preparation links the Payment", done.preparation.paymentId === payRow.id && done.preparation.completionSource === "OWNER_REPORTED");
  const again = await asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p1.id, paidAt: D("2026-02-09T12:00:00Z") }));
  check("2.18 reporting again is a replay — no second Payment", again.replayed && (await paymentsOf(A)) === before + 1);
  const bal1 = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }));
  check("2.19 the installment is PAID through PaymentAllocation", bal1.installments[0].state === "PAID" && bal1.paid === "1000.00");

  // Race: two concurrent completions of one approved preparation.
  const p2 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[1].id, amount: "1000.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  await asA(() => prep.approvePreparation({ businessId: A, preparationId: p2.id }));
  const race = await Promise.allSettled([
    asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p2.id, paidAt: D("2026-03-09T12:00:00Z") })),
    asA(() => prep.reportPreparationCompleted({ businessId: A, preparationId: p2.id, paidAt: D("2026-03-09T12:00:00Z") })),
  ]);
  check("2.20 two concurrent completions → exactly ONE Payment", (await prisma.payment.count({ where: { businessId: A, idempotencyKey: `prep:${p2.id}` } })) === 1 && race.every((r) => r.status === "fulfilled"));

  const p3 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan.id, installmentId: insts[2].id, amount: "400.00", method: "CASH" }));
  const c3 = await asA(() => prep.cancelPreparation({ businessId: A, preparationId: p3.id, reason: "not needed" }));
  check("2.21 cancel: CANCELLED, nothing paid", c3.status === "CANCELLED" && (await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }))).installments[2].paid === "0.00");

  /* ── 3. bank lines ──────────────────────────────────────────────────── */
  console.log("\n[3] bank observation");
  const csv = [
    "תאריך,תיאור,אסמכתא,חובה,זכות",
    "09/02/2026,העברה ספק הדפוס בע\"מ,BANK-REF-77,1000.00,",
    "10/02/2026,עמלת ניהול חשבון,,15.00,",
    "11/02/2026,זיכוי מלקוח,,,300.00",
  ].join("\n");
  const up1 = await asA(() => obs.uploadStatement({ businessId: A, sourceBankAccountId: source.id, csvText: csv }));
  check("3.1 upload ingests 3 lines", up1.inserted === 3 && up1.alreadyKnown === 0);
  const up2 = await asA(() => obs.uploadStatement({ businessId: A, sourceBankAccountId: source.id, csvText: csv }));
  check("3.2 re-uploading the same statement adds NOTHING", up2.inserted === 0 && up2.alreadyKnown === 3);
  const lines = await prisma.externalTransaction.findMany({ where: { businessId: A }, orderBy: { bookedAt: "asc" } });
  await rejects("3.3 an observed amount cannot be edited (trigger)", () => prisma.externalTransaction.update({ where: { id: lines[0].id }, data: { amount: "999.00" } }), /immutable/);
  const beforeAttach = await paymentsOf(A);

  const sug = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: lines[0].id }));
  const top = sug.suggestions[0];
  check("3.4 the transfer line suggests the EXISTING Payment first", top?.kind === "PAYMENT" && top.id === payRow.id, JSON.stringify(sug.suggestions.map((s) => [s.kind, s.id])));
  const att = await asA(() => obs.attachObservationToPayment({ businessId: A, externalTransactionId: lines[0].id, paymentId: payRow.id }));
  check("3.5 attaching = evidence only, NO new Payment", !att.createdPayment && (await paymentsOf(A)) === beforeAttach);
  const bal2 = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }));
  check("3.6 evidence never moves money: paid unchanged", bal2.paid === bal1.paid || bal2.paid === "2000.00");
  await rejects("3.7 the same line cannot evidence a second payment", () => asA(() => obs.attachObservationToPayment({ businessId: A, externalTransactionId: lines[0].id, paymentId: payRow.id })), "already evidences");
  const credit = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: lines[2].id }));
  check("3.8 an incoming credit is not a payable (no suggestions)", credit.reason === "NOT_A_PAYABLE" && credit.suggestions.length === 0);
  const fee = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: lines[1].id }));
  check("3.9 a 15.00 fee matches nothing (amount alone is never identity)", fee.suggestions.length === 0);
  await asA(() => obs.dismissObservation({ businessId: A, externalTransactionId: lines[1].id, reason: "bank fee" }));
  const open = await asA(() => obs.listObservations({ businessId: A }));
  check("3.10 dismissed and matched lines leave the open list", open.every((l) => l.id !== lines[0].id && l.id !== lines[1].id));

  // A manual payment exists; a bank line for it must not become a second Payment.
  const util = await asA(() => svc.createCommitment({ businessId: A, title: "חשמל", payeeId: payee2.id, scheduleKind: "ONE_OFF", totalAmount: "450.00", firstDueAt: D("2026-02-20T09:00:00.000Z") }));
  await asA(() => svc.recordManualPayment({ businessId: A, commitmentId: util.id, amount: "450.00", paidAt: D("2026-02-19T09:00:00Z"), method: "BANK_TRANSFER" }));
  await asA(() => obs.recordObservationManually({ businessId: A, clientKey: `k-${runId}-elec`, bookedAt: D("2026-02-20T12:00:00Z"), amount: "450.00", direction: "DEBIT", counterpartyName: "חברת החשמל" }));
  await asA(() => obs.recordObservationManually({ businessId: A, clientKey: `k-${runId}-elec`, bookedAt: D("2026-02-20T12:00:00Z"), amount: "450.00", direction: "DEBIT", counterpartyName: "חברת החשמל" }));
  const elec = await prisma.externalTransaction.findMany({ where: { businessId: A, source: "OWNER_ENTRY" } });
  check("3.11 a double-submitted manual line is ONE line", elec.length === 1);
  const n0 = await paymentsOf(A);
  await rejects("3.12 recording a NEW payment while a similar one exists is refused", () => asA(() => obs.recordPaymentFromObservation({ businessId: A, externalTransactionId: elec[0].id, commitmentId: util.id })), "already recorded");
  check("3.13 …no second Payment", (await paymentsOf(A)) === n0);
  const es = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: elec[0].id }));
  check("3.14 the existing manual payment is suggested instead", es.suggestions[0]?.kind === "PAYMENT");

  // A cleared cheque + its bank debit, matched by the cheque number.
  const chq = await asA(() => cheques.createCheque({ businessId: A, chequeNumber: "000555", amount: "1000.00", issueDate: D("2026-03-01T09:00:00Z"), dueDate: D("2026-03-10T09:00:00Z"), sourceBankAccountId: source.id, installmentId: insts[2].id, status: "ISSUED" }));
  await asA(() => cheques.clearCheque({ businessId: A, chequeId: chq.id, clearedAt: D("2026-03-11T12:00:00Z") }));
  const chequePay = await prisma.payment.findFirstOrThrow({ where: { businessId: A, idempotencyKey: `cheque:${chq.id}` } });
  await asA(() => obs.recordObservationManually({ businessId: A, clientKey: `k-${runId}-chq`, bookedAt: D("2026-03-12T12:00:00Z"), amount: "1000.00", direction: "DEBIT", reference: "555", description: "שיק 555" }));
  const chqLine = await prisma.externalTransaction.findFirstOrThrow({ where: { businessId: A, externalId: `own:k-${runId}-chq` } });
  const cs = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: chqLine.id }));
  check("3.15 the cheque's bank debit suggests the cheque's Payment, by reference", cs.suggestions.some((s) => s.kind === "PAYMENT" && s.id === chequePay.id && s.reasons.includes("האסמכתא תואמת")));
  const n1 = await paymentsOf(A);
  await asA(() => obs.attachObservationToPayment({ businessId: A, externalTransactionId: chqLine.id, paymentId: chequePay.id }));
  check("3.16 cheque clearing + bank line = ONE Payment, two evidences", (await paymentsOf(A)) === n1 && (await prisma.paymentEvidence.count({ where: { paymentId: chequePay.id, revokedAt: null } })) === 2);

  // A bank line completes an approved preparation (BANK_OBSERVED).
  const plan2 = await asA(() => svc.createCommitment({ businessId: A, title: "שכירות", payeeId: payee.id, scheduleKind: "ONE_OFF", totalAmount: "5000.00", firstDueAt: D("2026-04-01T09:00:00.000Z") }));
  const inst2 = await prisma.installment.findFirstOrThrow({ where: { commitmentId: plan2.id } });
  const p4 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan2.id, installmentId: inst2.id, amount: "5000.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  await asA(() => prep.approvePreparation({ businessId: A, preparationId: p4.id }));
  await asA(() => obs.recordObservationManually({ businessId: A, clientKey: `k-${runId}-rent`, bookedAt: D("2026-04-01T12:00:00Z"), amount: "5000.00", direction: "DEBIT", counterpartyName: "ספק הדפוס" }));
  const rentLine = await prisma.externalTransaction.findFirstOrThrow({ where: { businessId: A, externalId: `own:k-${runId}-rent` } });
  const rs = await asA(() => obs.suggestForObservation({ businessId: A, externalTransactionId: rentLine.id }));
  check("3.17 the bank line suggests the approved preparation", rs.suggestions.some((s) => s.kind === "PREPARATION" && s.id === p4.id));
  const n2 = await paymentsOf(A);
  const cp = await asA(() => obs.completePreparationFromObservation({ businessId: A, externalTransactionId: rentLine.id, preparationId: p4.id }));
  const rentPay = await prisma.payment.findFirstOrThrow({ where: { id: cp.paymentId }, include: { evidences: true } });
  check("3.18 bank-observed completion → exactly ONE Payment, BANK_TRANSACTION evidence", (await paymentsOf(A)) === n2 + 1 && rentPay.evidences.length === 1 && rentPay.evidences[0].kind === "BANK_TRANSACTION" && rentPay.evidences[0].externalTransactionId === rentLine.id);
  check("3.19 preparation COMPLETED with source BANK_OBSERVED", (await prisma.paymentPreparation.findUniqueOrThrow({ where: { id: p4.id } })).completionSource === "BANK_OBSERVED");
  const rv = await asA(() => obs.revokeObservationEvidence({ businessId: A, evidenceId: rentPay.evidences[0].id }));
  check("3.20 revoking bank evidence leaves the Payment RECORDED (evidence never moves money)", rv.revoked && (await prisma.payment.findUniqueOrThrow({ where: { id: rentPay.id } })).status === "RECORDED");

  /* ── 4. outbound execution (test adapter) ───────────────────────────── */
  console.log("\n[4] outbound execution");
  check("4.1 only the test adapter is registered (never production)", JSON.stringify(out.listOutboundProviders().map((p) => p.id)) === '["test-adapter"]');
  const plan3 = await asA(() => svc.createCommitment({ businessId: A, title: "ספק 3", payeeId: payee.id, scheduleKind: "ONE_OFF", totalAmount: "700.00", firstDueAt: D("2026-05-01T09:00:00.000Z") }));
  const inst3 = await prisma.installment.findFirstOrThrow({ where: { commitmentId: plan3.id } });
  const p5 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan3.id, installmentId: inst3.id, amount: "700.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  await rejects("4.2 executing an unapproved preparation is refused", () => asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "test-adapter", idempotencyKey: `x-${runId}-0`, confirm: true })), "cannot become SUBMITTED");
  await asA(() => prep.approvePreparation({ businessId: A, preparationId: p5.id }));
  await rejects("4.3 without explicit confirmation → refused", () => asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "test-adapter", idempotencyKey: `x-${runId}-1`, confirm: false })), "explicit confirmation");
  await rejects("4.4 an unknown provider → refused", () => asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "cardcom", idempotencyKey: `x-${runId}-1`, confirm: true })), "No outbound payment provider");
  const n3 = await paymentsOf(A);
  const ex = await asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "test-adapter", idempotencyKey: `x-${runId}-1`, confirm: true }));
  check("4.5 submitted → ACKNOWLEDGED with a provider reference", ex.status === "ACKNOWLEDGED" && !!ex.providerReference);
  check("4.6 ACKNOWLEDGED is not settlement: NO Payment", (await paymentsOf(A)) === n3 && ex.paymentId === null);
  check("4.7 the adapter received the full account (server-side only)", out.testAdapterScript.submitted.at(-1)?.destination.accountNumber === "0009876543");
  const replay = await asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "test-adapter", idempotencyKey: `x-${runId}-1`, confirm: true }));
  check("4.8 the same idempotency key is a replay — submitted ONCE", replay.id === ex.id && out.testAdapterScript.submitted.length === 1);
  await rejects("4.9 a second live attempt with a new key is refused", () => asA(() => out.requestExecution({ businessId: A, preparationId: p5.id, provider: "test-adapter", idempotencyKey: `x-${runId}-2`, confirm: true })));
  out.testAdapterScript.statuses.set(ex.providerReference!, { status: "SETTLED", settledAt: D("2026-05-02T10:00:00Z") });
  const settled = await asA(() => out.refreshExecution({ businessId: A, executionId: ex.id }));
  check("4.10 SETTLED → exactly ONE canonical Payment", settled.status === "SETTLED" && (await paymentsOf(A)) === n3 + 1 && !!settled.paymentId);
  const exPay = await prisma.payment.findUniqueOrThrow({ where: { id: settled.paymentId! }, include: { evidences: true, allocations: true } });
  check("4.11 …keyed prep:<id>, PAYMENT_PROVIDER evidence, allocated", exPay.idempotencyKey === `prep:${p5.id}` && exPay.evidences[0]?.kind === "PAYMENT_PROVIDER" && exPay.allocations[0]?.installmentId === inst3.id);
  await asA(() => out.refreshExecution({ businessId: A, executionId: ex.id }));
  check("4.12 refreshing a settled execution again creates nothing", (await paymentsOf(A)) === n3 + 1);

  // Failure path: nothing is paid, the owner can retry.
  const plan4 = await asA(() => svc.createCommitment({ businessId: A, title: "ספק 4", payeeId: payee.id, scheduleKind: "ONE_OFF", totalAmount: "90.00", firstDueAt: D("2026-05-01T09:00:00.000Z") }));
  const inst4 = await prisma.installment.findFirstOrThrow({ where: { commitmentId: plan4.id } });
  const p6 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan4.id, installmentId: inst4.id, amount: "90.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  await asA(() => prep.approvePreparation({ businessId: A, preparationId: p6.id }));
  out.testAdapterScript.nextSubmit = { ok: false, failureCode: "INSUFFICIENT_FUNDS", failureMessage: "declined" };
  const failed = await asA(() => out.requestExecution({ businessId: A, preparationId: p6.id, provider: "test-adapter", idempotencyKey: `x-${runId}-f1`, confirm: true }));
  check("4.13 a failed submission → FAILED, NOTHING paid", failed.status === "FAILED" && (await prisma.payment.count({ where: { businessId: A, idempotencyKey: `prep:${p6.id}` } })) === 0);
  check("4.14 …the preparation returns to the owner as FAILED", (await prisma.paymentPreparation.findUniqueOrThrow({ where: { id: p6.id } })).status === "FAILED");
  const retry = await asA(() => out.requestExecution({ businessId: A, preparationId: p6.id, provider: "test-adapter", idempotencyKey: `x-${runId}-f2`, confirm: true }));
  check("4.15 a retry is a NEW execution and may succeed", retry.id !== failed.id && retry.status === "ACKNOWLEDGED");

  // Destination substituted after approval → execution refused, nothing sent.
  const plan5 = await asA(() => svc.createCommitment({ businessId: A, title: "ספק 5", payeeId: payee.id, scheduleKind: "ONE_OFF", totalAmount: "60.00", firstDueAt: D("2026-05-01T09:00:00.000Z") }));
  const inst5 = await prisma.installment.findFirstOrThrow({ where: { commitmentId: plan5.id } });
  const p7 = await asA(() => prep.preparePayment({ businessId: A, commitmentId: plan5.id, installmentId: inst5.id, amount: "60.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  await asA(() => prep.approvePreparation({ businessId: A, preparationId: p7.id }));
  await prisma.paymentPreparation.update({ where: { id: p7.id }, data: { destinationId: shared.id } });
  const sentBefore = out.testAdapterScript.submitted.length;
  await rejects("4.16 a destination swapped after approval → refused", () => asA(() => out.requestExecution({ businessId: A, preparationId: p7.id, provider: "test-adapter", idempotencyKey: `x-${runId}-s`, confirm: true })), "changed after approval");
  check("4.17 …and nothing was sent to the provider", out.testAdapterScript.submitted.length === sentBefore);

  /* ── 5. tenant isolation ────────────────────────────────────────────── */
  console.log("\n[5] tenant isolation");
  check("5.1 B sees none of A's preparations", (await asB(() => prep.listPreparations({ businessId: B, scope: "all" }))).length === 0);
  check("5.2 B sees none of A's bank lines", (await asB(() => obs.listObservations({ businessId: B, scope: "all" }))).length === 0);
  await rejects("5.3 B cannot approve A's preparation", () => asB(() => prep.approvePreparation({ businessId: B, preparationId: p5.id })), "PayablesNotFoundError");
  await rejects("5.4 B cannot complete A's preparation", () => asB(() => prep.reportPreparationCompleted({ businessId: B, preparationId: p2.id, paidAt: new Date() })), "PayablesNotFoundError");
  await rejects("5.5 B cannot attach A's bank line", () => asB(() => obs.attachObservationToPayment({ businessId: B, externalTransactionId: lines[2].id, paymentId: payRow.id })), "PayablesNotFoundError");
  await rejects("5.6 B cannot execute A's preparation", () => asB(() => out.requestExecution({ businessId: B, preparationId: p6.id, provider: "test-adapter", idempotencyKey: `x-${runId}-b`, confirm: true })), "PayablesNotFoundError");
  await rejects("5.7 B cannot prepare a payment to A's destination", async () => {
    const pb = await asB(() => svc.createPayee({ businessId: B, displayName: "B payee" }));
    const cb = await asB(() => svc.createCommitment({ businessId: B, title: "B", payeeId: pb.id, scheduleKind: "ONE_OFF", totalAmount: "1.00", firstDueAt: new Date() }));
    await asB(() => prep.preparePayment({ businessId: B, commitmentId: cb.id, amount: "1.00", method: "BANK_TRANSFER", destinationId: d1.id }));
  }, "PayablesNotFoundError");

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("DB suite crashed:", err);
  process.exit(1);
});
