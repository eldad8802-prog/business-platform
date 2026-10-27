import { NextResponse } from "next/server";

import { recordLinkAccess } from "@/lib/accountant/delivery.service";
import { LINK_NO_STORE, withAccountantLink } from "@/lib/accountant/link-access";
import { periodLabelHe } from "@/lib/accountant/period";
import { ensurePortalIndex } from "@/lib/accountant/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST — the accountant's portal (public, no session). Body: { publicId, token }.
 *
 * The package as it was sealed and delivered: whose, which month, until when, and every file in it (source
 * and issued documents, each with its sha256, size and its row of the package's own workbook), plus the
 * rows whose file is not in it. Read from the stored ZIP after its sha256 is checked — never from live data.
 * No storage key, path to storage or signed URL is in the answer. The view is recorded (LINK_VIEWED).
 */
export async function POST(req: Request) {
  return withAccountantLink(req, "ACCOUNTANT_LINK_PUBLIC", async (link, _body, now) => {
    const index = await ensurePortalIndex(link.sealed);
    await recordLinkAccess(link.businessId, link, now, {
      eventType: "LINK_VIEWED",
      payload: { packageVersion: link.packageVersion, files: index.files.length },
    });
    return NextResponse.json(
      {
        businessName: link.businessName,
        periodKey: link.periodKey,
        periodLabel: periodLabelHe(link.periodKey),
        expiresAt: link.expiresAt.toISOString(),
        packageVersion: link.packageVersion,
        packageSha256: link.packageSha256,
        generatedAt: index.generatedAt,
        counts: index.counts,
        files: index.files.map((f) => ({
          path: f.path,
          kind: f.kind,
          fileName: f.fileName,
          viewable: f.viewable,
          size: f.size,
          sha256: f.sha256,
          verified: f.verified,
          title: f.title,
          date: f.date,
          party: f.party,
          amount: f.amount,
          currency: f.currency,
          note: f.note,
        })),
        missing: index.missing,
      },
      { headers: LINK_NO_STORE }
    );
  });
}
