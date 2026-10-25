import { commitBankFile } from "@/lib/services/bank-file-import/bank-file-import.service";
import { bankImportRoute, json, readImportForm } from "@/lib/services/bank-file-import/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 2: the same file, the same account and mapping, and the token from step 1. One transaction: new lines
 * are inserted, known lines are not, a repeated commit reports the first outcome and does nothing again.
 */
export async function POST(req: Request) {
  return bankImportRoute(req, async (actor) => {
    const { input, token } = await readImportForm(req, actor);
    const result = await commitBankFile({ ...input, token });
    return json(result, result.replayed ? 200 : 201);
  });
}
