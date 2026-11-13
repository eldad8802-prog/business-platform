/**
 * The frozen pre-#1108 template (receipt-v1) and the restore verification — pure, no database, no browser.
 *
 *   npx tsx lib/services/billing/pdf/receipt-template-v1.fidelity.test.ts
 *
 * F1  the frozen file is byte-identical to the template on main before #1108 (sha256 pinned; last changed in #225)
 * F2  it reproduces EVERY recorded A0 golden HTML observation (pdf.html.*.sha256 / .length) — the exact HTML main
 *     produced — so a receipt restored with it is the original template, not today's
 * V1  version → template mapping: only the two recorded versions are reproducible; anything else is not
 * V2  window match: the right CreationDate/ModDate second reproduces the recorded hash; a wrong window, a content
 *     change, or a single altered byte never does (no "close enough")
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildCases, FONT_SENTINEL, withAllocationNumber } from "../../../../.billing-a0/fixtures";
import { buildBillingInvoiceHtml as buildV1 } from "@/lib/services/billing/pdf/billing-pdf-html-template.receipt-v1";
import type { BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import {
  RECEIPT_CURRENT_HTML_TEMPLATE_VERSION,
  RECEIPT_V1_HTML_TEMPLATE_VERSION,
  receiptHtmlTemplateForVersion,
} from "@/lib/services/billing/pdf/receipt-template-version";
import { matchRenderedAtWindow } from "@/lib/services/billing/receipt-pdf-restore.service";

let failed = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) { console.error("FAIL:", name, got !== undefined ? `(got: ${JSON.stringify(got)})` : ""); failed += 1; return; }
  console.log("OK:", name);
}
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

// F1
const FROZEN_SHA256 = "070b84ad60e0f937cea7aefb5946d07570aa4dc7715accddf7e93f909d0de121";
const frozen = readFileSync(path.join("lib/services/billing/pdf/billing-pdf-html-template.receipt-v1.ts"));
ok("F1 receipt-v1 is byte-identical to the pre-#1108 template (origin/main, #225)", sha(frozen) === FROZEN_SHA256, sha(frozen));

// F2 — the same computation as .billing-a0/golden-observations.ts (FONT_SENTINEL, asV1, + allocation variants)
const golden = JSON.parse(readFileSync(".billing-a0/baseline/golden.json", "utf8")).observations as Record<string, string>;
const sentinel = FONT_SENTINEL;
const cases = buildCases();
const withAlloc = cases.filter((c) => c.key === "TAX_INVOICE.large")
  .map((c) => ({ ...c, key: `${c.key}+allocation`, snapshot: withAllocationNumber(c.snapshot as never, "123456789") }));
let compared = 0;
const mismatches: string[] = [];
for (const c of [...cases, ...withAlloc]) {
  const k = `pdf.html.${c.key}.sha256`;
  if (!(k in golden)) continue;
  const html = buildV1(c.snapshot as unknown as BillingIssuedSnapshotV1, sentinel);
  compared += 1;
  if (sha(html) !== golden[k] || String(html.length) !== golden[`pdf.html.${c.key}.length`]) mismatches.push(c.key);
}
ok(`F2 receipt-v1 reproduces every recorded golden HTML observation (${compared} cases, RECEIPT included)`,
  compared >= 10 && mismatches.length === 0, { compared, mismatches });
ok("F2 the recorded receipts are among them", "pdf.html.RECEIPT.classic.sha256" in golden && "pdf.html.RECEIPT.unapplied.sha256" in golden);

// V1
ok("V1 'billing-v1-html' → receipt-v1", receiptHtmlTemplateForVersion(RECEIPT_V1_HTML_TEMPLATE_VERSION) === "receipt-v1");
ok("V1 the #1108 receipt version → current", receiptHtmlTemplateForVersion(RECEIPT_CURRENT_HTML_TEMPLATE_VERSION) === "current");
ok("V1 pdfmake / unknown / missing → not reproducible",
  [`billing-v1-pdfmake`, "billing-v0-html", null, ""].every((v) => receiptHtmlTemplateForVersion(v) === null));

// V2
const pdfWith = (stamp: string, body = "BT (קבלה 000007) Tj ET") =>
  Buffer.from(`%PDF-1.4\n1 0 obj\n<</Creator (Chromium) /Producer (Skia/PDF m147) /CreationDate (${stamp}) /ModDate (${stamp})>>\nendobj\n${body}\n%%EOF\n`, "latin1");
const renderedAt = new Date("2026-07-15T09:31:00.000Z");
const original = pdfWith("D:20260715093012+00'00'"); // produced 48 s before pdfRenderedAt
const want = sha(original);
const fresh = pdfWith("D:20261112020325+00'00'"); // today's re-render: same content, new dates
const m = matchRenderedAtWindow(fresh, renderedAt, want);
ok("V2 the window finds the original second and reproduces the exact bytes", !!m && m.equals(original) && sha(m) === want);
ok("V2 outside the window → no match (never stretched)", matchRenderedAtWindow(fresh, renderedAt, want, 10, 0) === null);
ok("V2 a content change → no match", matchRenderedAtWindow(pdfWith("D:20261112020325+00'00'", "BT (RECEIPT 000007) Tj ET"), renderedAt, want) === null);
const oneByte = Buffer.from(fresh); oneByte[oneByte.length - 8] ^= 1;
ok("V2 a single altered byte → no match", matchRenderedAtWindow(oneByte, renderedAt, want) === null);
ok("V2 no dates in the candidate → only an exact hash counts", matchRenderedAtWindow(Buffer.from("x"), renderedAt, want) === null);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
if (failed) process.exit(1);
