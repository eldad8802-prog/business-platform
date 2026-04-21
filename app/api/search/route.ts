import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const q = searchParams.get("q") || "";
    const category = searchParams.get("category");
    const vendor = searchParams.get("vendor");

    const results = await prisma.financialRecord.findMany({
      where: {
        businessId: 1,
        AND: [
          q
            ? {
                OR: [
                  { vendorName: { contains: q, mode: "insensitive" } },
                  { category: { contains: q, mode: "insensitive" } },
                ],
              }
            : {},
          category ? { category } : {},
          vendor ? { vendorName: vendor } : {},
        ],
      },
      orderBy: {
        date: "desc",
      },
    });

    return Response.json({ results });
  } catch (error) {
    console.error("SEARCH ERROR:", error);

    return Response.json(
      { error: "Search failed" },
      { status: 500 }
    );
  }
}