/**
 * Payables Phase 3 — cheques and business bank accounts, against a real database.
 *
 * What a pure test cannot reach: that nothing in the clear lands in a row, that
 * the migration's partial indexes and the service agree, that a cleared cheque
 * is exactly ONE canonical Payment (on retry and under a race), and that a
 * second tenant sees none of it.
 *
 * Run (CI provides an ephemeral postgres:17 service):
 *   TEST_DATABASE_URL="postgres://…" npx tsx lib/services/payables/payables-3.db.test.ts
 */

import { randomBytes } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error(
    "ABORT (DB safety guard): set TEST_DATABASE_URL to an approved, non-production " +
      "test Postgres URL. Refusing to seed/delete against the ambient DATABASE_URL.",
  );
  process.exit(1);
}
process.env.DATABASE_URL = TEST_DB;
if (!process.env.AUTH_TOKEN_SECRET?.trim()) {
  process.env.AUTH_TOKEN_SECRET = "payables-p3-test-secret";
}
// Synthetic keys, generated per run. Never a real key in a test.
process.env.PAYABLES_BANK_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.PAYABLES_BANK_FINGERPRINT_KEY = randomBytes(32).toString("base64");

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
    const ok =
      !expect || (typeof expect === "string" ? msg.includes(expect) : expect.test(msg));
    if (!ok) failures += 1;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — wrong error: ${msg}`}`);
  }
}

