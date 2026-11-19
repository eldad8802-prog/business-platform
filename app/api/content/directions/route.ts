import { NextRequest, NextResponse } from "next/server";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getContentDirections } from "@/lib/services/content-decision.service";
import { getCurrentUser } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    const { category, subCategory, businessModel, hasContentActivity } = body;

    if (!category) {
      return NextResponse.json(
        { error: "category is required" },
        { status: 400 }
      );
    }

    const directions = getContentDirections({
      category,
      subCategory,
      businessModel,
      hasContentActivity,
    });

    return NextResponse.json({ directions });
  } catch (error) {
    console.error("Content Directions Error:", error);

    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}