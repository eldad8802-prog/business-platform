/**
 * Controlled restore of ONE issued receipt's PDF — owner-run only, never automatic (owner decision 2026-11-12).
 *
 *   npx tsx scripts/ops/restore-receipt-pdf.ts --business <id> --document <id> --actor <ownerUserId>            (dry run)
 *   npx tsx scripts/ops/restore-receipt-pdf.ts --business <id> --document <id> --actor <ownerUserId> --apply    (writes)
 *
 * It puts back ONLY bytes that hash to the pdfHash recorded when the receipt's PDF was produced (from a sealed
 * accountant package, or a re-render with the recorded template that reproduces the exact bytes), under the recorded
 * storage key, and records BILLING_PDF_RESTORED. It never creates a new copy, never changes the document row, and
 * writes nothing when it cannot verify. See lib/services/billing/receipt-pdf-restore.service.ts.
 *
 * A re-render only matches when it runs on the same renderer build and fonts that produced the original (the
 * serverless Chromium of the deployment) — run it where that holds, or rely on a sealed package.
 */
import { restoreIssuedReceiptPdf } from "@/lib/services/billing/receipt-pdf-restore.service";

function arg(name: string): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  if (!Number.isInteger(v) || v <= 0) {
    console.error(`missing or invalid --${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const result = await restoreIssuedReceiptPdf({
    businessId: arg("business"),
    billingDocumentId: arg("document"),
    actorUserId: arg("actor"),
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.verdict === "NOT_VERIFIED" ? 3 : 0;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
