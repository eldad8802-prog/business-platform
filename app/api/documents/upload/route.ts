import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { runExtractionEngine } from "@/lib/services/documents/extraction-engine.service";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const businessId = 1;

    // 🧠 עד OCR אמיתי
    const rawText = "קבלה פז דלק 320";

    const extracted = await runExtractionEngine(businessId, rawText);

    const document = await prisma.document.create({
      data: {
        businessId,
        fileUrl: `/uploads/${Date.now()}`,
        source: "file",
        mimeType: file.type || "image/jpeg",
        status: "needs_review",
        ocrText: rawText,
      },
    });

    const extractedData = await prisma.extractedData.create({
      data: {
        documentId: document.id,
        amount: extracted.amount,
        vendorName: extracted.vendorName,
        category: extracted.category,

        amountConfidence: extracted.amountConfidence,
        vendorConfidence: extracted.vendorConfidence,
        categoryConfidence: extracted.categoryConfidence,

        direction: "expense",
        date: new Date(),
        confidenceScore: 0.8,
      },
    });

    return NextResponse.json({
      success: true,
      documentId: document.id,
      extracted: extractedData,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}