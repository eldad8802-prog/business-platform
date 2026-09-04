/**
 * Export request parsing — the trust boundary between the browser and the
 * engine.
 *
 * Everything the client may say is here, and it is exactly two things: WHICH
 * domains and WHICH format. There is no businessId, no table name, no column
 * list, no filter, no limit and no file path in the request — a client that
 * cannot name a table cannot reach one, and a client that cannot name a column
 * cannot widen what a descriptor decided to expose.
 *
 * The tenant is never a request field. It comes from the session, server-side,
 * in the route.
 *
 * Fails CLOSED and specifically: an unknown domain id, a duplicate, an empty
 * selection or an unsupported format is a 400 with a reason the UI can show —
 * never a silent fallback to "everything" or "the default domain".
 */

import type { DataTransferDomainId } from "@/lib/data-transfer/domains";
import {
  EXPORTABLE_DOMAIN_IDS,
  isExportableDomainId,
} from "@/lib/data-transfer/export/export-registry";

export const EXPORT_FORMATS = ["xlsx", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportRequest = {
  /** Deduplicated, in canonical registry order — never the client's order. */
  domains: DataTransferDomainId[];
  format: ExportFormat;
};

export type ExportRequestParse =
  | { ok: true; request: ExportRequest }
  | { ok: false; code: ExportRequestErrorCode; message: string };

export type ExportRequestErrorCode =
  | "INVALID_BODY"
  | "NO_DOMAINS"
  | "UNKNOWN_DOMAIN"
  | "TOO_MANY_DOMAINS"
  | "UNSUPPORTED_FORMAT";

function fail(
  code: ExportRequestErrorCode,
  message: string
): ExportRequestParse {
  return { ok: false, code, message };
}

/**
 * Validate an untrusted request body.
 *
 * Ordering note: the result is sorted into the REGISTRY's order, not the order
 * the client sent. Two clients asking for the same domains must get
 * byte-identical sheet order and file names; letting the caller's array order
 * leak into the artifact would make the output non-deterministic for no gain.
 */
export function parseExportRequest(body: unknown): ExportRequestParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("INVALID_BODY", "בקשה לא תקינה");
  }

  const record = body as Record<string, unknown>;
  const rawDomains = record.domains;
  const rawFormat = record.format;

  if (!Array.isArray(rawDomains)) {
    return fail("INVALID_BODY", "בקשה לא תקינה");
  }

  // A generous cap that only ever trips on a malformed or hostile body — the
  // real bound is that there are four exportable domains.
  if (rawDomains.length > 32) {
    return fail("TOO_MANY_DOMAINS", "נבחרו יותר מדי תחומים");
  }

  const seen = new Set<DataTransferDomainId>();
  for (const candidate of rawDomains) {
    if (!isExportableDomainId(candidate)) {
      // Do not echo the offending value back into the response.
      return fail("UNKNOWN_DOMAIN", "נבחר תחום שאינו נתמך לייצוא");
    }
    seen.add(candidate);
  }

  if (seen.size === 0) {
    return fail("NO_DOMAINS", "בחר לפחות תחום אחד לייצוא");
  }

  const format =
    rawFormat === undefined || rawFormat === null ? "xlsx" : rawFormat;
  if (
    typeof format !== "string" ||
    !(EXPORT_FORMATS as readonly string[]).includes(format)
  ) {
    return fail("UNSUPPORTED_FORMAT", "פורמט הייצוא אינו נתמך");
  }

  return {
    ok: true,
    request: {
      domains: EXPORTABLE_DOMAIN_IDS.filter((id) => seen.has(id)),
      format: format as ExportFormat,
    },
  };
}
