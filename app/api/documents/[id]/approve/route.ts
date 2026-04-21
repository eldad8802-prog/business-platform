import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const documentId = Number(params.id);

    if (isNaN(documentId)) {
      return Response.json({ error: "Invalid ID" }, { status: 400 });
    }

    const body = await req.json();

    console.log("APPROVE BODY:", body);

    const vendorName = body.vendorName ?? "Unknown";
    const category = body.category ?? "general";
    const amount = Number(body.amount ?? 0);

    const businessId = 1;

    // 🔍 בדיקה אם כבר קיים FinancialRecord
    const existingRecord = await prisma.financialRecord.findFirst({
      where: { documentId },
    });

    let record;

    if (existingRecord) {
      record = await prisma.financialRecord.update({
        where: { id: existingRecord.id },
        data: {
          amount,
          vendorName,
          category,
          direction: "expense",
          date: new Date(),
        },
      });
    } else {
      record = await prisma.financialRecord.create({
        data: {
          documentId,
          businessId,
          amount,
          vendorName,
          category,
          direction: "expense",
          date: new Date(),
        },
      });
    }

    // 🧠 LEARNING (רק לפי עסק — בלי global)
    await prisma.vendorLearning.upsert({
      where: {
        businessId_vendorName: {
          businessId,
          vendorName,
        },
      },
      update: {
        usageCount: { increment: 1 },
        category,
        confidence: { increment: 0.02 },
        lastUsedAt: new Date(),
      },
      create: {
        businessId,
        vendorName,
        category,
        confidence: 0.8,
        usageCount: 1,
        isGlobal: false,
      },
    });

    // ✅ עדכון סטטוס מסמך
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "approved" },
    });

    return Response.json({
      success: true,
      record,
    });
  } catch (error) {
    console.error("APPROVE ERROR FULL:", error);

    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}