/**
 * Secretary → ledger cutover — operator entrypoint. SCRIPT-ONLY.
 *
 *   DRY-RUN (default — reads only, writes nothing):
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts --business 42
 *
 *   EXECUTE (requires BOTH the mode flag AND the confirm phrase):
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts --mode execute \
 *       --confirm-execute SECRETARY_LEDGER_CUTOVER_EXECUTE
 *
 * OWNER GATE: executing against Production is a Production data write and
 * needs the owner's explicit approval. The intended order is
 *   1. dry run → review the counts (and every listed conflict)
 *   2. execute
 *   3. dry run again → uncopied 0, drift 0 outside conflicts, totals 0
 *   4. only then set SECRETARY_LEDGER_STORE=true
 *
 * Reads DATABASE_URL like every script here. Prints counts and row ids only —
 * never a name, a note or an amount — plus the target host so the operator can
 * see where it is about to run.
 */
import { runSecretaryLedgerCutover } from "@/lib/services/payables/secretary-ledger-cutover.service";

export const EXECUTE_CONFIRM_PHRASE = "SECRETARY_LEDGER_CUTOVER_EXECUTE";

export type ParsedArgs = {
  mode: "dry-run" | "execute";
  confirmExecute: string | null;
  businessIds: number[];
  errors: string[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "dry-run", confirmExecute: null, businessIds: [], errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--mode") {
      if (value !== "dry-run" && value !== "execute") out.errors.push("--mode must be dry-run or execute");
      else out.mode = value;
      i += 1;
    } else if (flag === "--confirm-execute") {
      if (!value) out.errors.push("--confirm-execute requires a value");
      out.confirmExecute = value ?? null;
      i += 1;
    } else if (flag === "--business") {
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) out.errors.push("--business requires a positive integer");
      else out.businessIds.push(id);
      i += 1;
    } else {
      out.errors.push(`unknown argument ${flag}`);
    }
  }
  if (out.mode === "execute" && out.confirmExecute !== EXECUTE_CONFIRM_PHRASE) {
    out.errors.push(`execute requires --confirm-execute ${EXECUTE_CONFIRM_PHRASE}`);
  }
  return out;
}

function targetHost(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}${url.port ? ":" + url.port : ""}/${url.pathname.replace(/^\//, "")}`;
  } catch {
    return "(DATABASE_URL not set or unparseable)";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length > 0) {
    console.error(args.errors.join("\n"));
    process.exit(2);
  }
  console.log(`target: ${targetHost()}  mode: ${args.mode}`);
  const { prisma } = await import("@/lib/prisma");
  try {
    const report = await runSecretaryLedgerCutover(prisma, {
      mode: args.mode,
      onlyBusinessIds: args.businessIds.length > 0 ? args.businessIds : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    const after = report.after ?? report.before;
    const outstanding =
      after.uncopied.OPEN + after.uncopied.MET + after.uncopied.RELEASED + after.recurringWithTotalAmount;
    if (report.mode === "execute" && outstanding > 0) {
      console.error("cutover NOT complete — rows remain; do not enable SECRETARY_LEDGER_STORE");
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/payables/secretary-ledger-cutover.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
