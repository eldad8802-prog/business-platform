import { recordLinkAccess, type LinkAccessEvent } from "@/lib/accountant/delivery.service";
import { AccountantError } from "@/lib/accountant/http";
import { withAccountantLink } from "@/lib/accountant/link-access";
import { serveLinkObject } from "@/lib/accountant/package-download";
import {
  PDF_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  ensurePackageExcel,
  ensurePackagePdf,
  packageExcelDownloadName,
  packagePdfDownloadName,
} from "@/lib/accountant/package-reports";
import { ensurePortalFile, ensurePortalIndex, findPortalFile } from "@/lib/accountant/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The PDF report may render (Chromium) on its first request — the same budget as the owner's download.
export const maxDuration = 60;

/**
 * POST — one file of the delivered package, for the accountant (public, no session).
 * Body: { publicId, token, mode: "view" | "download", file: "<path in the package>" } or { …, report: "xlsx" | "pdf" }.
 *
 *   file    a source or issued document, named by its path in the package's index (nothing else is
 *           reachable): the ZIP entry byte for byte, its sha256 checked against the index;
 *   report  the package's own Excel workbook, or its PDF rendering (lib/accountant/package-reports.ts).
 *
 * The access is recorded (LINK_FILE_DOWNLOADED) once the file to hand out is known to be right; the answer
 * is a five-minute signed URL (or, on the local adapter, the bytes) — never a lasting or public URL.
 */
export async function POST(req: Request) {
  return withAccountantLink(req, "ACCOUNTANT_LINK_FILE", async (link, body, now) => {
    const mode = body.mode;
    if (mode !== "view" && mode !== "download") throw new AccountantError(400, "INVALID_MODE");

    let served: { key: string; name: string; contentType: string };
    let event: LinkAccessEvent;
    if (body.report === "xlsx" || body.report === "pdf") {
      if (body.report === "xlsx" && mode === "view") throw new AccountantError(400, "NOT_VIEWABLE");
      served =
        body.report === "pdf"
          ? { key: (await ensurePackagePdf(link.sealed)).key, name: packagePdfDownloadName(link.periodKey, link.packageVersion), contentType: PDF_CONTENT_TYPE }
          : { key: (await ensurePackageExcel(link.sealed)).key, name: packageExcelDownloadName(link.periodKey, link.packageVersion), contentType: XLSX_CONTENT_TYPE };
      event = {
        eventType: "LINK_FILE_DOWNLOADED",
        payload: { kind: body.report === "pdf" ? "report_pdf" : "report_xlsx", mode, packageVersion: link.packageVersion, sha16: link.packageSha256.slice(0, 16) },
      };
    } else if (body.report === undefined) {
      const index = await ensurePortalIndex(link.sealed);
      const file = findPortalFile(index, body.file);
      if (!file) throw new AccountantError(404, "FILE_NOT_FOUND");
      if (mode === "view" && !file.viewable) throw new AccountantError(400, "NOT_VIEWABLE");
      served = { key: (await ensurePortalFile(link.sealed, file)).key, name: file.fileName, contentType: file.contentType };
      event = {
        eventType: "LINK_FILE_DOWNLOADED",
        payload: {
          kind: file.kind,
          mode,
          packageVersion: link.packageVersion,
          ...(file.documentId !== null ? { documentId: file.documentId } : {}),
          sha16: file.sha256.slice(0, 16),
        },
      };
    } else {
      throw new AccountantError(400, "INVALID_REPORT");
    }

    await recordLinkAccess(link.businessId, link, now, event);
    return serveLinkObject(served.key, served.name, served.contentType, mode);
  });
}
