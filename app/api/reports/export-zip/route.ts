import { getCurrentUser } from "@/lib/auth";
import { recordSensor } from "@/lib/sensors/record-sensor";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  AccountantExportInputError,
  buildAccountantPackZipBuffer,
  resolveExportDateRange,
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

    // L-6: the period is validated strictly HERE, before any work, so a
    // malformed or path-like `month` is a 400 and never reaches entry names.
    // (The builder re-validates; the archive collector also refuses unsafe names.)
    try {
      resolveExportDateRange(body);
    } catch (e) {
      if (e instanceof AccountantExportInputError) {
        return Response.json({ error: "Invalid period", code: e.code }, { status: 400 });
      }
      throw e;
    }

    // Fully materialized before responding: a Node stream is not a valid Fetch
    // body, and the previous stream-based version awaited finalize() with no
    // consumer attached — deadlocking on backpressure for any real month.
    // D2/P7-W4D: tenant context so the pack collector reads FinancialRecord
    // on tenant transactions under FORCE RLS.
    const zip = await runWithTenantContext({ businessId: user.businessId }, () =>
      buildAccountantPackZipBuffer(user.businessId, body)
    );

    // M5.5 sensor — fail-open, after the pack was built.
    await recordSensor({
      businessId: user.businessId,
      sensor: "DATA_EXPORTED",
      entityId: user.businessId,
      actor: { type: "OWNER_USER", userId: user.id },
      source: "OWNER_UI",
      payload: { kind: "ACCOUNTANT_PACK", format: "ZIP" },
    });

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
