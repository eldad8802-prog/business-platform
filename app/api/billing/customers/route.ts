import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(n, MAX_LIMIT);
}

/**
 * Search + list customers for the current business (billing / invoice UX).
 * GET ?q= optional substring on name or phone, ?limit=
 * POST { name, phone? } — quick create
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();
    const limit = parseLimit(searchParams.get("limit"));

    const where: Prisma.CustomerWhereInput = {
      businessId: user.businessId,
    };

    if (q.length > 0) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ];
    }

    const customers = await prisma.customer.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
      },
    });

    return NextResponse.json({ customers }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const nameRaw = body.name;
    if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
      throw new ValidationError("name is required");
    }
    const name = nameRaw.trim().slice(0, 200);
    const phone =
      typeof body.phone === "string" && body.phone.trim().length > 0
        ? body.phone.trim().slice(0, 40)
        : null;

    const customer = await prisma.customer.create({
      data: {
        businessId: user.businessId,
        name,
        phone,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        city: true,
      },
    });

    return NextResponse.json({ customer }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
