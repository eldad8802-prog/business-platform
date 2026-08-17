/**
 * Unit tests for customer taxId freezing in issuedSnapshot (run manually):
 *   npx tsx lib/services/billing/billing-issue-snapshot.test.ts
 *
 * Pure: exercises buildIssuedSnapshot + hashIssuedSnapshot (no DB) and the
 * existing PDF doc-definition builder. Deterministic.
 */
import { BillingDocument, BillingDocumentLine, Prisma } from "@prisma/client";
import {
  buildIssuedSnapshot,
  hashIssuedSnapshot,
} from "@/lib/services/billing/billing-issue.service";
import { buildDocDefinition } from "@/lib/services/billing/pdf/billing-pdf-template";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { buildBillingInvoiceHtml } from "@/lib/services/billing/pdf/billing-pdf-html-template";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

const ISSUED_AT = new Date("2026-06-15T10:00:00.000Z");

function doc(): BillingDocument {
  return {
    id: 42,
    documentType: "TAX_INVOICE",
    status: "ISSUED",
    currency: "ILS",
    referenceDocumentId: null,
    customerNameSnapshot: "לקוח",
  } as unknown as BillingDocument;
}

function lines(): BillingDocumentLine[] {
  return [
    {
      lineIndex: 0,
      description: "שירות",
      quantity: new Prisma.Decimal("1"),
      unitPrice: new Prisma.Decimal("100"),
      vatRatePercent: new Prisma.Decimal("17"),
      lineSubtotal: new Prisma.Decimal("100"),
      vatAmount: new Prisma.Decimal("17"),
      lineTotal: new Prisma.Decimal("117"),
    } as unknown as BillingDocumentLine,
  ];
}

const business = {
  id: 3,
  name: "Dubiz",
  profile: {
    billingLegalName: "דוביז בע\"מ",
    billingBusinessKind: "LTD_COMPANY",
    billingTaxId: "515000123",
    billingVatNumber: "515000123",
    billingPhone: null,
    billingEmail: null,
    billingAddress: null,
    billingPaymentNote: null,
    billingFooterNote: null,
    billingLogoDataUrl: null,
    billingSignatureDataUrl: null,
    billingPdfTemplateStyle: null,
  },
};

// A valid PNG data URL (matches the shared image-data-URL validator).
const SIG_A = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA=";
const SIG_B = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";

function businessWithSignature(sig: string | null) {
  return { ...business, profile: { ...business.profile, billingSignatureDataUrl: sig } };
}

function buildArgsSig(sig: string | null) {
  return { ...buildArgs(customer("514000000")), business: businessWithSignature(sig) };
}

const totals = {
  subtotalAmount: new Prisma.Decimal("100"),
  vatAmount: new Prisma.Decimal("17"),
  totalAmount: new Prisma.Decimal("117"),
};

function customer(taxId: string | null) {
  return { id: 7, name: "לקוח", phone: null, email: null, city: "תל אביב", taxId };
}

function buildArgs(cust: ReturnType<typeof customer> | null) {
  return {
    document: doc(),
    lines: lines(),
    business,
    customer: cust,
    documentNumber: 7,
    documentNumberFormatted: "000007",
    issuedAt: ISSUED_AT,
    actorUserId: 1,
    totals,
  };
}

// ---- 1. customer WITH taxId ----
{
  const snap = buildIssuedSnapshot(buildArgs(customer("514000000")));
  ok("taxId frozen into snapshot", snap.customer.taxId === "514000000");
  const docDef = buildDocDefinition(snap as unknown as BillingIssuedSnapshotV1);
  const json = JSON.stringify(docDef);
  ok("PDF shows customer ע.מ./ת.ז. row + value", json.includes("ע.מ./ת.ז.") && json.includes("514000000"));
}

// ---- 2. customer WITHOUT taxId ----
{
  const snap = buildIssuedSnapshot(buildArgs(customer(null)));
  ok("null taxId → snapshot null", snap.customer.taxId === null);
  const json = JSON.stringify(buildDocDefinition(snap as unknown as BillingIssuedSnapshotV1));
  // Issuer row uses "ע.מ./ח.פ." — the customer-specific label must be absent.
  ok("PDF omits customer ע.מ./ת.ז. row when null", !json.includes("ע.מ./ת.ז."));
}

// ---- 3. no customer at all ----
{
  const snap = buildIssuedSnapshot(buildArgs(null));
  ok("no customer → taxId null (no regression)", snap.customer.taxId === null && snap.customer.id === null);
}

