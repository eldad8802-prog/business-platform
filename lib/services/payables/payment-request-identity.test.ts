/**
 * Pure proofs for the payment request identity (no database).
 *   node_modules/.bin/tsx lib/services/payables/payment-request-identity.test.ts
 */
import {
  identityMismatches,
  legacyMismatches,
  normalizeIdempotencyKey,
  paidDateOf,
  paymentRequestFingerprint,
  paymentRequestIdentity,
} from "@/lib/services/payables/payment-request-identity";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const base = {
  commitmentId: 16,
  amount: "50.00",
  paidAt: new Date("2026-09-29T09:00:00.000Z"),
  method: "BANK_TRANSFER",
  installmentIds: [21],
  externalReference: null,
};
const id = paymentRequestIdentity(base);
const fp = paymentRequestFingerprint(id);

console.log("\nidentity");
check("amount is exact agorot", id.amountMinor === 5000);
check("paid date is the Israel business date", id.paidDate === "2026-09-29");
check("Israel date at a UTC day boundary: 2026-09-29T22:30Z is 30/09 in Israel", paidDateOf(new Date("2026-09-29T22:30:00Z")) === "2026-09-30");
check("installment ids are sorted and unique", JSON.stringify(paymentRequestIdentity({ ...base, installmentIds: [9, 3, 9] }).installmentIds) === "[3,9]");
check("an empty installment list means due-date order (null)", paymentRequestIdentity({ ...base, installmentIds: [] }).installmentIds === null);
check("keys are trimmed; blank is no key", normalizeIdempotencyKey("  k ") === "k" && normalizeIdempotencyKey("   ") === null);

console.log("\nfingerprint");
check("deterministic", paymentRequestFingerprint(paymentRequestIdentity(base)) === fp);
check("same request with '50' instead of '50.00' → same fingerprint", paymentRequestFingerprint(paymentRequestIdentity({ ...base, amount: 50 })) === fp);
check("same Israel day, other clock time → same fingerprint", paymentRequestFingerprint(paymentRequestIdentity({ ...base, paidAt: new Date("2026-09-29T18:00:00Z") })) === fp);
check("installment order does not matter", paymentRequestFingerprint(paymentRequestIdentity({ ...base, installmentIds: [22, 21] })) === paymentRequestFingerprint(paymentRequestIdentity({ ...base, installmentIds: [21, 22] })));
const variants: Array<[string, Partial<typeof base>, string]> = [
  ["amount", { amount: "50.01" }, "amountMinor"],
  ["commitment", { commitmentId: 15 }, "commitmentId"],
  ["paid date", { paidAt: new Date("2026-09-30T09:00:00Z") }, "paidDate"],
  ["method", { method: "CASH" }, "method"],
  ["installments", { installmentIds: [22] }, "installmentIds"],
  ["external reference", { externalReference: "REF-1" } as Partial<typeof base>, "externalReference"],
];
for (const [label, change, field] of variants) {
  const other = paymentRequestIdentity({ ...base, ...change });
  check(`changed ${label} → different fingerprint, mismatch names ${field}`, paymentRequestFingerprint(other) !== fp && JSON.stringify(identityMismatches(id, other)) === JSON.stringify([field]));
}

console.log("\nlegacy comparison (no stored fingerprint)");
const recorded = { commitmentId: 16, amountMinor: 5000, paidAt: base.paidAt, method: "BANK_TRANSFER", externalReference: null, activeAllocationInstallmentIds: [21] };
check("the same request matches", legacyMismatches(id, recorded).length === 0);
check("an allocation outside the requested installments is a mismatch", legacyMismatches(paymentRequestIdentity({ ...base, installmentIds: [22] }), recorded).includes("installmentIds"));
check("an unknown commitment is a mismatch, never a silent replay", legacyMismatches(id, { ...recorded, commitmentId: null }).includes("commitmentId"));
check("every differing field is reported", JSON.stringify(legacyMismatches(paymentRequestIdentity({ ...base, amount: "1", method: "CASH" }), recorded)) === JSON.stringify(["amountMinor", "method"]));

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