async function main(): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const svc = await import("@/lib/services/payables/payables.service");
  const bank = await import("@/lib/services/payables/payables-bank-account.service");
  const cheques = await import("@/lib/services/payables/payables-cheque.service");
  const crypto = await import("@/lib/services/payables/payables-bank-crypto");

  // The migration's partial indexes. `db push` cannot express them, so the suite
  // creates the same objects — otherwise the guard tests below would pass
  // vacuously against a database that has no guards.
  for (const sql of [
    `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentAllocation_active_payment_installment_key"
       ON "PaymentAllocation"("paymentId", "installmentId") WHERE "reversedAt" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessBankAccount_one_active_default"
       ON "BusinessBankAccount"("businessId") WHERE "isDefault" = true AND "isActive" = true`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Cheque_active_number_key"
       ON "Cheque"("businessId", "sourceBankAccountId", "chequeNumber") WHERE "cancelledAt" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Cheque_replaces_key"
       ON "Cheque"("replacesChequeId") WHERE "replacesChequeId" IS NOT NULL`,
  ]) {
    await prisma.$executeRawUnsafe(sql);
  }

  async function makeBusiness(label: string): Promise<number> {
    const b = await prisma.business.create({
      data: {
        name: `P3 ${label} ${runId}`,
        users: {
          create: {
            email: `p3-${label}-${runId}@example.test`,
            password: "test-password",
            name: "P3 Test User",
          },
        },
      },
    });
    return b.id;
  }

  const A = await makeBusiness("A");
  const B = await makeBusiness("B");
  const asA = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: A }, fn);
  const asB = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: B }, fn);
  const D = (iso: string) => new Date(iso);

  const COORDS = { bankCode: "12", branchCode: "034", accountNumber: "0012345678" };

  /* ── 1. bank accounts: nothing in the clear, masked everywhere ─────────── */
  console.log("\n[1] bank accounts — at rest and on the wire");

  const created = await asA(() =>
    bank.createBusinessBankAccount({ businessId: A, label: "ראשי", ...COORDS }),
  );
  const acc1 = created.account;
  check("1.1 the returned view is masked: ••••5678", acc1.masked === "••••5678" && acc1.last4 === "5678");
  check(
    "1.2 the view carries no ciphertext, fingerprint or coordinates",
    JSON.stringify(Object.keys(acc1).sort()) ===
      JSON.stringify(["createdAt", "id", "isActive", "isDefault", "label", "last4", "masked", "note"]),
  );
  check("1.3 the first account becomes the default by itself", acc1.isDefault === true);

  const raw = await prisma.businessBankAccount.findUniqueOrThrow({ where: { id: acc1.id } });
  const rawJson = JSON.stringify(raw);
  check("1.4 the stored row does not contain the account number", !rawJson.includes("0012345678") && !rawJson.includes("12345678"));
  check("1.5 the stored key id is payables-bank-v1", raw.encryptionKeyId === "payables-bank-v1");
  check("1.6 the stored fingerprint is a keyed 64-hex value", /^[0-9a-f]{64}$/.test(raw.fingerprint));
  const opened = crypto.openBankCoordinates(raw, A, "BUSINESS_BANK_ACCOUNT");
  check("1.7 the ciphertext is recoverable, leading zeros intact", opened?.accountNumber === "0012345678" && opened?.branchCode === "034");
  check("1.8 …and does NOT open as tenant B", crypto.openBankCoordinates(raw, B, "BUSINESS_BANK_ACCOUNT") === null);

  const listed = await asA(() => bank.listBusinessBankAccounts({ businessId: A }));
  check("1.9 list returns masked views only", listed.every((a) => !("fingerprint" in a) && !("coordinatesEncrypted" in a)));

  /* ── 2. bank accounts: uniqueness, default, archive/restore ────────────── */
  console.log("\n[2] bank accounts — invariants");

  const countBefore = await prisma.businessBankAccount.count({ where: { businessId: A } });
  await rejects(
    "2.1 the same account again (separators differ) is a 409, not a second row",
    () => asA(() => bank.createBusinessBankAccount({ businessId: A, label: "dup", bankCode: "12", branchCode: "034", accountNumber: "00-1234-5678" })),
    "PayablesConflictError",
  );
  check("2.2 …and nothing was written", (await prisma.businessBankAccount.count({ where: { businessId: A } })) === countBefore);

  const inB = await asB(() => bank.createBusinessBankAccount({ businessId: B, label: "B main", ...COORDS }));
  const rawB = await prisma.businessBankAccount.findUniqueOrThrow({ where: { id: inB.account.id } });
  check("2.3 the same account in tenant B is allowed", inB.account.id !== acc1.id);
  check("2.4 …with a DIFFERENT fingerprint (no cross-tenant correlation)", rawB.fingerprint !== raw.fingerprint);

  const withZero = await asA(() =>
    bank.createBusinessBankAccount({ businessId: A, label: "no-zero", bankCode: "12", branchCode: "034", accountNumber: "12345678" }),
  );
  check("2.5 12345678 is a different account from 0012345678 (zeros preserved)", withZero.account.id !== acc1.id);

  await asA(() => bank.setDefaultBusinessBankAccount({ businessId: A, bankAccountId: withZero.account.id }));
  const defaults = await prisma.businessBankAccount.count({ where: { businessId: A, isDefault: true, isActive: true } });
  check("2.6 making another default leaves exactly one default", defaults === 1);

  await rejects(
    "2.7 the DB refuses a second active default even with the service bypassed",
    () => prisma.businessBankAccount.update({ where: { id: acc1.id }, data: { isDefault: true } }),
    /Unique constraint|P2002/,
  );

  const archived = await asA(() => bank.archiveBusinessBankAccount({ businessId: A, bankAccountId: withZero.account.id }));
  check("2.8 archiving clears the default flag", archived.isActive === false && archived.isDefault === false);
  const restored = await asA(() =>
    bank.createBusinessBankAccount({ businessId: A, label: "back", bankCode: "12", branchCode: "034", accountNumber: "12345678" }),
  );
  check("2.9 re-adding an archived account RESTORES the same row", restored.restored && restored.account.id === withZero.account.id);

  await rejects(
    "2.10 tenant B cannot make A's account its default (404, not 403)",
    () => asB(() => bank.setDefaultBusinessBankAccount({ businessId: B, bankAccountId: acc1.id })),
    "PayablesNotFoundError",
  );
  await rejects(
    "2.11 tenant B cannot archive A's account",
    () => asB(() => bank.archiveBusinessBankAccount({ businessId: B, bankAccountId: acc1.id })),
    "PayablesNotFoundError",
  );

  const savedKey = process.env.PAYABLES_BANK_ENCRYPTION_KEY;
  delete process.env.PAYABLES_BANK_ENCRYPTION_KEY;
  const beforeNoKey = await prisma.businessBankAccount.count();
  await rejects(
    "2.12 a missing encryption key fails CLOSED",
    () => asA(() => bank.createBusinessBankAccount({ businessId: A, label: "nokey", bankCode: "20", branchCode: "100", accountNumber: "55556666" })),
    "PayablesBankCryptoConfigError",
  );
  check("2.13 …and wrote nothing (no plaintext fallback)", (await prisma.businessBankAccount.count()) === beforeNoKey);
  process.env.PAYABLES_BANK_ENCRYPTION_KEY = savedKey;

  const bankAudit = await prisma.payablesAuditEvent.findMany({
    where: { businessId: A, eventType: { startsWith: "BANK_ACCOUNT_" } },
  });
  const auditJson = JSON.stringify(bankAudit);
  check("2.14 bank audit events exist", bankAudit.length >= 4, `saw ${bankAudit.length}`);
  check("2.15 no audit row carries an account number", !auditJson.includes("0012345678") && !auditJson.includes("12345678"));

  /* ── 3. cheques: numbers are text, live-number uniqueness ─────────────── */
  console.log("\n[3] cheques — numbers");

  const payee = await asA(() => svc.createPayee({ businessId: A, displayName: "ספק הדפוס", kind: "SUPPLIER" }));
  const plan = await asA(() =>
    svc.createCommitment({
      businessId: A,
      title: "הדפסות 2027",
      payeeId: payee.id,
      scheduleKind: "INSTALLMENT_PLAN",
      totalAmount: "3000.00",
      installmentCount: 3,
      recurrence: "MONTHLY",
      firstDueAt: D("2027-02-10T09:00:00.000Z"),
    }),
  );
  const insts = await prisma.installment.findMany({ where: { commitmentId: plan.id }, orderBy: { sequence: "asc" } });

  const c1 = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "000123",
      amount: "1000.00",
      issueDate: D("2027-02-01T09:00:00.000Z"),
      dueDate: D("2027-02-10T09:00:00.000Z"),
      sourceBankAccountId: acc1.id,
      installmentId: insts[0].id,
    }),
  );
  check("3.1 the number keeps its leading zeros as text", c1.chequeNumber === "000123");
  check("3.2 the installment implies its commitment", c1.commitment?.id === plan.id && c1.installment?.id === insts[0].id);
  check("3.3 the payee snapshot comes from the commitment", c1.payeeNameSnapshot === "ספק הדפוס");
  check("3.4 the source account is shown masked only", c1.sourceBankAccount.masked === "••••5678" && !("fingerprint" in c1.sourceBankAccount));
  check("3.5 a new cheque is PLANNED", c1.status === "PLANNED");

  const odd = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "A-7788/ג",
      amount: "50.00",
      issueDate: D("2027-02-01T09:00:00.000Z"),
      dueDate: D("2027-02-01T09:00:00.000Z"),
      sourceBankAccountId: acc1.id,
      payeeName: "קיוסק",
    }),
  );
  check("3.6 a non-numeric number is accepted verbatim", odd.chequeNumber === "A-7788/ג");

  await rejects(
    "3.7 a duplicate LIVE number in the same chequebook is a 409",
    () =>
      asA(() =>
        cheques.createCheque({
          businessId: A,
          chequeNumber: "000123",
          amount: "1.00",
          issueDate: D("2027-02-01T09:00:00.000Z"),
          dueDate: D("2027-02-01T09:00:00.000Z"),
          sourceBankAccountId: acc1.id,
          payeeName: "x",
        }),
      ),
    "PayablesConflictError",
  );
  const sameNumberOtherBook = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "000123",
      amount: "1.00",
      issueDate: D("2027-02-01T09:00:00.000Z"),
      dueDate: D("2027-02-01T09:00:00.000Z"),
      sourceBankAccountId: restored.account.id,
      payeeName: "x",
    }),
  );
  check("3.8 the same number in a DIFFERENT chequebook is allowed", sameNumberOtherBook.id > 0);
  await asA(() => cheques.cancelCheque({ businessId: A, chequeId: sameNumberOtherBook.id, reason: "test" }));
  const reused = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "000123",
      amount: "1.00",
      issueDate: D("2027-02-01T09:00:00.000Z"),
      dueDate: D("2027-02-01T09:00:00.000Z"),
      sourceBankAccountId: restored.account.id,
      payeeName: "x",
    }),
  );
  check("3.9 after cancellation the number can be recorded again", reused.id !== sameNumberOtherBook.id);
  await asA(() => cheques.cancelCheque({ businessId: A, chequeId: reused.id }));

  await rejects(
    "3.10 an installment of ANOTHER commitment is refused",
    async () => {
      const other = await asA(() =>
        svc.createCommitment({ businessId: A, title: "other", payeeNameSnapshot: "o", scheduleKind: "ONE_OFF", totalAmount: "10.00", firstDueAt: D("2027-03-01T09:00:00.000Z") }),
      );
      await asA(() =>
        cheques.createCheque({
          businessId: A,
          chequeNumber: "999",
          amount: "10.00",
          issueDate: D("2027-02-01T09:00:00.000Z"),
          dueDate: D("2027-02-01T09:00:00.000Z"),
          sourceBankAccountId: acc1.id,
          commitmentId: other.id,
          installmentId: insts[0].id,
        }),
      );
    },
    "does not belong",
  );

  /* ── 4. clearing = ONE canonical Payment ─────────────────────────────── */
  console.log("\n[4] clearing — the ledger link");

  await rejects(
    "4.1 a PLANNED cheque cannot have cleared",
    () => asA(() => cheques.clearCheque({ businessId: A, chequeId: c1.id, clearedAt: D("2027-02-11T09:00:00.000Z") })),
    "has not been written",
  );
  await asA(() => cheques.advanceCheque({ businessId: A, chequeId: c1.id, to: "ISSUED" }));
  await asA(() => cheques.advanceCheque({ businessId: A, chequeId: c1.id, to: "DELIVERED" }));

  const paymentsBefore = await prisma.payment.count({ where: { businessId: A } });
  const cleared = await asA(() =>
    cheques.clearCheque({ businessId: A, chequeId: c1.id, clearedAt: D("2027-02-11T09:00:00.000Z") }),
  );
  const payRow = await prisma.payment.findFirst({
    where: { businessId: A, idempotencyKey: `cheque:${c1.id}` },
    include: { allocations: true, evidences: true },
  });
  check("4.2 clearing created exactly ONE Payment", (await prisma.payment.count({ where: { businessId: A } })) === paymentsBefore + 1);
  check("4.3 …method CHECK, amount 1000.00, keyed cheque:<id>", payRow?.method === "CHECK" && payRow.amount.toFixed(2) === "1000.00");
  check("4.4 …allocated to the cheque's installment in full", payRow?.allocations.length === 1 && payRow.allocations[0].installmentId === insts[0].id && payRow.allocations[0].allocatedAmount.toFixed(2) === "1000.00");
  check("4.5 …with CHEQUE evidence", payRow?.evidences.length === 1 && payRow.evidences[0].kind === "CHEQUE");
  check("4.6 …whose note says owner-asserted, not bank-verified", /owner-asserted \(not bank-verified\)/.test(payRow?.evidences[0].note ?? ""));
  const chequeRow = await prisma.cheque.findUniqueOrThrow({ where: { id: c1.id } });
  check("4.7 the cheque is CLEARED with provenance OWNER_ASSERTED", chequeRow.status === "CLEARED" && chequeRow.clearedSource === "OWNER_ASSERTED");
  check("4.8 the view reports the provenance explicitly", cleared.cheque.cleared?.source === "OWNER_ASSERTED" && cleared.unallocated === "0.00");

  const bal = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }));
  check("4.9 the installment is now PAID through the ledger", bal.installments[0].state === "PAID" && bal.paid === "1000.00");

  const replay = await asA(() =>
    cheques.clearCheque({ businessId: A, chequeId: c1.id, clearedAt: D("2027-02-12T09:00:00.000Z") }),
  );
  check("4.10 clearing again is a replay", replay.replayed === true);
  check("4.11 …and creates NO second Payment", (await prisma.payment.count({ where: { businessId: A } })) === paymentsBefore + 1);

  // Overpayment: a cheque larger than what its installment still owes.
  const big = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "000124",
      amount: "1500.00",
      issueDate: D("2027-03-01T09:00:00.000Z"),
      dueDate: D("2027-03-10T09:00:00.000Z"),
      sourceBankAccountId: acc1.id,
      installmentId: insts[1].id,
      status: "ISSUED",
    }),
  );
  const bigCleared = await asA(() =>
    cheques.clearCheque({ businessId: A, chequeId: big.id, clearedAt: D("2027-03-11T09:00:00.000Z") }),
  );
  const bigPay = await prisma.payment.findFirstOrThrow({
    where: { businessId: A, idempotencyKey: `cheque:${big.id}` },
    include: { allocations: true },
  });
  check("4.12 an oversized cheque allocates only what is due (1000.00)", bigPay.allocations.length === 1 && bigPay.allocations[0].allocatedAmount.toFixed(2) === "1000.00");
  check("4.13 …and the surplus 500.00 stays UNALLOCATED", bigCleared.unallocated === "500.00");
  check("4.14 …never spilling onto the next installment", (await prisma.paymentAllocation.count({ where: { installmentId: insts[2].id } })) === 0);

  /* ── 5. bounce after clear, cancel/replace rules ─────────────────────── */
  console.log("\n[5] bounce, cancel, replace");

  await asA(() => cheques.bounceCheque({ businessId: A, chequeId: big.id, reason: "אין כיסוי" }));
  const bigPayAfter = await prisma.payment.findUniqueOrThrow({ where: { id: bigPay.id } });
  check("5.1 bouncing a cleared cheque VOIDS its Payment", bigPayAfter.status === "VOID");
  check("5.2 …which is kept, not deleted", bigPayAfter.id === bigPay.id);
  const balAfter = await asA(() => svc.getCommitmentBalance({ businessId: A, commitmentId: plan.id }));
  check("5.3 …and the installment is owed again", balAfter.installments[1].paid === "0.00");

  await rejects("5.4 a CLEARED cheque cannot be cancelled", () => asA(() => cheques.cancelCheque({ businessId: A, chequeId: c1.id })), "cannot be cancelled");
  await rejects(
    "5.5 a CLEARED cheque cannot be replaced",
    () => asA(() => cheques.replaceCheque({ businessId: A, chequeId: c1.id, chequeNumber: "777", issueDate: D("2027-03-01T09:00:00.000Z"), dueDate: D("2027-03-01T09:00:00.000Z") })),
    "cannot be replaced",
  );

  const rep = await asA(() =>
    cheques.replaceCheque({
      businessId: A,
      chequeId: big.id,
      chequeNumber: "000220",
      issueDate: D("2027-03-15T09:00:00.000Z"),
      dueDate: D("2027-03-20T09:00:00.000Z"),
      reason: "חזר, הוחלף",
    }),
  );
  check("5.6 the bounced cheque becomes REPLACED (kept, not edited)", rep.replaced.status === "REPLACED" && rep.replaced.chequeNumber === "000124");
  check("5.7 the replacement links back to it", rep.replacement.replaces?.id === big.id && rep.replaced.replacedBy?.id === rep.replacement.id);
  check("5.8 the replacement inherits what it is FOR", rep.replacement.installment?.id === insts[1].id && rep.replacement.amount === "1500.00");
  await rejects(
    "5.9 a second replacement of the same cheque is refused (no fork)",
    () => asA(() => cheques.replaceCheque({ businessId: A, chequeId: big.id, chequeNumber: "000221", issueDate: D("2027-03-15T09:00:00.000Z"), dueDate: D("2027-03-20T09:00:00.000Z") })),
  );
  await rejects(
    "5.10 the DB refuses a fork even with the service bypassed",
    () =>
      prisma.cheque.create({
        data: {
          businessId: A,
          payeeNameSnapshot: "x",
          amount: "1.00",
          chequeNumber: "000222",
          issueDate: new Date(),
          dueDate: new Date(),
          sourceBankAccountId: acc1.id,
          replacesChequeId: big.id,
        },
      }),
    /Unique constraint|P2002/,
  );

  await asA(() => bank.archiveBusinessBankAccount({ businessId: A, bankAccountId: restored.account.id }));
  await rejects(
    "5.11 a cheque cannot be drawn on an archived account",
    () =>
      asA(() =>
        cheques.createCheque({
          businessId: A,
          chequeNumber: "5001",
          amount: "1.00",
          issueDate: D("2027-02-01T09:00:00.000Z"),
          dueDate: D("2027-02-01T09:00:00.000Z"),
          sourceBankAccountId: restored.account.id,
          payeeName: "x",
        }),
      ),
    "archived",
  );

  /* ── 6. no commitment / closed commitment / race ─────────────────────── */
  console.log("\n[6] edges");

  await asA(() => cheques.advanceCheque({ businessId: A, chequeId: odd.id, to: "ISSUED" }));
  const loose = await asA(() => cheques.clearCheque({ businessId: A, chequeId: odd.id, clearedAt: D("2027-02-02T09:00:00.000Z") }));
  const loosePay = await prisma.payment.findFirstOrThrow({
    where: { businessId: A, idempotencyKey: `cheque:${odd.id}` },
    include: { allocations: true, evidences: true },
  });
  check("6.1 a cheque with no commitment still becomes ONE Payment", loosePay.allocations.length === 0 && loosePay.evidences[0]?.kind === "CHEQUE");
  check("6.2 …entirely unallocated", loose.unallocated === "50.00");

  const closing = await asA(() =>
    svc.createCommitment({ businessId: A, title: "closing", payeeNameSnapshot: "c", scheduleKind: "ONE_OFF", totalAmount: "300.00", firstDueAt: D("2027-04-01T09:00:00.000Z") }),
  );
  const closingCheque = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "8001",
      amount: "300.00",
      issueDate: D("2027-03-25T09:00:00.000Z"),
      dueDate: D("2027-04-01T09:00:00.000Z"),
      sourceBankAccountId: acc1.id,
      commitmentId: closing.id,
      status: "ISSUED",
    }),
  );
  await prisma.commitment.update({ where: { id: closing.id }, data: { status: "CLOSED" } });
  const closedClear = await asA(() =>
    cheques.clearCheque({ businessId: A, chequeId: closingCheque.id, clearedAt: D("2027-04-02T09:00:00.000Z") }),
  );
  check("6.3 a cheque on a since-CLOSED commitment still clears — money left", closedClear.cheque.status === "CLEARED");
  check("6.4 …as an unallocated Payment rather than a refused one", closedClear.unallocated === "300.00");

  const raceTarget = await asA(() =>
    cheques.createCheque({
      businessId: A,
      chequeNumber: "9001",
      amount: "1000.00",
      issueDate: D("2027-04-01T09:00:00.000Z"),
      dueDate: D("2027-04-10T09:00:00.000Z"),
      sourceBankAccountId: acc1.id,
      installmentId: insts[2].id,
      status: "ISSUED",
    }),
  );
  const results = await Promise.allSettled([
    asA(() => cheques.clearCheque({ businessId: A, chequeId: raceTarget.id, clearedAt: D("2027-04-11T09:00:00.000Z") })),
    asA(() => cheques.clearCheque({ businessId: A, chequeId: raceTarget.id, clearedAt: D("2027-04-11T09:00:00.000Z") })),
  ]);
  const racePayments = await prisma.payment.count({ where: { businessId: A, idempotencyKey: `cheque:${raceTarget.id}` } });
  check("6.5 two concurrent clears produce exactly ONE Payment", racePayments === 1, `saw ${racePayments}`);
  check("6.6 …and both calls return successfully (one is a replay)", results.every((r) => r.status === "fulfilled"));
  const raceAllocs = await prisma.paymentAllocation.aggregate({
    where: { installmentId: insts[2].id, reversedAt: null },
    _sum: { allocatedAmount: true },
  });
  check("6.7 …and the installment is not double-paid", raceAllocs._sum.allocatedAmount?.toFixed(2) === "1000.00");

  /* ── 7. tenant isolation ─────────────────────────────────────────────── */
  console.log("\n[7] tenant isolation");

  const bList = await asB(() => cheques.listCheques({ businessId: B, scope: "all" }));
  check("7.1 tenant B sees none of A's cheques", bList.length === 0);
  await rejects(
    "7.2 tenant B cannot clear A's cheque (404)",
    () => asB(() => cheques.clearCheque({ businessId: B, chequeId: rep.replacement.id, clearedAt: new Date() })),
    "PayablesNotFoundError",
  );
  await rejects(
    "7.3 tenant B cannot draw a cheque on A's account",
    () =>
      asB(() =>
        cheques.createCheque({
          businessId: B,
          chequeNumber: "1",
          amount: "1.00",
          issueDate: new Date(),
          dueDate: new Date(),
          sourceBankAccountId: acc1.id,
          payeeName: "x",
        }),
      ),
    "PayablesNotFoundError",
  );
  await rejects(
    "7.4 tenant B cannot attach a cheque to A's installment",
    () =>
      asB(() =>
        cheques.createCheque({
          businessId: B,
          chequeNumber: "2",
          amount: "1.00",
          issueDate: new Date(),
          dueDate: new Date(),
          sourceBankAccountId: inB.account.id,
          installmentId: insts[0].id,
        }),
      ),
    "PayablesNotFoundError",
  );

  const chequeAudit = await prisma.payablesAuditEvent.findMany({
    where: { businessId: A, eventType: { startsWith: "CHEQUE_" } },
  });
  check("7.5 every cheque action was audited", chequeAudit.length >= 10, `saw ${chequeAudit.length}`);
  check(
    "7.6 the clearing audit says OWNER_ASSERTED",
    chequeAudit.some((e) => e.eventType === "CHEQUE_CLEARED_OWNER_ASSERTED" && JSON.stringify(e.metadata).includes("OWNER_ASSERTED")),
  );
  check("7.7 no cheque audit carries an account number", !JSON.stringify(chequeAudit).includes("0012345678"));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("DB suite crashed:", err);
  process.exit(1);
});
