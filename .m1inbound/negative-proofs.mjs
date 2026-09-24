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
];

let broken = 0;
for (const proof of PROOFS) {
  const original = readFileSync(proof.file, "utf8");
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
    writeFileSync(proof.file, original);
  }
  if (result.status === 0) {
    console.log(`NEGATIVE-PROOF FAIL: the battery stayed green with "${proof.name}" (cases ${proof.cases})`);
    broken++;
  } else {
    const failed = (result.stdout.match(/\[FAIL\][^\n]*/g) ?? []).slice(0, 2).join(" | ");
    console.log(`negative proof OK — "${proof.name}" turns cases ${proof.cases} red: ${failed}`);
  }
}
if (broken > 0) {
  console.log(`\nM1 negative proofs: ${broken} of ${PROOFS.length} did NOT hold`);
  process.exit(1);
}
console.log(`\nM1 negative proofs: all ${PROOFS.length} hold`);
