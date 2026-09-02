import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { buildFinancialRecordsCsvBuffer } from "@/lib/reports/financial-records-csv";

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const businessId = user.businessId;

    const month = searchParams.get("month");

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (month) {
      const [year, m] = month.split("-").map(Number);
      fromDate = new Date(year, m - 1, 1);
      toDate = new Date(year, m, 0, 23, 59, 59);
    }

    const records = await runWithTenantContext({ businessId: user.businessId }, () => withTenantTransaction((tx) => tx.financialRecord.findMany({
      where: {
        businessId,
        ...(fromDate && toDate
          ? {
              date: {
                gte: fromDate,
                lte: toDate,
              },
            }
          : {}),
      },
    })));

    // Columns, order, values, delimiter and line ending are unchanged. What
    // changed is that fields are now escaped and formula-guarded, and the body
    // carries a UTF-8 BOM — the previous `r.join(",")` corrupted any row whose
    // vendor/category contained a comma, quote or newline, and shipped
    // OCR-derived text straight into the spreadsheet as executable content.
    // See lib/reports/financial-records-csv.ts.
    const csv = buildFinancialRecordsCsvBuffer(records);

    return new Response(new Uint8Array(csv), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=report.csv",
        // This body is the tenant's financial records. Without an explicit
        // directive a CSV download is cacheable by any shared cache and stays
        // in the browser's disk cache after logout. Matches the sibling
        // accountant pack (/api/reports/export-zip), which already sets it.
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return new Response("error", { status: 500 });
  }
}