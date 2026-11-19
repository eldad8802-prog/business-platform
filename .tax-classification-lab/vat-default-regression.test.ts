/**
 * #1111 regression proof — the new-line VAT default changes NOTHING but the default.
 *
 * Owner-approved focused A0 exception: a NEW draft line on the document screen defaults to 0% for an exempt dealer and
 * to the dated standard rate otherwise. This file proves the boundaries of that change (no product behaviour here):
 *
 *   R1  the business kind the screen uses comes from a server-verified source — GET /api/billing/invoice-profile reads
 *       the business from the authenticated session (getCurrentUser → user.businessId), never from the request;
 *   R2  an exempt dealer is still refused TAX_INVOICE / TAX_INVOICE_RECEIPT server-side at issuance, before any number;
 *   R3  issued documents are untouched: no server / issuance / PDF / export module imports the client view model;
 *   R4  (in document-view-model.vat-default.test.ts + U6) a saved rate is never overwritten;
 *   R6  the server does not take the client default as a rule: it accepts any 0..100 rate a caller saves, and at issue it
 *       recomputes from the STORED line rates — the default is only what a fresh input box shows.
 *
 *   npx tsx .tax-classification-lab/vat-default-regression.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import {
  assertDocumentTypeAllowedForBusinessKind,
  BILLING_BUSINESS_KIND_VALUES,
  EXEMPT_DEALER_TAX_INVOICE_MESSAGE,
} from "@/lib/billing/business-identity";
import { validateAndParseLineInput } from "@/lib/services/billing/validation/billing-line.validation";
import { recomputeAll } from "@/lib/services/billing/totals/billing-totals.service";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) {
    console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : "");
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK:", name);
}
const read = (p: string) => readFileSync(p, "utf8");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : [p];
  });
/** The body of `export async function <name>(` up to the next top-level `export `. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

// ─── R1 · the kind is read for the SESSION's business ─────────────────────────────────────────────────────────────
{
  const route = read("app/api/billing/invoice-profile/route.ts");
  const get = fnBody(route, "GET");
  ok("R1 invoice-profile route exports GET", get.length > 0);
  ok("R1 GET authenticates the caller (getCurrentUser(req)) and answers 401 without a user",
    get.includes("await getCurrentUser(req)") && /if \(!user\)[\s\S]{0,80}status: 401/.test(get));
  ok("R1 GET loads the profile of user.businessId — the session's business",
    get.includes("loadBillingInvoiceProfile(user.businessId)"));
  ok("R1 GET reads nothing else from the request (no query, body, params or headers)",
    !/searchParams|nextUrl|req\.json|req\.headers|params|req\.url|businessId\s*[:=]\s*(?!user)/.test(get.replace("getCurrentUser(req)", "")), get);

  const svc = read("lib/services/billing/billing-invoice-profile.service.ts");
  const load = svc.slice(svc.indexOf("export async function loadBillingInvoiceProfile("));
  ok("R1 loadBillingInvoiceProfile reads inside the business's tenant transaction (RLS) for that businessId only",
    /billingTenantTx\(businessId,[\s\S]{0,120}businessProfile\.findUnique\(\{\s*where: \{ businessId \}/.test(load));
  ok("R1 the profile select includes billingBusinessKind (the field the screen reads)",
    /BILLING_INVOICE_PROFILE_SELECT[\s\S]{0,800}billingBusinessKind: true/.test(svc));

  const auth = read("lib/auth.ts");
  ok("R1 getCurrentUser = the user row loaded by the VERIFIED token's userId (not a client-supplied id)",
    /verifyAuthTokenPayload\(token\)/.test(auth) && /user\.findUnique\(\{\s*where: \{ id: verified\.userId \}/.test(auth));

  const page = read("app/billing/[id]/page.tsx");
  ok("R1 the screen calls that GET with the signed-in bearer token, and passes no business id",
    /fetch\("\/api\/billing\/invoice-profile", \{\s*headers: \{ Authorization: `Bearer \$\{getAuthToken\(\)\}` \}/.test(page) &&
      !/invoice-profile\?/.test(page));
}

// ─── R2 · an exempt dealer still cannot issue a tax invoice ───────────────────────────────────────────────────────
{
  const refuses = (kind: string | null, type: string): boolean => {
    try {
      assertDocumentTypeAllowedForBusinessKind(kind, type);
      return false;
    } catch (e) {
      return e instanceof Error && e.message === EXEMPT_DEALER_TAX_INVOICE_MESSAGE;
    }
  };
  ok("R2 EXEMPT_DEALER → TAX_INVOICE refused", refuses("EXEMPT_DEALER", "TAX_INVOICE"));
  ok("R2 EXEMPT_DEALER → TAX_INVOICE_RECEIPT refused", refuses("EXEMPT_DEALER", "TAX_INVOICE_RECEIPT"));
  ok("R2 EXEMPT_DEALER → RECEIPT allowed", !refuses("EXEMPT_DEALER", "RECEIPT"));
  for (const k of BILLING_BUSINESS_KIND_VALUES.filter((x) => x !== "EXEMPT_DEALER")) {
    ok(`R2 ${k} → TAX_INVOICE allowed`, !refuses(k, "TAX_INVOICE"));
  }

  const issue = read("lib/services/billing/billing-issue.service.ts");
  const callAt = issue.indexOf("assertDocumentTypeAllowedForBusinessKind(\n");
  const loadAt = issue.indexOf("tx.business.findUnique({\n    where: { id: input.businessId }");
  const numberAt = issue.indexOf("billingDocumentNumberSequence.upsert(");
  ok("R2 issuance imports the rule", /import \{[^}]*assertDocumentTypeAllowedForBusinessKind[^}]*\} from "@\/lib\/billing\/business-identity"/.test(issue));
  ok("R2 issuance loads the kind from the DB for input.businessId", loadAt > 0 && /billingBusinessKind: true/.test(issue.slice(loadAt, loadAt + 600)));
  ok("R2 issuance calls the rule with that DB value (business.profile?.billingBusinessKind, doc.documentType)",
    callAt > loadAt && /assertDocumentTypeAllowedForBusinessKind\(\s*business\.profile\?\.billingBusinessKind,\s*doc\.documentType\s*\)/.test(issue));
  ok("R2 the rule runs BEFORE a document number is allocated", callAt > 0 && numberAt > callAt, { callAt, numberAt });

  const issueRoute = read("app/api/billing/documents/[id]/issue/route.ts");
  ok("R2 the issue route takes businessId from the session user", issueRoute.includes("getCurrentUser(req)") && issueRoute.includes("businessId: user.businessId"));
  ok("R2 the client default is not consulted by issuance (no businessKind from the request)", !/body\.businessKind|billingBusinessKind/.test(issueRoute));
}

// ─── R3 · issued documents never pass through the client view model ───────────────────────────────────────────────
{
  const serverRoots = ["lib/services", "app/api", "lib/pdf", "lib/accountant", "lib/revenue-truth", "lib/reports"].filter((d) => {
    try { return statSync(d).isDirectory(); } catch { return false; }
  });
  const offenders = serverRoots.flatMap(walk)
    .filter((f) => /\.(ts|tsx|mts)$/.test(f) && !/\.test\./.test(f))
    .filter((f) => /billing\/document-view-model|standardVatRatePercent|newEmptyLocalLine/.test(read(f)));
  ok(`R3 no server / issuance / PDF / export / accountant module references the draft view model or its default (${serverRoots.join(", ")})`,
    offenders.length === 0, offenders);

  const issue = read("lib/services/billing/billing-issue.service.ts");
  ok("R3 the frozen snapshot carries each line's STORED rate (formatPercent(line.vatRatePercent))", issue.includes("vatRatePercent: formatPercent(line.vatRatePercent)"));
}

// ─── R6 · the server's own VAT rules (what it does today) ─────────────────────────────────────────────────────────
{
  const line = (vat: string) => ({ description: "x", quantity: "1", unitPrice: "100", vatRatePercent: vat });
  const accepts = (vat: string) => {
    try { validateAndParseLineInput(line(vat), 1); return true; } catch { return false; }
  };
  // Characterization, not endorsement: the server bounds the rate to 0..100 and does not tie it to a date or a kind.
  ok("R6 save accepts 17 (an older rate) regardless of today's date", accepts("17"));
  ok("R6 save accepts 18", accepts("18"));
  ok("R6 save accepts 0 (any kind)", accepts("0"));
  ok("R6 save rejects 101 and -1 (the only server bounds)", !accepts("101") && !accepts("-1"));

  const { lines, totals } = recomputeAll([validateAndParseLineInput(line("17"), 1), validateAndParseLineInput(line("18"), 2)]);
  ok("R6 totals are computed from each line's own rate (17 → 17.00, 18 → 18.00)",
    lines[0].vatAmount.equals(new Prisma.Decimal("17.00")) && lines[1].vatAmount.equals(new Prisma.Decimal("18.00")) && totals.vatAmount.equals(new Prisma.Decimal("35.00")));

  const draft = read("lib/services/billing/billing-draft.service.ts");
  ok("R6 a lines save stores the rate the caller sent (raw.vatRatePercent → validateAndParseLineInput)",
    /validateAndParseLineInput\(\s*\{[\s\S]{0,200}vatRatePercent: raw\.vatRatePercent/.test(draft));
  const issue = read("lib/services/billing/billing-issue.service.ts");
  ok("R6 issuance recomputes from the STORED lines (recomputeAll(doc.lines.map … vatRatePercent: line.vatRatePercent))",
    /recomputeAll\(\s*doc\.lines\.map\(\(line\) => \(\{[\s\S]{0,200}vatRatePercent: line\.vatRatePercent/.test(issue));
  ok("R6 issuance has no date-based rate table of its own (no 17/18 constant) — the default is client-only",
    !/standardVatRate|VAT_RATES|"18"|"17"/.test(issue));
}

console.log(failed === 0 ? `\nALL PASS (${passed} passed)` : `\n${failed} FAILED, ${passed} passed`);
process.exit(failed === 0 ? 0 : 1);
