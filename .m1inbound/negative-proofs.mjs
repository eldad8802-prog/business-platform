/**
 * M1 negative proofs: each one puts a defect back and requires the battery to
 * FAIL. A battery that stays green with the defect restored proves nothing, so
 * a proof that does not turn it red fails this script.
 *
 * Run from the repository root, with the same environment as the battery:
 *   node .m1inbound/negative-proofs.mjs
 * The mutated file is always restored, whatever happens.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PROOFS = [
  {
    name: "an early (UNKNOWN) webhook is consumed again",
    file: "lib/services/payments/payment-webhook.service.ts",
    find: 'if (resolution.reason === "PROVIDER_OUTCOME_PENDING") {',
    replace:
      'if (resolution.reason === "PROVIDER_OUTCOME_PENDING") { await consume(); return { ok: true, eventId: event.id, processingStatus: "PROCESSED", duplicate: false, paymentRequestId: routed.id, paymentRequestStatus: routed.status, reason: null, verified: true }; } if (false) {',
    cases: "D,S",
  },
  {
    name: "PAID without the provider's transaction id is recorded (NULL key)",
    file: "lib/services/payments/payment-verification.service.ts",
    find: "if (!providerTransactionId) {",
    replace: "if (false) {",
    cases: "K",
  },
  {
    name: "the request's amount is recorded instead of the provider-verified amount",
    file: "lib/services/payments/payment-verification.service.ts",
    find: "        amount: verifiedAmount,\n        currency: verifiedCurrency,",
    replace: "        amount: request.amount,\n        currency: request.currency,",
    cases: "I,J",
  },
  {
    name: "settlement no longer pauses on a verified amount mismatch",
    file: "lib/services/billing/settlement/payment-accounting-settlement.service.ts",
    find: 'throw new SettlementAttention("VERIFIED_AMOUNT_MISMATCH");',
    replace: "void 0;",
    cases: "I",
  },
  {
    name: "the owner's cancel is an unconditional write again",
    file: "lib/services/payments/payment-request-cancel.service.ts",
    find: 'const updated = await deps.store.transitionPaymentRequestStatus(request.id, {\n    from: ["PENDING"],\n    to: "CANCELLED",\n  });',
    replace: 'const updated = await deps.store.updatePaymentRequest(request.id, { status: "CANCELLED" });',
    cases: "H",
  },
  {
    name: "reconciliation stops asking about cancelled requests",
    file: "lib/services/payments/payment-store.prisma.ts",
    find: 'status: { in: ["PENDING", "FAILED", "CANCELLED", "EXPIRED"] },',
    replace: 'status: { in: ["PENDING", "FAILED", "EXPIRED"] },',
    cases: "G",
  },
  {
    name: "a verified PAID no longer moves a closed request to PAID",
    file: "lib/services/payments/payment-verification.service.ts",
    find: 'const PAYABLE_FROM: readonly PaymentRequestStatus[] = ["PENDING", "FAILED", "CANCELLED", "EXPIRED"];',
    replace: 'const PAYABLE_FROM: readonly PaymentRequestStatus[] = ["PENDING"];',
    cases: "G",
  },
  {
    name: "a CardCom null response code reads as success again (F5)",
    file: "lib/services/payments/providers/cardcom/cardcom.provider.ts",
    find: "if (topCode === 0 && tranInfo && tranCode === 0) {",
    replace: "if ((topCode ?? 0) === 0 && tranInfo && (tranCode ?? 0) === 0) {",
    cases: "P",
  },
  {
    name: "an answer about another payment is waited on quietly as 'pending'",
    file: "lib/services/payments/payment-verification.service.ts",
    find: "if (status.detail && FOREIGN_ANSWER_DETAILS.has(status.detail)) {",
    replace: "if (false) {",
    cases: "P",
  },
];

// A proof is interruptible (Ctrl-C, a cancelled CI job, a killed process). The
// mutated file must never outlive the script: restore it on every way out.
let pending = null;
function restorePending() {
  if (pending) {
    writeFileSync(pending.file, pending.original);
    pending = null;
  }
}
process.on("exit", restorePending);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restorePending();
    process.exit(130);
  });
}

let broken = 0;
for (const proof of PROOFS) {
  const original = readFileSync(proof.file, "utf8");
  pending = { file: proof.file, original };
  const normalised = original.replace(/\r\n/g, "\n");
  if (!normalised.includes(proof.find)) {
    console.log(`NEGATIVE-PROOF SETUP FAIL: pattern not found for "${proof.name}" in ${proof.file}`);
    broken++;
    continue;
  }
  writeFileSync(proof.file, normalised.replace(proof.find, proof.replace));
  let result;
  try {
    result = spawnSync("npx", ["tsx", ".m1inbound/battery.mts"], {
      env: { ...process.env, M1_ONLY: proof.cases, M1_ITER: "3" },
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  } finally {
    restorePending();
  }
  // Red must mean an ASSERTION caught the defect. A battery that crashed (a
  // syntax error, a dead database) also exits non-zero and would otherwise
  // "prove" every mutation — so a proof requires the battery to have run its
  // cases and at least one of them to have failed.
  const assertionFailures = result.stdout?.match(/\[FAIL\][^\n]*/g) ?? [];
  const ran = /\[PASS\]/.test(result.stdout ?? "");
  if (result.status === 0) {
    console.log(`NEGATIVE-PROOF FAIL: the battery stayed green with "${proof.name}" (cases ${proof.cases})`);
    broken++;
  } else if (!ran || assertionFailures.length === 0) {
    console.log(`NEGATIVE-PROOF FAIL: the battery did not run to an assertion for "${proof.name}" — a crash is not a proof`);
    console.log((result.stdout ?? "").slice(-800) + (result.stderr ?? "").slice(-800));
    broken++;
  } else {
    console.log(`negative proof OK — "${proof.name}" turns cases ${proof.cases} red: ${assertionFailures.slice(0, 2).join(" | ")}`);
  }
}
if (broken > 0) {
  console.log(`\nM1 negative proofs: ${broken} of ${PROOFS.length} did NOT hold`);
  process.exit(1);
}
console.log(`\nM1 negative proofs: all ${PROOFS.length} hold`);
