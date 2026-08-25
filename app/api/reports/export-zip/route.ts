import { getCurrentUser } from "@/lib/auth";
import {
  buildAccountantPackZipBuffer,
  type AccountantPackBody,
} from "@/lib/reports/accountant-export-zip";

// Real months fetch dozens of originals from object storage; the platform
// default duration is what turned the historic stream deadlock into a 504.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = (await req.json()) as AccountantPackBody;

    // Fully materialized before responding: a Node stream is not a valid Fetch
    // body, and the previous stream-based version awaited finalize() with no
    // consumer attached — deadlocking on backpressure for any real month.
    const zip = await buildAccountantPackZipBuffer(user.businessId, body);

    return new Response(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=accountant-pack.zip",
        "Content-Length": String(zip.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    console.error("[export-zip] accountant pack failed:", e);
    return new Response("error", { status: 500 });
  }
}
