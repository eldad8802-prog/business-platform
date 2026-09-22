/**
 * AD-2A — normalise policy predicates by asking PostgreSQL, not by reformatting text.
 *
 * Two predicates that mean the same thing can be written many ways: whitespace,
 * redundant parentheses, `::int` against `::integer`. Comparing source strings would
 * flag harmless reformatting and — worse — could be "fixed" by editing text until it
 * matches. So each expression is handed to PostgreSQL as the USING clause of a
 * throwaway policy on the real table, read back with `pg_get_expr`, and the whole
 * transaction is rolled back. What comes out is PostgreSQL's own canonical form of
 * the parsed expression, which is exactly what `pg_policy` stores for a live policy.
 *
 * An expression PostgreSQL cannot parse is an error, not a mismatch: it is returned
 * as `{ error }` so a caller reports it instead of comparing it.
 */
const ROLLBACK = Symbol("rollback");

/**
 * @param owner  a Prisma client connected as the lab owner
 * @param items  [{ table, expr }] — expr may be null (returns null)
 * @returns      array aligned with items: string | null | { error: string }
 */
export async function deparseAll(owner, items) {
  const out = new Array(items.length).fill(null);
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const { table, expr } = items[i];
    if (expr === null || expr === undefined) continue;
    // One transaction per expression: a parse error aborts the transaction, and
    // must not take the rest of the batch down with it.
    try {
      await owner.$transaction(async (tx) => {
        const name = `ad2a_deparse_${n++}`;
        await tx.$executeRawUnsafe(`CREATE POLICY ${name} ON "${table}" USING (${expr})`);
        const rows = await tx.$queryRawUnsafe(
          `SELECT pg_get_expr(p.polqual, p.polrelid) AS e FROM pg_policy p
             JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'public' AND c.relname = $1 AND p.polname = $2`,
          table,
          name
        );
        out[i] = rows[0].e;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) out[i] = { error: String(e?.message ?? e).split("\n").slice(-1)[0] };
    }
  }
  return out;
}
