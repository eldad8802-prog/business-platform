/**
 * The business profile, read and written as the tenant that owns it.
 *
 * `BusinessProfile` is FORCE RLS. Both handlers used the bare Prisma client
 * with no tenant context, and under the least-privilege runtime role that had
 * two different consequences — one silent, one loud:
 *
 *   GET  matched zero rows and answered `hasProfile: false` for a tenant whose
 *        profile exists. A caller cannot tell that apart from a new account.
 *   POST fell through the upsert's update branch (its WHERE saw nothing) into
 *        an insert, which the policy's WITH CHECK refused — an ordinary save
 *        returning 500 "Server error".
 *
 * Both now run through the canonical tenant transaction. The contract is
 * unchanged: same fields, same validation, same responses.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import { changedFields, recordSensor } from "@/lib/sensors/record-sensor";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await tenantTx(user.businessId, (tx) =>
      tx.businessProfile.findUnique({
        where: { businessId: user.businessId },
      })
    );

    return NextResponse.json({
      success: true,
      hasProfile: !!profile,
      profile,
    });
  } catch (error) {
    console.error("PROFILE_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { category, subCategory, businessModel } = body;

    if (!category || !subCategory || !businessModel) {
      return NextResponse.json(
        { error: "category, subCategory and businessModel are required" },
        { status: 400 }
      );
    }

    if (!["service", "product", "hybrid"].includes(String(businessModel).toLowerCase())) {
      return NextResponse.json(
        { error: "businessModel must be service, product or hybrid" },
        { status: 400 }
      );
    }

    const normalizedBusinessModel = String(businessModel).toLowerCase();

    const profile = await tenantTx(user.businessId, async (tx) => {
      // M5.5 sensor: read the previous row in the same tenant tx so "what changed" is exact.
      const before = await tx.businessProfile.findUnique({
        where: { businessId: user.businessId },
        select: { category: true, subCategory: true, businessModel: true },
      });

      const saved = await tx.businessProfile.upsert({
        where: { businessId: user.businessId },
        update: {
          category,
          subCategory,
          businessModel: normalizedBusinessModel,
        },
        create: {
          businessId: user.businessId,
          category,
          subCategory,
          businessModel: normalizedBusinessModel,
        },
      });

      const prev = {
        category: before?.category ?? null,
        subCategory: before?.subCategory ?? null,
        businessModel: before?.businessModel ?? null,
      };
      const next = {
        category: saved.category ?? null,
        subCategory: saved.subCategory ?? null,
        businessModel: saved.businessModel ?? null,
      };
      const fields = changedFields(prev, next, ["category", "subCategory", "businessModel"]);
      if (fields.length > 0) {
        await recordSensor(
          {
            businessId: user.businessId,
            sensor: "BUSINESS_PROFILE_CHANGED",
            entityId: user.businessId,
            actor: { type: "OWNER_USER", userId: user.id },
            source: "OWNER_UI",
            payload: {
              fields,
              ...(fields.includes("businessModel")
                ? { fromBusinessModel: prev.businessModel, toBusinessModel: next.businessModel }
                : {}),
              // category is free text the owner types (only businessModel is validated), so a
              // category change is recorded by NAME only — the value stays on BusinessProfile.
            },
          },
          { tx },
        );
      }

      return saved;
    });

    return NextResponse.json({
      success: true,
      profile,
    });
  } catch (error) {
    console.error("PROFILE_POST_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}