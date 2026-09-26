/**
 * Bounded read of an uploaded CSV (L-5, supplier-purchases CSV import).
 *
 * The route used `await file.text()` with no ceiling: the whole body was
 * buffered and decoded, then parsed line by line into orders, each of which
 * becomes DB work. This applies the Import Center's own bounds
 * (IMPORT_MAX_FILE_BYTES / IMPORT_MAX_ROWS) BEFORE decoding and parsing.
 */

import { IMPORT_MAX_FILE_BYTES, IMPORT_MAX_ROWS } from "./import-config";

/** Multipart framing on top of the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type BoundedCsvResult =
  | { ok: true; text: string }
  | {
      ok: false;
      status: 400 | 413;
      code: "BODY_TOO_LARGE" | "FILE_TOO_LARGE" | "TOO_MANY_ROWS" | "EMPTY_FILE";
      error: string;
    };

/** Refuse on the declared request size before the multipart body is parsed. */
export function precheckCsvRequestSize(req: Request): BoundedCsvResult | null {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > IMPORT_MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return tooLarge("BODY_TOO_LARGE");
  }
  return null;
}

export async function readBoundedCsvFile(file: Blob): Promise<BoundedCsvResult> {
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    return tooLarge("FILE_TOO_LARGE");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > IMPORT_MAX_FILE_BYTES) {
    return tooLarge("FILE_TOO_LARGE");
  }

  // Count lines on the BYTES (0x0A) before decoding: header + IMPORT_MAX_ROWS.
  let lines = 0;
  for (let i = bytes.indexOf(0x0a); i !== -1; i = bytes.indexOf(0x0a, i + 1)) {
    lines += 1;
    if (lines > IMPORT_MAX_ROWS + 1) {
      return {
        ok: false,
        status: 413,
        code: "TOO_MANY_ROWS",
        error: `CSV has too many rows (max ${IMPORT_MAX_ROWS})`,
      };
    }
  }

  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) {
    return { ok: false, status: 400, code: "EMPTY_FILE", error: "CSV file is empty" };
  }
  return { ok: true, text };
}

function tooLarge(code: "BODY_TOO_LARGE" | "FILE_TOO_LARGE"): BoundedCsvResult {
  return {
    ok: false,
    status: 413,
    code,
    error: `CSV file too large (max ${Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024)}MB)`,
  };
}
