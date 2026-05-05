import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";

export const runtime = "nodejs";

function safeExtFromMime(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t === "application/pdf") return ".pdf";
  if (t === "image/jpeg") return ".jpg";
  if (t === "image/png") return ".png";
  if (t === "image/webp") return ".webp";
  if (t === "image/gif") return ".gif";
  if (t.startsWith("image/")) return ".img";
  return "";
}

export async function POST(req: Request) {
  let tempFilePath: string | null = null;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    const businessId = 1;

    const tmpDir = path.join(process.cwd(), "tmp", "ocr");
    await mkdir(tmpDir, { recursive: true });

    const originalName = String(file.name ?? "");
    const originalExt = path.extname(originalName);
    const mimeType = String(file.type ?? "");

    const ext = originalExt || safeExtFromMime(mimeType) || ".bin";
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = `upload-${unique}${ext}`;

    tempFilePath = path.join(tmpDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(tempFilePath, buffer);

    const rawText = (
      await runGoogleVisionOCR(tempFilePath, mimeType || undefined)
    ).trim();

    if (!rawText) {
      return NextResponse.json(
        { error: "OCR produced no text", needsReview: true },
        { status: 400 }
      );
    }

    const extracted = await runUnifiedDocumentIntelligence({
      businessId,
      rawText,
    });

    console.log("DOCUMENT ANALYSIS:", {
      documentType: extracted.documentType,
      isFinancial: extracted.isFinancial,
      guardrailRoute: extracted.guardrailRoute,
      needsReview: extracted.needsReview,
      direction: extracted.direction,
      confidence: extracted.confidence,
      financialEvidenceLevel: extracted.financialEvidenceLevel,
      amountEligible: extracted.amountEligible,
      weakResolutionReason: extracted.weakResolutionReason,
      evidenceReasons: extracted.evidenceReasons,
    });

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

        direction: extracted.direction,
        date: extracted.date,
        confidenceScore: extracted.confidence,
      },
    });

    return NextResponse.json({
      success: true,
      documentId: document.id,
      extracted: extractedData,
      outputProfile: extracted.outputProfile,
      analysis: {
        documentType: extracted.documentType,
        isFinancial: extracted.isFinancial,
        guardrailRoute: extracted.guardrailRoute,
        searchableText: extracted.searchableText,
        direction: extracted.direction,
        needsReview: extracted.needsReview,
        confidence: extracted.confidence,
        amountConfidence: extracted.amountConfidence,
        vendorConfidence: extracted.vendorConfidence,
        dateConfidence: extracted.dateConfidence,
        categoryConfidence: extracted.categoryConfidence,
        financialEvidenceLevel: extracted.financialEvidenceLevel,
        amountEligible: extracted.amountEligible,
        weakResolutionReason: extracted.weakResolutionReason,
        evidenceReasons: extracted.evidenceReasons,
      },
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
