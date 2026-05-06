import { NextRequest, NextResponse } from "next/server";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const body = await req.json();

    if (typeof body.text !== "string" || body.text.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing text" },
        { status: 400 }
      );
    }

    const businessId = Number(body.businessId ?? 1);

    if (!Number.isFinite(businessId) || businessId <= 0) {
      return NextResponse.json(
        { success: false, error: "Invalid businessId" },
        { status: 400 }
      );
    }

    const result = await runUnifiedDocumentIntelligence({
      businessId,
      rawText: body.text,
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("[debug-unified] Server error:", error);

    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}