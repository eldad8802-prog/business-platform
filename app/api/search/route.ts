import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);

    const q = searchParams.get("q") || "";
    const category = searchParams.get("category");
    const vendor = searchParams.get("vendor");

    const results = await prisma.financialRecord.findMany({
      where: {
        businessId: user.businessId,
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