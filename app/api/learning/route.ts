import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { goal, valueType } = body;

    const items = await prisma.contentFeedback.findMany({
      where: {
        success: true,
        goal,
        valueType,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 5,
    });

  const hooks = items
  .map((i: { hook: string | null }) => i.hook)
  .filter(Boolean);
    return NextResponse.json({ hooks });
  } catch (e) {
    return NextResponse.json({ hooks: [] });
  }
}