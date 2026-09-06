/**
 * Reading a Documents batch off the wire — once, for both endpoints.
 *
 * Analyze and Execute receive the identical multipart shape, and Execute's
 * whole security argument is that it re-derives what Analyze derived. Two
 * copies of this parsing would be two places for the limits to drift apart, and
 * the drift would be invisible: the endpoints would simply start disagreeing
 * about which batches are acceptable.
 *
 * This returns a plain result rather than an HTTP response so that the status
 * code stays the caller's decision — the two endpoints legitimately differ on
 * what a refusal means.
 */

import {
  DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
  DOCUMENTS_IMPORT_MAX_FILES,
} from "@/lib/data-transfer/documents/documents-import-config";
import type {
  DocumentDecisions,
  DocumentFileAction,
  IncomingFile,
} from "@/lib/data-transfer/documents/batch-analyze";

export type BatchFormResult =
  | { ok: true; files: IncomingFile[]; decisions: DocumentDecisions | null }
  | { ok: false; code: string; error: string; status: 400 | 413 };

const ACTIONS: readonly string[] = ["CREATE", "CREATE_ANYWAY", "SKIP"];

function tooLarge(): BatchFormResult {
  const mb = Math.round(DOCUMENTS_IMPORT_MAX_BATCH_BYTES / 1024 / 1024);
  return {
    ok: false,
    code: "BATCH_TOO_LARGE",
    error: `סך הקבצים גדול מדי (עד ${mb}MB)`,
    status: 413,
  };
}

export async function readDocumentBatchForm(
  form: FormData
): Promise<BatchFormResult> {
  const entries = form.getAll("files").filter((f): f is File => f instanceof File);
  if (entries.length === 0) {
    return { ok: false, code: "NO_FILES", error: "לא נבחרו קבצים", status: 400 };
  }
  if (entries.length > DOCUMENTS_IMPORT_MAX_FILES) {
    return {
      ok: false,
      code: "TOO_MANY_FILES",
      error: `אפשר לבחור עד ${DOCUMENTS_IMPORT_MAX_FILES} קבצים בבת אחת`,
      status: 413,
    };
  }

  // Declared sizes first, so an oversized batch is refused before its bytes are
  // pulled into memory. The real byte length is re-checked while reading.
  const declaredTotal = entries.reduce(
    (sum, f) => sum + (typeof f.size === "number" ? f.size : 0),
    0
  );
  if (declaredTotal > DOCUMENTS_IMPORT_MAX_BATCH_BYTES) return tooLarge();

  const files: IncomingFile[] = [];
  let actualTotal = 0;
  for (const entry of entries) {
    const buffer = Buffer.from(await entry.arrayBuffer());
    actualTotal += buffer.length;
    if (actualTotal > DOCUMENTS_IMPORT_MAX_BATCH_BYTES) return tooLarge();
    files.push({
      filename:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim().slice(0, 255)
          : "(ללא שם)",
      mimeType: typeof entry.type === "string" ? entry.type : "",
      buffer,
    });
  }

  // Shape only. Whether a decision is LEGITIMATE is decided against freshly
  // derived analysis by the caller — a client cannot grant itself a CREATE.
  let decisions: DocumentDecisions | null = null;
  const raw = form.get("decisions");
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("decisions must be an object");
      }
      decisions = {};
      for (const [key, value] of Object.entries(parsed)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0) throw new Error("index");
        if (typeof value !== "string" || !ACTIONS.includes(value)) {
          throw new Error("action");
        }
        decisions[index] = value as DocumentFileAction;
      }
    } catch {
      return {
        ok: false,
        code: "DECISIONS_MALFORMED",
        error: "הבחירות אינן תקינות",
        status: 400,
      };
    }
  }

  return { ok: true, files, decisions };
}
