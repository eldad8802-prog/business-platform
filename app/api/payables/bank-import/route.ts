import { BANK_MAX_LINES } from "@/lib/services/bank-file-import/bank-file-core";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import { bankImportRoute, json } from "@/lib/services/bank-file-import/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Is bank file import open for this business (404 while the flag is OFF), and its limits. Reads nothing else. */
export async function GET(req: Request) {
  return bankImportRoute(req, async () => json({ enabled: true, maxBytes: IMPORT_MAX_FILE_BYTES, maxLines: BANK_MAX_LINES }));
}
