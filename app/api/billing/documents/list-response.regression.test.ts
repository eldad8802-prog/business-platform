/**
 * M-3 response-boundary regression test.
 *
 * Proves — at the response shape, not by inspecting the select literal — that
 * the billing documents LIST response no longer egresses `pdfStorageKey`, that
 * `pdfHash` is intentionally retained (scope guard), and that the other central
 * fields are preserved.
 *
 *   npx tsx app/api/billing/documents/list-response.regression.test.ts
 */
import assert from "node:assert/strict";
import { LIST_SELECT } from "./route";

// A full BillingDocument row as it exists in the DB (all scalar fields),
// including the internal pdfStorageKey and the retained pdfHash.
const FULL_DB_ROW: Record<string, unknown> = {
  id: 1,
  businessId: 42,
  documentType: "TAX_INVOICE",
  status: "ISSUED",
  documentNumber: "2026-000123",
  documentNumberFormatted: "INV 2026-000123",
  customerId: 7,
  customerNameSnapshot: "Acme",
  subtotalAmount: "100.00",
  vatAmount: "17.00",
  totalAmount: "117.00",
  currency: "ILS",
  issuedAt: new Date("2026-08-01"),
  issuedByUserId: 3,
  createdByUserId: 3,
  convertedToInvoiceId: null,
  pdfRenderStatus: "RENDERED",
  pdfTemplateVersion: "v1",
  pdfStorageKey: "biz/42/billing/1/doc.pdf", // internal R2 object key — must NOT egress
  pdfHash: "sha256:deadbeef", // retained by scope
  pdfRenderedAt: new Date("2026-08-01"),
  pdfRenderError: null,
  createdAt: new Date("2026-08-01"),
  updatedAt: new Date("2026-08-01"),
};

// Faithfully models Prisma `findMany({ select })`: the returned object holds
// exactly the keys whose select value is `true`. This IS the response document.
function projectViaSelect(
  row: Record<string, unknown>,
  select: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, want] of Object.entries(select)) {
    if (want === true && key in row) out[key] = row[key];
  }
  return out;
}

// "Before" state: the underlying row is capable of carrying pdfStorageKey,
// i.e. the path could previously return it.
assert.equal(
  "pdfStorageKey" in FULL_DB_ROW,
  true,
  "precondition: the underlying row carries pdfStorageKey"
);

const responseDocument = projectViaSelect(FULL_DB_ROW, LIST_SELECT);

// Security outcome: pdfStorageKey must NOT egress via the LIST response.
assert.equal(
  "pdfStorageKey" in responseDocument,
  false,
  "REGRESSION: pdfStorageKey must not egress via the billing documents LIST response"
);

// Scope guard: pdfHash is intentionally retained (proves scope was not widened).
assert.equal(
  "pdfHash" in responseDocument,
  true,
  "scope: pdfHash must remain in the LIST response (out of this task's scope)"
);

// Compatibility: central fields (incl. the `id` used by pagination/cursor) preserved.
for (const field of [
  "id",
  "documentNumber",
  "totalAmount",
  "status",
  "issuedAt",
  "createdAt",
]) {
  assert.equal(
    field in responseDocument,
    true,
    `compatibility: ${field} must remain in the LIST response`
  );
}

console.log(
  "OK — M-3 response-boundary: pdfStorageKey absent; pdfHash + central fields present."
);
