import { prisma } from "@/lib/prisma";
const archiver = require("archiver");
import { PassThrough } from "stream";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { type, month, year, quarter, categories } = body;

    const businessId = 1;

    // 🧠 חישוב תאריכים
    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (type === "month" && month) {
      const [y, m] = month.split("-").map(Number);
      fromDate = new Date(y, m - 1, 1);
      toDate = new Date(y, m, 0, 23, 59, 59);
    }

    if (type === "year") {
      const currentYear = new Date().getFullYear() - 1;
      fromDate = new Date(currentYear, 0, 1);
      toDate = new Date(currentYear, 11, 31, 23, 59, 59);
    }

    if (type === "quarter" && year && quarter) {
      const q = Number(quarter);
      const y = Number(year);

      const startMonth = (q - 1) * 3;
      const endMonth = startMonth + 2;

      fromDate = new Date(y, startMonth, 1);
      toDate = new Date(y, endMonth + 1, 0, 23, 59, 59);
    }

    // 📊 מביא רשומות
    const records = await prisma.financialRecord.findMany({
      where: {
        businessId,
        ...(fromDate && toDate
          ? {
              date: {
                gte: fromDate,
                lte: toDate,
              },
            }
          : {}),
        ...(categories && categories.length > 0
          ? {
              category: {
                in: categories,
              },
            }
          : {}),
      },
    });

    // 🧾 מביא מסמכים
    const documentIds = records
      .map((r) => r.documentId)
      .filter(Boolean);

    const documents = await prisma.document.findMany({
      where: {
        id: { in: documentIds },
      },
    });

    // 📄 CSV
    const headers = ["Date", "Vendor", "Category", "Amount", "Direction"];

    const rows = records.map((r) => [
      new Date(r.date).toISOString().split("T")[0],
      r.vendorName,
      r.category,
      r.amount,
      r.direction,
    ]);

    const csv =
      [headers, ...rows].map((r) => r.join(",")).join("\n");

    // 📦 יצירת ZIP
    const stream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(stream);

    // CSV
    archive.append(csv, { name: "report.csv" });

    // 📁 קבצים
    for (const doc of documents) {
      try {
        if (!doc.fileUrl) continue;

        const fileRes = await fetch(doc.fileUrl);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        const ext = doc.fileUrl.split(".").pop() || "file";
        const filename = `documents/doc-${doc.id}.${ext}`;

        archive.append(buffer, { name: filename });
      } catch (e) {
        console.error("File fetch failed:", doc.fileUrl);
      }
    }

    await archive.finalize();

    return new Response(stream as any, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=accountant-pack.zip",
      },
    });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
}