// ---- 4. hash includes taxId + determinism ----
{
  const withTax = buildIssuedSnapshot(buildArgs(customer("514000000")));
  const withTax2 = buildIssuedSnapshot(buildArgs(customer("514000000")));
  const nullTax = buildIssuedSnapshot(buildArgs(customer(null)));
  const otherTax = buildIssuedSnapshot(buildArgs(customer("514999999")));
  ok("hash deterministic (same input → same hash)", hashIssuedSnapshot(withTax) === hashIssuedSnapshot(withTax2));
  ok("hash differs when taxId present vs null", hashIssuedSnapshot(withTax) !== hashIssuedSnapshot(nullTax));
  ok("hash differs when taxId value changes", hashIssuedSnapshot(withTax) !== hashIssuedSnapshot(otherTax));
}

// ---- 5. snapshot value is reflected as-is (no normalize/parse) ----
{
  const raw = "  514000000  ";
  const snap = buildIssuedSnapshot(buildArgs(customer(raw)));
  ok("taxId stored as-is (no normalize/parse)", snap.customer.taxId === raw);
}

// ---- 6. Business graphical signature (Phase 1) ----
{
  // No signature → issuer.signatureUrl null; PDF omits the signature block.
  const noSig = buildIssuedSnapshot(buildArgsSig(null));
  ok("no signature → issuer.signatureUrl null", (noSig.issuer as { signatureUrl?: string | null }).signatureUrl == null);
  const noSigJson = JSON.stringify(buildDocDefinition(noSig as unknown as BillingIssuedSnapshotV1));
  // The image data URL is the definitive marker (labels get NBSP-transformed by rtlLabel).
  ok("PDF omits signature image when none configured", !noSigJson.includes(SIG_A));

  // Signature configured → frozen into snapshot + rendered in PDF.
  const withSig = buildIssuedSnapshot(buildArgsSig(SIG_A));
  ok("signature frozen into issuer.signatureUrl", (withSig.issuer as { signatureUrl?: string | null }).signatureUrl === SIG_A);
  const withSigJson = JSON.stringify(buildDocDefinition(withSig as unknown as BillingIssuedSnapshotV1));
  ok("PDF renders signature image + label when configured", withSigJson.includes(SIG_A) && withSigJson.includes("חתימה"));

  // Freeze semantics: the built snapshot captures the value; a later profile change
  // does not mutate the already-built snapshot (pure function).
  const frozenA = buildIssuedSnapshot(buildArgsSig(SIG_A));
  buildIssuedSnapshot(buildArgsSig(SIG_B)); // "owner changes signature to B"
  ok("previously-built snapshot still holds signature A (frozen)", (frozenA.issuer as { signatureUrl?: string | null }).signatureUrl === SIG_A);

  // A vs B → different snapshots AND different legal hashes.
  const snapA = buildIssuedSnapshot(buildArgsSig(SIG_A));
  const snapB = buildIssuedSnapshot(buildArgsSig(SIG_B));
  ok("hash differs when signature value changes", hashIssuedSnapshot(snapA) !== hashIssuedSnapshot(snapB));
  ok("hash differs signature-present vs none", hashIssuedSnapshot(snapA) !== hashIssuedSnapshot(noSig));

  // Invalid image (SVG is not allowed) → rejected → issuer.signatureUrl null.
  const svg = buildIssuedSnapshot(buildArgsSig("data:image/svg+xml;base64,PHN2Zy8+"));
  ok("invalid signature (SVG) rejected → null", (svg.issuer as { signatureUrl?: string | null }).signatureUrl == null);

  // Backward compatibility: a frozen snapshot without signatureUrl renders no signature (no crash).
  const legacy = { ...(withSig as unknown as Record<string, unknown>) };
  const legacyIssuer = { ...(legacy.issuer as Record<string, unknown>) };
  delete legacyIssuer.signatureUrl;
  legacy.issuer = legacyIssuer;
  const legacyJson = JSON.stringify(buildDocDefinition(legacy as unknown as BillingIssuedSnapshotV1));
  ok("legacy snapshot (no signatureUrl field) renders no signature, no crash", !legacyJson.includes(SIG_A));
}

// ---- 7. HTML renderer backend (second production path) — same behavior ----
{
  const FONT = "data:font/ttf;base64,AA==";
  const withSig = buildIssuedSnapshot(buildArgsSig(SIG_A));
  const noSig = buildIssuedSnapshot(buildArgsSig(null));
  const htmlWith = buildBillingInvoiceHtml(withSig as unknown as BillingIssuedSnapshotV1, FONT);
  const htmlNone = buildBillingInvoiceHtml(noSig as unknown as BillingIssuedSnapshotV1, FONT);
  ok("HTML renderer embeds signature image when configured", htmlWith.includes(SIG_A) && htmlWith.includes("חתימה"));
  ok("HTML renderer omits signature image when none configured", !htmlNone.includes(SIG_A));
}

if (failed > 0) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log("\nAll billing-issue snapshot tests passed.");
