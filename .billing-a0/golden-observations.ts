/**
 * A0 — every observable output of the existing billing documents that can be
 * computed WITHOUT a database, a network or a clock, as a flat map
 * name → string.
 *
 * Used by two callers only:
 *   - golden.test.ts compares each value to the recorded baseline (never writes);
 *   - record-baseline.mts writes the baseline, once, from unmodified code.
 *
 * Byte-exact by construction: every value is either canonical JSON, exact text,
 * or the sha256 of exact bytes.
 */
import {
  BillingAuthorityDecisionType,
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  Prisma,
} from "@prisma/client";
import { hashIssuedSnapshot } from "../lib/services/billing/billing-issue.service";
import { formatQuoteDocumentNumber } from "../lib/services/billing/quote-document-number";
import { buildBillingInvoiceHtml } from "../lib/services/billing/pdf/billing-pdf-html-template";
import {
  BILLING_PDF_TEMPLATE_VERSION,
  buildDocDefinition,
  type BillingIssuedSnapshotV1,
} from "../lib/services/billing/pdf/billing-pdf-template";
import {
  AUTHORITY_ALLOCATION_REQUIREMENT,
  AUTHORITY_ELIGIBLE_DOCUMENT_TYPES,
} from "../lib/services/billing/authority/billing-authority.types";
import {
  APPROVAL_DOCUMENT_TYPE_CODE,
  buildInvoiceApprovalPayload,
} from "../lib/services/billing/authority/billing-authority-approval-payload";
import { getAuthorityAllocationThresholdIls } from "../lib/services/billing/authority/billing-authority-threshold";
import { evaluateAuthorityReadinessAtIssue } from "../lib/services/billing/authority/billing-authority-readiness";
import { evaluateAuthorityDeliverability } from "../lib/services/billing/authority/billing-authority-delivery.rules";
import { deriveAllocationNumber } from "../lib/services/billing/billing-allocation-number";
import { documentTypeToCode, buildUniformExportFiles } from "../lib/services/billing/uniform/uniform-file-builder";
import { loadUniformExportInput } from "../lib/services/billing/uniform/uniform-export-loader";
import { assembleUniformExportProjection } from "../lib/services/billing/uniform/uniform-export-assembler";
import { DUBIZ_SOFTWARE_CONFIG } from "../lib/services/billing/uniform/uniform-config";
import {
  buildReport26Data,
  buildReport54Data,
  buildSummaryData,
} from "../lib/services/billing/uniform/uniform-report-data";
import {
  BUSINESS_ID,
  CUSTOMER,
  FONT_SENTINEL,
  ISSUED_AT,
  businessFor,
  buildCases,
  canonicalJson,
  computedLines,
  documentRow,
  GOODS_LINES,
  CREDIT_LINES,
  LARGE_LINES,
  sha256,
  withAllocationNumber,
  type Case,
} from "./fixtures";

const D = (v: string | number) => new Prisma.Decimal(v);
const ALL_TYPES = Object.values(BillingDocumentType);

