/**
 * D4 — the issuance gate and the identity lock (#1081), with enforcement OFF and ON. Pure: a fake transaction that
 * records every read. OFF must be today's behaviour: one read of the (empty) enforcement table, no refusal, the
 * declaration table never read. Plus a source check that the gate sits before numbering in issueBillingDocumentTx.
 *
 *   npx tsx lib/services/billing/issuer-declaration/issuer-declaration-gates.test.ts
 */
import { readFileSync } from "node:fs";

import { ConflictError, ValidationError } from "@/lib/errors";
import {
  assertIssuerDeclarationForIssueTx,
  assertIssuerIdentityEditableTx,
} from "@/lib/services/billing/issuer-declaration/issuer-declaration-gates";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL: D4", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK: D4", name);
}

function fakeTx(opts: { enforced: boolean; declared: boolean }) {
  const reads: string[] = [];
  const tx = {
    issuerDeclarationEnforcement: {
      findFirst: async () => {
        reads.push("enforcement");
        return opts.enforced ? { id: 1 } : null;
      },
    },
    businessIssuerDeclaration: {
      findFirst: async () => {
        reads.push("declaration");
        return opts.declared ? { id: 5 } : null;
      },
    },
  };
  return { tx: tx as never, reads };
}

async function outcome(p: Promise<void>): Promise<string> {
  try {
    await p;
    return "PASS";
  } catch (e) {
    return e instanceof ValidationError ? "REFUSED" : e instanceof ConflictError ? "CONFLICT" : `ERROR ${String(e)}`;
  }
}

const complete = {
  billingBusinessKind: "AUTHORIZED_DEALER", billingLegalName: "ישראל", billingTaxId: "000000018", billingVatNumber: "000000018",
  billingAddress: "הרצל 1", billingPhone: "0501234567", billingEmail: "a@example.com",
};
// Today's minimum (isBillingIdentityComplete) passes, but no VAT number: incomplete for the declaration.
const todayOnly = { ...complete, billingVatNumber: null };

(async () => {
  // OFF
  for (const docType of ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE"]) {
    const { tx, reads } = fakeTx({ enforced: false, declared: false });
    const r = await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: docType, profile: todayOnly }));
    ok(`OFF ${docType}: passes without a declaration and with today's minimum details`, r === "PASS", r);
    ok(`OFF ${docType}: reads only the enforcement table`, JSON.stringify(reads) === '["enforcement"]', reads);
  }
  {
    const { tx, reads } = fakeTx({ enforced: true, declared: false });
    const r = await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: "QUOTE", profile: null }));
    ok("a QUOTE is never governed (no read at all, even ON)", r === "PASS" && reads.length === 0, { r, reads });
  }

  // ON
  {
    const { tx } = fakeTx({ enforced: true, declared: false });
    ok("ON: complete details, no declaration → refused", (await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: "TAX_INVOICE", profile: complete }))) === "REFUSED");
  }
  {
    const { tx, reads } = fakeTx({ enforced: true, declared: true });
    const r = await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: "TAX_INVOICE", profile: todayOnly }));
    ok("ON: declaration present but details incomplete → refused before the declaration read", r === "REFUSED" && !reads.includes("declaration"), { r, reads });
  }
  {
    const { tx } = fakeTx({ enforced: true, declared: true });
    ok("ON: complete details + declaration → passes", (await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: "RECEIPT", profile: { ...complete, billingBusinessKind: "EXEMPT_DEALER", billingVatNumber: null } }))) === "PASS");
  }
  {
    const { tx } = fakeTx({ enforced: true, declared: false });
    ok("ON: no profile at all → refused", (await outcome(assertIssuerDeclarationForIssueTx(tx, { businessId: 1, documentType: "RECEIPT", profile: null }))) === "REFUSED");
  }

  // Identity lock (API side)
  const before = { billingBusinessKind: "AUTHORIZED_DEALER", billingLegalName: "ישראל", billingTaxId: "000000018", billingVatNumber: "000000018" };
  {
    const { tx, reads } = fakeTx({ enforced: false, declared: true });
    const r = await outcome(assertIssuerIdentityEditableTx(tx, 1, before, { billingPhone: "0509999999", billingFooterNote: "x" }));
    ok("lock: a non-identity save never reads the declaration", r === "PASS" && reads.length === 0, { r, reads });
  }
  {
    const { tx, reads } = fakeTx({ enforced: false, declared: true });
    const r = await outcome(assertIssuerIdentityEditableTx(tx, 1, before, { billingLegalName: "ישראל" }));
    ok("lock: re-saving the same identity value passes without a read", r === "PASS" && reads.length === 0, { r, reads });
  }
  for (const f of ["billingLegalName", "billingTaxId", "billingVatNumber", "billingBusinessKind"] as const) {
    const { tx } = fakeTx({ enforced: false, declared: true });
    const r = await outcome(assertIssuerIdentityEditableTx(tx, 1, before, { [f]: f === "billingBusinessKind" ? "LTD_COMPANY" : "999999998" }));
    ok(`lock: changing ${f} after a declaration → 409`, r === "CONFLICT", r);
  }
  {
    const { tx } = fakeTx({ enforced: false, declared: false });
    ok("lock: before any declaration the identity is a draft (change passes)", (await outcome(assertIssuerIdentityEditableTx(tx, 1, before, { billingTaxId: "999999998" }))) === "PASS");
  }

  // Placement: the gate runs after the existing checks and before the number sequence is touched.
  const src = readFileSync("lib/services/billing/billing-issue.service.ts", "utf8");
  const body = src.slice(src.indexOf("export async function issueBillingDocumentTx("));
  const gateAt = body.indexOf("await assertIssuerDeclarationForIssueTx(tx,");
  const kindAt = body.indexOf("assertDocumentTypeAllowedForBusinessKind(");
  const seqAt = body.indexOf("billingDocumentNumberSequence.upsert(");
  ok("placement: gate is inside issueBillingDocumentTx", gateAt > 0);
  ok("placement: after the existing business-kind check", kindAt > 0 && gateAt > kindAt);
  ok("placement: before the number sequence is touched", seqAt > 0 && gateAt < seqAt);
  ok("no application code writes the enforcement row", !/issuerDeclarationEnforcement\.(create|upsert|createMany)|INSERT INTO "IssuerDeclarationEnforcement"/.test(
    ["lib/services/billing/issuer-declaration/issuer-declaration.service.ts", "lib/services/billing/issuer-declaration/issuer-declaration-gates.ts"].map((p) => readFileSync(p, "utf8")).join("\n")
  ));

  console.log(failed ? `\nD4: ${passed} passed, ${failed} FAILED` : `\nD4: ${passed}/${passed} passed`);
  if (failed) process.exit(1);
})();
