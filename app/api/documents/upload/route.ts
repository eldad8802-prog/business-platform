import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { getCurrentUser } from "@/lib/auth";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";
import { runUnifiedDocumentIntelligence } from "@/lib/services/documents/unified-extraction-engine.service";
import { consumeRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB

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

function isAllowedMime(mimeType: string): boolean {
  const m = String(mimeType || "").toLowerCase().trim();
  return m === "application/pdf" || m.startsWith("image/");
}

export async function POST(req: Request) {
  let tempFilePath: string | null = null;

  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userLimit = consumeRateLimit({
      key: `documents:upload:user:${user.id}`,
      limit: 10,
      windowMs: 60 * 60_000,
    });
    if (!userLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const businessLimit = consumeRateLimit({
      key: `documents:upload:business:${user.businessId}`,
      limit: 30,
      windowMs: 24 * 60 * 60_000,
    });
    if (!businessLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file" }, { status: 400 });
    }

    if (typeof file.type !== "string" || !isAllowedMime(file.type)) {
      return NextResponse.json(
        { error: "Unsupported file type" },
        { status: 400 }
      );
    }

    if (typeof file.size !== "number" || file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "File too large (max 15MB)" },
        { status: 413 }
      );
    }

    const businessId = user.businessId;

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
