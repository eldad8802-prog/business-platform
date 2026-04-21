import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const businessId = 1;

    const month = searchParams.get("month");

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (month) {
      const [year, m] = month.split("-").map(Number);
      fromDate = new Date(year, m - 1, 1);
      toDate = new Date(year, m, 0, 23, 59, 59);
    }

    const records = await prisma.financialRecord.findMany({
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
    });

    const headers = ["Date", "Vendor", "Category", "Amount", "Direction"];

    const rows = records.map((r) => [
      new Date(r.date).toISOString().split("T")[0],
      r.vendorName,
      r.category,
      r.amount,
      r.direction,
    ]);

    const csv =
      [headers, ...rows].map((r) => r.join(",")).join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=report.csv",
      },
    });
  } catch {
    return new Response("error", { status: 500 });
  }
}