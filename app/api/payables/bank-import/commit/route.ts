import { commitBankFile } from "@/lib/services/bank-file-import/bank-file-import.service";
import { bankImportRoute, json, readImportForm } from "@/lib/services/bank-file-import/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

/**
 * Step 2: the same file, the same account and mapping, the token from step 1, and the owner's decision (IMPORT /
 * SKIP) for every suspected duplicate — refused without one. One transaction: new lines are inserted, certain
 * duplicates are not, suspected lines follow the decision; a repeated commit reports the first outcome.
 */
export async function POST(req: Request) {
  return bankImportRoute(req, async (actor) => {
    const { input, token, decisions } = await readImportForm(req, actor);
    const result = await commitBankFile({ ...input, token, decisions });
    return json(result, result.replayed ? 200 : 201);
  });
}
