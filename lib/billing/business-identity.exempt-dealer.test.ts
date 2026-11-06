/**
 * Pure rule: an EXEMPT_DEALER issues no tax invoice and no tax invoice/receipt.
 *
 * Run: npx tsx lib/billing/business-identity.exempt-dealer.test.ts
 */
import {
  assertDocumentTypeAllowedForBusinessKind,
  BILLING_BUSINESS_KIND_VALUES,
  EXEMPT_DEALER_TAX_INVOICE_MESSAGE,
} from "@/lib/billing/business-identity";
import { ValidationError } from "@/lib/errors";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}`);
  }
}

function refuses(kind: string | null, type: string): boolean {
  try {
    assertDocumentTypeAllowedForBusinessKind(kind, type);
    return false;
  } catch (error) {
    return error instanceof ValidationError && error.message === EXEMPT_DEALER_TAX_INVOICE_MESSAGE;
  }
}

const TYPES = ["TAX_INVOICE", "TAX_INVOICE_RECEIPT", "RECEIPT", "CREDIT_NOTE", "QUOTE"];

ok("EXEMPT_DEALER → TAX_INVOICE refused", refuses("EXEMPT_DEALER", "TAX_INVOICE"));
ok("EXEMPT_DEALER → TAX_INVOICE_RECEIPT refused", refuses("EXEMPT_DEALER", "TAX_INVOICE_RECEIPT"));
ok("EXEMPT_DEALER (padded) → TAX_INVOICE refused", refuses("  EXEMPT_DEALER ", "TAX_INVOICE"));
ok("EXEMPT_DEALER → RECEIPT allowed", !refuses("EXEMPT_DEALER", "RECEIPT"));
ok("EXEMPT_DEALER → CREDIT_NOTE allowed (corrects an existing tax invoice only)", !refuses("EXEMPT_DEALER", "CREDIT_NOTE"));
ok("EXEMPT_DEALER → QUOTE allowed", !refuses("EXEMPT_DEALER", "QUOTE"));
for (const kind of BILLING_BUSINESS_KIND_VALUES.filter((k) => k !== "EXEMPT_DEALER")) {
  ok(`${kind} → every document type allowed`, TYPES.every((t) => !refuses(kind, t)));
}
// Unknown / missing kind: issuance is already refused by the identity check
// (kind is required); this rule adds nothing there and must not throw itself.
ok("missing kind → this rule does not throw", TYPES.every((t) => !refuses(null, t)));
ok("unknown kind → this rule does not throw", TYPES.every((t) => !refuses("SOMETHING", t)));

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
