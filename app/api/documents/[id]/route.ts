import { prisma } from "@/lib/prisma";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params; // 🔥 חשוב
    const id = Number(params.id);

    console.log("ID:", id);

    if (isNaN(id)) {
      return Response.json(
        { error: "Invalid ID" },
        { status: 400 }
      );
    }

    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        extractedData: true,
      },
    });

    if (!document) {
      return Response.json(
        { error: "Document not found" },
        { status: 404 }
      );
    }

    return Response.json({
      document,
      extracted: document.extractedData,
    });
  } catch (error) {
    console.error("GET DOCUMENT ERROR:", error);

    return Response.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}