function caught(fn: () => unknown): string {
  try {
    return canonicalJson({ ok: true, value: fn() });
  } catch (e) {
    return canonicalJson({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function asV1(c: Case): BillingIssuedSnapshotV1 {
  return c.snapshot as unknown as BillingIssuedSnapshotV1;
}

export type Observations = Record<string, string>;

export function snapshotObservations(cases: Case[]): Observations {
  const out: Observations = {};
  for (const c of cases) {
    out[`snapshot.${c.key}.json`] = canonicalJson(c.snapshot);
    if (c.legal) {
      out[`snapshot.${c.key}.legalHash`] = hashIssuedSnapshot(
        c.snapshot as Parameters<typeof hashIssuedSnapshot>[0]
      );
    }
  }
  return out;
}

export function numberingObservations(): Observations {
  return {
    "numbering.quoteFormat": canonicalJson([1, 42, 999999, 1000000].map((n) => formatQuoteDocumentNumber(n))),
  };
}

export function pdfObservations(cases: Case[]): Observations {
  const out: Observations = { "pdf.templateVersion": BILLING_PDF_TEMPLATE_VERSION };
  const withAlloc = cases
    .filter((c) => c.key === "TAX_INVOICE.large")
    .map((c) => ({ ...c, key: `${c.key}+allocation`, snapshot: withAllocationNumber(asV1(c), "123456789") }));
  for (const c of [...cases, ...withAlloc]) {
    const html = buildBillingInvoiceHtml(asV1(c), FONT_SENTINEL);
    out[`pdf.html.${c.key}.sha256`] = sha256(html);
    out[`pdf.html.${c.key}.length`] = String(html.length);
    out[`pdf.docdef.${c.key}.sha256`] = sha256(canonicalJson(buildDocDefinition(asV1(c))));
  }
  return out;
}

const THRESHOLD_DATES = [
  "2024-12-31T21:59:59.999Z",
  "2024-12-31T22:00:00.000Z",
  "2025-12-31T21:59:59.999Z",
  "2025-12-31T22:00:00.000Z",
  "2026-05-31T20:59:59.999Z",
  "2026-05-31T21:00:00.000Z",
  "2027-03-01T10:00:00.000Z",
];

export function authorityObservations(cases: Case[]): Observations {
  const out: Observations = {};
  out["authority.allocationRequirement"] = canonicalJson(AUTHORITY_ALLOCATION_REQUIREMENT);
  out["authority.eligibleTypes"] = canonicalJson(AUTHORITY_ELIGIBLE_DOCUMENT_TYPES);
  out["authority.approvalTypeCode"] = canonicalJson(APPROVAL_DOCUMENT_TYPE_CODE);
  out["authority.thresholdByDate"] = canonicalJson(
    THRESHOLD_DATES.map((d) => [d, getAuthorityAllocationThresholdIls(new Date(d))])
  );

  const readiness: unknown[] = [];
  for (const documentType of ALL_TYPES) {
    for (const subtotal of ["4999.99", "5000.00", "12500.00"]) {
      for (const vat of ["0", "900.00"]) {
        for (const currency of ["ILS", "USD"]) {
          for (const [taxIdType, taxId] of [
            [CustomerTaxIdType.AUTHORIZED_DEALER, "000000018"],
            [CustomerTaxIdType.LTD_COMPANY, "514000000"],
            [CustomerTaxIdType.EXEMPT_DEALER, "000000018"],
            [CustomerTaxIdType.PRIVATE_ID, "000000018"],
            [CustomerTaxIdType.AUTHORIZED_DEALER, ""],
          ] as const) {
            readiness.push([
              documentType,
              subtotal,
              vat,
              currency,
              taxIdType,
              taxId,
              evaluateAuthorityReadinessAtIssue({
                documentType,
                invoiceDate: ISSUED_AT,
                vatAmount: D(vat),
                subtotalAmount: D(subtotal),
                currency,
                customerTaxIdType: taxIdType,
                customerTaxId: taxId,
              }),
            ]);
          }
        }
      }
    }
  }
  out["authority.readinessMatrix.sha256"] = sha256(canonicalJson(readiness));
  out["authority.readinessMatrix.readyCount"] = String(readiness.filter((r) => (r as unknown[])[6] === "READY").length);

  for (const c of cases.filter((x) => x.legal)) {
    out[`authority.approvalPayload.${c.key}`] = caught(() =>
      buildInvoiceApprovalPayload({
        snapshot: asV1(c),
        customerTaxId: CUSTOMER.taxId,
        accountingSoftwareNumber: "270901",
        operatorUserName: "77",
      })
    );
  }

  out["authority.allocationNumber"] = canonicalJson(
    [null, "", "12345678", "123456789", "0001234567890", "12345678a", " 987654321 "].map((v) => [
      v,
      deriveAllocationNumber(v as string | null),
    ])
  );

  const deliverability: unknown[] = [];
  const statuses = [null, ...Object.values(BillingAuthoritySubmissionStatus)];
  const decisions = [null, ...Object.values(BillingAuthorityDecisionType)];
  for (const documentType of ALL_TYPES) {
    for (const submissionStatus of statuses) {
      for (const heldDecisionType of decisions) {
        for (const reported of [false, true]) {
          for (const alloc of [null, "123456789"]) {
            deliverability.push([
              documentType,
              submissionStatus,
              heldDecisionType,
              reported,
              alloc,
              evaluateAuthorityDeliverability({
                documentType,
                submissionStatus,
                heldDecisionType,
                heldDecisionReportedAt: reported ? ISSUED_AT : null,
                documentAllocationNumber: alloc,
              }),
            ]);
          }
        }
      }
    }
  }
  out["authority.deliverabilityMatrix.sha256"] = sha256(canonicalJson(deliverability));
  out["authority.deliverabilityMatrix.deliverableCount"] = String(
    deliverability.filter((r) => ((r as unknown[])[5] as { deliverable: boolean }).deliverable).length
  );
  return out;
}

// ---------------------------------------------------------------------------
// מבנה אחיד — loader (fake read client) → assembler → file builder
// ---------------------------------------------------------------------------

function uniformRows(cases: Case[]) {
  const linesFor: Record<string, Parameters<typeof computedLines>[1]> = {
    "TAX_INVOICE.classic": GOODS_LINES,
    "TAX_INVOICE.large": LARGE_LINES,
    "TAX_INVOICE_RECEIPT.classic": GOODS_LINES,
    "CREDIT_NOTE.classic": CREDIT_LINES,
  };
  const rows: Record<string, unknown>[] = [];
  const pick = ["TAX_INVOICE.classic", "TAX_INVOICE.large", "TAX_INVOICE_RECEIPT.classic", "RECEIPT.classic", "CREDIT_NOTE.classic"];
  for (const key of pick) {
    const c = cases.find((x) => x.key === key)!;
    const snap = c.snapshot as { document: { id: number; number: number; numberFormatted: string; referenceDocumentId: number | null }; totals: { subtotal: string; vat: string; total: string } };
    const id = snap.document.id;
    const lines = linesFor[key] ? computedLines(id, linesFor[key]).rows : [];
    const isReceiptLike = c.type === BillingDocumentType.RECEIPT || c.type === BillingDocumentType.TAX_INVOICE_RECEIPT;
    rows.push({
      ...documentRow({
        id,
        documentType: c.type,
        status: BillingDocumentStatus.ISSUED,
        documentNumber: snap.document.number,
        documentNumberFormatted: snap.document.numberFormatted,
        issuedAt: ISSUED_AT,
        lockedAt: ISSUED_AT,
        subtotalAmount: D(snap.totals.subtotal),
        vatAmount: D(snap.totals.vat),
        totalAmount: D(snap.totals.total),
        referenceDocumentId: snap.document.referenceDocumentId,
        legalSnapshotHash: hashIssuedSnapshot(c.snapshot as Parameters<typeof hashIssuedSnapshot>[0]),
        issuedSnapshot: c.snapshot as unknown as Prisma.JsonValue,
      }),
      lines,
      receiptPayments: isReceiptLike
        ? [
            {
              lineIndex: 1,
              method: "BANK_TRANSFER",
              amount: D(snap.totals.total),
              currency: "ILS",
              paymentDate: ISSUED_AT,
              bankName: "99",
              bankBranch: "999",
              bankAccountNumber: "123456",
              checkNumber: null,
              checkDueDate: null,
              cardBrand: null,
              cardLast4: null,
              reference: "A0-REF",
            },
          ]
        : [],
      customer: {
        id: CUSTOMER.id,
        name: CUSTOMER.name,
        legalName: null,
        taxId: CUSTOMER.taxId,
        taxIdType: "LTD_COMPANY",
        city: CUSTOMER.city,
        phone: CUSTOMER.phone,
        email: CUSTOMER.email,
      },
    });
  }
  // Rows the database filter would normally keep out — the assembler must still exclude them.
  rows.push({ ...documentRow({ id: 9101, documentType: BillingDocumentType.QUOTE, status: BillingDocumentStatus.DRAFT }), lines: [], receiptPayments: [], customer: null });
  rows.push({ ...documentRow({ id: 9102, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.DRAFT }), lines: [], receiptPayments: [], customer: null });
  return rows;
}

export async function uniformObservations(cases: Case[]): Promise<Observations> {
  const out: Observations = {};
  out["uniform.documentTypeToCode"] = canonicalJson(ALL_TYPES.map((t) => [t, caught(() => documentTypeToCode(t))]));

  const queries: unknown[] = [];
  const profile = businessFor("CLASSIC").profile;
  const client = {
    business: {
      findUnique: async (args: unknown) => {
        queries.push({ business: args });
        return { name: "A0 Synthetic Business", profile };
      },
    },
    billingDocument: {
      findMany: async (args: unknown) => {
        queries.push({ billingDocument: args });
        return uniformRows(cases);
      },
    },
  };
  const input = await loadUniformExportInput({
    businessId: BUSINESS_ID,
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-07-31T23:59:59.999Z",
    client,
  });
  out["uniform.loaderQueries"] = canonicalJson(queries);
  out["uniform.loaderInput.sha256"] = sha256(canonicalJson(input));

  const proj = assembleUniformExportProjection(input);
  out["uniform.projection.excluded"] = canonicalJson(proj.excluded ?? null);
  out["uniform.projection.warnings"] = canonicalJson(proj.warnings ?? null);
  out["uniform.projection.sha256"] = sha256(canonicalJson(proj));

  const built = buildUniformExportFiles(proj, DUBIZ_SOFTWARE_CONFIG, {
    primaryId: "123456789012345",
    generatedAt: "2026-08-01T07:15:00.000Z",
  });
  out["uniform.ini.bytes.sha256"] = sha256(built.iniBuffer);
  out["uniform.bkmvdata.bytes.sha256"] = sha256(built.bkmvdataBuffer);
  out["uniform.ini.text.sha256"] = sha256(built.iniText);
  out["uniform.bkmvdata.text.sha256"] = sha256(built.bkmvdataText);
  out["uniform.meta"] = canonicalJson(built.meta);
  out["uniform.report26"] = canonicalJson(buildReport26Data(proj, built.meta));
  out["uniform.report54.sha256"] = sha256(canonicalJson(buildReport54Data(proj, built.meta, DUBIZ_SOFTWARE_CONFIG)));
  out["uniform.summary.sha256"] = sha256(canonicalJson(buildSummaryData(proj, built.meta, DUBIZ_SOFTWARE_CONFIG)));
  return out;
}

export async function computeObservations(): Promise<Observations> {
  const cases = buildCases();
  return {
    ...snapshotObservations(cases),
    ...numberingObservations(),
    ...pdfObservations(cases),
    ...authorityObservations(cases),
    ...(await uniformObservations(cases)),
  };
}
