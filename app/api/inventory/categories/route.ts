import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const categories = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryCategory.findMany({
            where: { businessId: user.businessId },
            orderBy: { name: "asc" },
          })
        )
    );

    return NextResponse.json({
      success: true,
      categories,
    });
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.error("Categories GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await request.json();

    const name =
      typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json(
        { error: "Category name is required" },
        { status: 400 }
      );
    }

    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const existing = await tx.inventoryCategory.findFirst({
            where: {
              businessId: user.businessId,
              name,
            },
          });
          if (existing) {
            return { category: existing, alreadyExists: true };
          }
          const created = await tx.inventoryCategory.create({
            data: {
              businessId: user.businessId,
              name,
            },
          });
          return { category: created, alreadyExists: false };
        })
    );

    if (result.alreadyExists) {
      return NextResponse.json({
        success: true,
        category: result.category,
        alreadyExists: true,
      });
    }

    const category = result.category;

    return NextResponse.json(
      {
        success: true,
        category,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.error("Categories POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}