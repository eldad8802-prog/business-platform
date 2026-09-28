/**
 * Daily Business Cost — Production evidence for the QA tenant. SCRIPT-ONLY, READ-ONLY.
 *
 *   npx tsx scripts/payables/business-cost-evidence.ts --dates 2026-09-28,2026-10-05
 *
 * Runs the REAL engine (`deriveBusinessCost`) for the QA tenant only — business
 * 38, `COLLECTION_QA_BUSINESS_ID`, a repository constant, never an input — and
 * prints only what concerns commitments titled `QA-P2…`, plus the day's totals.
 *
 * Read-only is enforced by Postgres, not promised by this code:
 *   - the connection is forced to ONE (`connection_limit=1`), so every query
 *     runs on the same session;
 *   - that session is set to `SET SESSION CHARACTERISTICS AS TRANSACTION READ
 *     ONLY` before the engine runs;
 *   - the script REFUSES unless `default_transaction_read_only` is `on`, and
 *     checks again after the engine has run.
 * Expects DATABASE_URL to be the DIRECT (non-pooled) Production URL: a pooler
 * could hand the session to another client.
 */
import { COLLECTION_QA_BUSINESS_ID } from "@/lib/services/payments/qa-webhook-suppression";

const QA_MARKER = "QA-P2";

function parseDates(argv: string[]): string[] {
  const i = argv.indexOf("--dates");
  const raw = i >= 0 ? argv[i + 1] ?? "" : "";
  const dates = raw.split(",").map((d) => d.trim()).filter(Boolean);
  if (dates.length === 0 || dates.length > 12 || !dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    console.error("--dates must be 1–12 comma-separated YYYY-MM-DD dates");
    process.exit(2);
  }
  return dates;
}

function singleConnection(url: string): string {
  const u = new URL(url);
  u.searchParams.set("connection_limit", "1");
  return u.toString();
}

async function main(): Promise<void> {
  const dates = parseDates(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  process.env.DATABASE_URL = singleConnection(process.env.DATABASE_URL);

  const { prisma } = await import("@/lib/prisma");
  const { deriveBusinessCost, serializeBusinessCostDay } = await import("@/lib/services/business-cost/business-cost.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const readOnly = async () =>
    (await prisma.$queryRawUnsafe<Array<{ default_transaction_read_only: string }>>("SHOW default_transaction_read_only"))[0]
      ?.default_transaction_read_only;

  try {
    await prisma.$executeRawUnsafe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const before = await readOnly();
    if (before !== "on") {
      console.error(`REFUSED: the session is not read-only (default_transaction_read_only=${before})`);
      process.exit(3);
    }
    console.log(`session read-only: ${before} · business ${COLLECTION_QA_BUSINESS_ID} (QA tenant) · marker ${QA_MARKER}`);

    const qa = await tenantTx(COLLECTION_QA_BUSINESS_ID, (tx) =>
      tx.commitment.findMany({
        where: { businessId: COLLECTION_QA_BUSINESS_ID, title: { startsWith: QA_MARKER } },
        select: { id: true },
      }),
    );
    const qaIds = new Set(qa.map((c) => c.id));

    const report = [];
    for (const date of dates) {
      const day = serializeBusinessCostDay(await deriveBusinessCost({ businessId: COLLECTION_QA_BUSINESS_ID, date }));
      const lines = [...day.allocatedCost.lines, ...day.debtService.lines].filter(
        (l) => l.source === "COMMITMENT" && qaIds.has(l.commitmentId),
      );
      const cash = day.cashOut.payments.filter((p) => p.allocations.some((a) => qaIds.has(a.commitmentId)));
      report.push({
        date,
        totals: {
          allocated: day.allocatedCost.total,
          baselineDaily: day.baselineDailyCost.total,
          cashOut: day.cashOut.total,
        },
        qaLines: lines.map((l) => ({
          commitmentId: l.commitmentId,
          installmentId: l.installmentId,
          basis: l.basis,
          period: l.period,
          periodAmount: l.periodAmount,
          allocated: l.allocated,
          baselineDaily: l.baselineDaily,
          explanation: l.explanation,
        })),
        qaUncertainOrExcluded: [
          ...day.uncertain.items.filter((u) => u.source === "COMMITMENT" && qaIds.has(u.commitmentId)),
          ...day.excluded.filter((e) => e.source === "COMMITMENT" && qaIds.has(e.commitmentId)),
        ],
        qaCashOut: cash.map((p) => ({ paymentId: p.paymentId, amount: p.amount, method: p.method, allocations: p.allocations })),
      });
    }

    const after = await readOnly();
    if (after !== "on") {
      console.error(`the session stopped being read-only during the run (${after}) — treat this output as unproven`);
      process.exit(4);
    }
    console.log(JSON.stringify({ businessId: COLLECTION_QA_BUSINESS_ID, qaCommitmentIds: [...qaIds], readOnly: after, days: report }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
