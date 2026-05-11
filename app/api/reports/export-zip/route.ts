import archiver from "archiver";
import { PassThrough } from "stream";
import { getCurrentUser } from "@/lib/auth";
import { appendAccountantPackToArchive } from "@/lib/reports/accountant-export-zip";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json();

    const stream = new PassThrough();
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(stream);

    await appendAccountantPackToArchive(archive, user.businessId, body);

    await archive.finalize();

    return new Response(stream as unknown as BodyInit, {
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
