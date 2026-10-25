import { analyzeBankFile } from "@/lib/services/bank-file-import/bank-file-import.service";
import { bankImportRoute, json, readImportForm } from "@/lib/services/bank-file-import/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 1 of a bank file import: read the file, propose the mapping, classify every line against what the
 * business already holds. ZERO WRITES. Returns the preview and a signed token for the commit.
 */
export async function POST(req: Request) {
  return bankImportRoute(req, async (actor) => {
    const { input } = await readImportForm(req, actor);
    return json(await analyzeBankFile(input));
  });
}
