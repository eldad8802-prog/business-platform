/**
 * R4 — a quote is not a forgotten invoice. DB integration proof.
 *
 * `loadBillingStaleDrafts` feeds the "טיוטת חשבונית שלא הונפקה" attention item. A quote is never
 * issued (billing-issue.service refuses QUOTE), so before the fix every quote older than
 * BS_STALE_AFTER_DAYS surfaced as an unissued invoice draft. This drives real rows through the
 * real loader inside a real tenant transaction:
 *
 *   - a 20-day-old DRAFT quote does NOT appear;
 *   - a 20-day-old DRAFT tax invoice still appears;
 *   - a fresh (1-day-old) DRAFT tax invoice does not (the age cutoff is unchanged);
 *   - the result is still capped at BS_BILLING_STALE_DRAFT_CAP, and quotes do not use up the cap;
 *   - another business's draft never appears.
 *
 * Requires env: DATABASE_URL / DIRECT_URL pointing at a THROWAWAY database at the current schema.
 * Writes no production data.
 *
 * Run: npx tsx lib/business-status/stale-drafts.integration.test.ts
 */
import { BillingDocumentStatus, BillingDocumentType } from "@prisma/client";

import { prisma } from "../prisma";
import { runWithTenantContext } from "../tenant/context";
import { BS_BILLING_STALE_DRAFT_CAP } from "./limits";
import { loadBillingStaleDrafts } from "./loaders";

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

const NOW = new Date("2026-10-12T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

async function draft(businessId: number, documentType: BillingDocumentType, createdAt: Date) {
  return prisma.billingDocument.create({
    data: { businessId, documentType, status: BillingDocumentStatus.DRAFT, createdAt },
    select: { id: true },
  });
}

const staleIds = (businessId: number) =>
  runWithTenantContext({ businessId }, () => loadBillingStaleDrafts(businessId, NOW)).then((rows) =>
    rows.map((r) => r.id),
  );

async function main() {
  const a = await prisma.business.create({ data: { name: "r4-stale-drafts-A" } });
  const b = await prisma.business.create({ data: { name: "r4-stale-drafts-B" } });

  const quote = await draft(a.id, BillingDocumentType.QUOTE, daysAgo(20));
  const invoice = await draft(a.id, BillingDocumentType.TAX_INVOICE, daysAgo(20));
  const fresh = await draft(a.id, BillingDocumentType.TAX_INVOICE, daysAgo(1));
  const other = await draft(b.id, BillingDocumentType.TAX_INVOICE, daysAgo(20));

  const ids = await staleIds(a.id);
  check("a 20-day-old DRAFT quote is not a stale invoice draft", !ids.includes(quote.id));
  check("a 20-day-old DRAFT tax invoice is still a stale draft", ids.includes(invoice.id));
  check("a 1-day-old DRAFT tax invoice is not stale (age cutoff unchanged)", !ids.includes(fresh.id));
  check("another business's draft never appears", !ids.includes(other.id));

  // The cap still applies, and old quotes (sorted first by createdAt) do not consume it.
  for (let i = 0; i < BS_BILLING_STALE_DRAFT_CAP; i++) await draft(a.id, BillingDocumentType.QUOTE, daysAgo(40 + i));
  for (let i = 0; i < BS_BILLING_STALE_DRAFT_CAP + 2; i++) await draft(a.id, BillingDocumentType.TAX_INVOICE, daysAgo(30 + i));
  const capped = await staleIds(a.id);
  check(
    `the result is capped at ${BS_BILLING_STALE_DRAFT_CAP}`,
    capped.length === BS_BILLING_STALE_DRAFT_CAP,
    `got ${capped.length}`,
  );
  const quoteIds = new Set(
    (await prisma.billingDocument.findMany({
      where: { businessId: a.id, documentType: BillingDocumentType.QUOTE },
      select: { id: true },
    })).map((r) => r.id),
  );
  check("older quotes do not use up the cap", capped.every((id) => !quoteIds.has(id)));

  console.log(failures === 0 ? "\nR4 stale drafts: all contracts hold." : `\n${failures} FAILED`);
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
