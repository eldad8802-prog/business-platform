import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const businessId = 1;

    const month = searchParams.get("month"); // YYYY-MM

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

    let totalIncome = 0;
    let totalExpense = 0;

    const categories: Record<string, number> = {};

    for (const r of records) {
      if (r.direction === "income") totalIncome += r.amount;
      else totalExpense += r.amount;

      categories[r.category] = (categories[r.category] || 0) + r.amount;
    }

    return Response.json({
      totalIncome,
      totalExpense,
      profit: totalIncome - totalExpense,
      categories,
      count: records.length,
    });
  } catch (e) {
    return Response.json({ error: "error" }, { status: 500 });
  }
}