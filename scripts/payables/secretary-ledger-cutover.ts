/**
 * Secretary → ledger cutover — operator entrypoint. SCRIPT-ONLY.
 *
 *   DRY-RUN (default — every transaction READ ONLY, writes nothing):
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts --json-out report.json
 *
 *   EXECUTE (requires the mode flag, the confirm phrase AND the approved counts):
 *     npx tsx scripts/payables/secretary-ledger-cutover.ts --mode execute \
 *       --confirm-execute SECRETARY_LEDGER_CUTOVER_EXECUTE \
 *       --expect-copy N --expect-reconcile M --expect-totals K \n *       --expect-conflicts C --expect-plan '<the dry run's plan JSON>'
 *
 * OWNER GATE: executing against Production is a Production data write and
 * needs the owner's explicit approval. The order is
 *   1. dry run → review the counts, the plan and every listed conflict
 *   2. execute with exactly the approved counts — it refuses if they changed,
 *      and refuses while invalid or ambiguous rows exist
 *   3. dry run again → uncopied 0, drift 0 outside conflicts, totals 0
 *   4. only then set SECRETARY_LEDGER_STORE=true
 *
 * Reads DATABASE_URL like every script here. Prints counts and row ids only —
 * never a name, a note or an amount — plus the target host and the role, so the
 * operator can see where and as whom it is about to run.
 */
import { writeFileSync } from "node:fs";
import {
  CutoverRefusedError,
  expectedFrom,
  runSecretaryLedgerCutover,
  type CutoverCounts,
  type CutoverPlan,
  type CutoverReport,
} from "@/lib/services/payables/secretary-ledger-cutover.service";

export const EXECUTE_CONFIRM_PHRASE = "SECRETARY_LEDGER_CUTOVER_EXECUTE";

export type ParsedArgs = {
  mode: "dry-run" | "execute";
  confirmExecute: string | null;
  businessIds: number[];
  expect: { copy?: number; reconcile?: number; totals?: number; conflicts?: number; plan?: CutoverPlan };
  jsonOut: string | null;
  errors: string[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: "dry-run", confirmExecute: null, businessIds: [], expect: {}, jsonOut: null, errors: [] };
  const count = (flag: string, value: string | undefined): number | undefined => {
    const n = Number(value);
    if (value === undefined || !Number.isInteger(n) || n < 0) {
      out.errors.push(`${flag} requires a non-negative integer`);
      return undefined;
    }
    return n;
  };
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
    } else if (flag === "--expect-copy") {
      out.expect.copy = count(flag, value);
      i += 1;
    } else if (flag === "--expect-reconcile") {
      out.expect.reconcile = count(flag, value);
      i += 1;
    } else if (flag === "--expect-totals") {
      out.expect.totals = count(flag, value);
      i += 1;
    } else if (flag === "--expect-conflicts") {
      out.expect.conflicts = count(flag, value);
      i += 1;
    } else if (flag === "--expect-plan") {
      try {
        const plan = JSON.parse(value ?? "") as CutoverPlan;
        const keys = ["commitmentsToCreate", "installmentsToCreate", "commitmentsToUpdate", "installmentsToUpdate", "workflowRowsToCreate", "workflowRowsToUpdate", "auditEventsToWrite", "paymentsToCreate"] as const;
        if (!keys.every((k) => Number.isInteger(plan[k]) && plan[k] >= 0) || Object.keys(plan).length !== keys.length) throw new Error("shape");
        if (plan.paymentsToCreate !== 0) throw new Error("payments");
        out.expect.plan = plan;
      } catch {
        out.errors.push("--expect-plan requires the dry run's full plan JSON (8 non-negative integer fields, paymentsToCreate 0)");
      }
      i += 1;
    } else if (flag === "--json-out") {
      if (!value) out.errors.push("--json-out requires a path");
      out.jsonOut = value ?? null;
      i += 1;
    } else {
      out.errors.push(`unknown argument ${flag}`);
    }
  }
  if (out.mode === "execute") {
    if (out.confirmExecute !== EXECUTE_CONFIRM_PHRASE) out.errors.push(`execute requires --confirm-execute ${EXECUTE_CONFIRM_PHRASE}`);
    const e = out.expect;
    if (e.copy === undefined || e.reconcile === undefined || e.totals === undefined || e.conflicts === undefined || e.plan === undefined) {
      out.errors.push("execute requires --expect-copy, --expect-reconcile, --expect-totals, --expect-conflicts and --expect-plan from the approved dry run");
    }
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

/** A plain-text summary: counts and ids only. */
export function summarize(report: CutoverReport): string {
  const block = (label: string, c: CutoverCounts) => {
    const e = expectedFrom(c);
    return [
      `── ${label}`,
      `legacy obligations total            ${c.obligations}  (businesses ${c.businesses})`,
      `already represented in ledger       ${c.alreadyCopied}`,
      `missing from ledger / to copy       ${e.copy}  (OPEN ${c.uncopied.OPEN}, MET ${c.uncopied.MET}, RELEASED ${c.uncopied.RELEASED}; recurring ${c.uncopied.recurring})`,
      `copied, later done (MET)            ${c.drift.metNotSettled}`,
      `copied, later released              ${c.drift.releasedNotReleased}`,
      `copied, later re-priced / re-dated  ${c.drift.amountChanged} / ${c.drift.dueAtChanged}`,
      `copied, later renamed / note / snooze ${c.drift.renamed} / ${c.drift.noteChanged} / ${c.drift.followUpToCopy}`,
      `to reconcile (will be synced)       ${e.reconcile}`,
      `conflicts (payment truth blocks)    ${c.conflicts.length}`,
      `ambiguous                           ${c.ambiguous.length}`,
      `invalid / unsupported               ${c.invalid.length}`,
      `recurring commitments with a total  ${e.totals}`,
      `plan: commitments create/update     ${c.plan.commitmentsToCreate} / ${c.plan.commitmentsToUpdate}`,
      `plan: installments create/update    ${c.plan.installmentsToCreate} / ${c.plan.installmentsToUpdate}`,
      `plan: workflow rows create/update   ${c.plan.workflowRowsToCreate} / ${c.plan.workflowRowsToUpdate}`,
      `plan: audit events                  ${c.plan.auditEventsToWrite}`,
      `plan: PAYMENTS TO CREATE            ${c.plan.paymentsToCreate}`,
      `approve with: --expect-copy ${e.copy} --expect-reconcile ${e.reconcile} --expect-totals ${e.totals} --expect-conflicts ${e.conflicts} --expect-plan '${JSON.stringify(e.plan)}'`,
    ].join("\n");
  };
  const lines = [
    `mode ${report.mode} · read-only ${report.readOnly} · role ${report.role.user} (superuser ${report.role.superuser}, bypassRls ${report.role.bypassRls}, discovery ${report.role.discovery})`,
    block("before", report.before),
  ];
  if (report.effect) lines.push(`── proven inside the write transaction  payments ${report.effect.payments} · allocations ${report.effect.allocations} · legacy rows ${report.effect.obligations} · commitments +${report.effect.commitmentsCreated} · installments +${report.effect.installmentsCreated} · workflow +${report.effect.workflowRowsCreated} · audit +${report.effect.auditEvents} · totals-only rows verified ${report.effect.totalsOnlyCommitmentsVerified}`);
  if (report.applied) lines.push(`── applied  copied ${report.applied.copied} · synced ${report.applied.synced} · totals cleared ${report.applied.totalsCleared}`);
  if (report.after) lines.push(block("after", report.after));
  return lines.join("\n");
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
      expect:
        args.mode === "execute"
          ? { copy: args.expect.copy!, reconcile: args.expect.reconcile!, totals: args.expect.totals!, conflicts: args.expect.conflicts!, plan: args.expect.plan! }
          : undefined,
    });
    console.log(summarize(report));
    console.log(JSON.stringify(report, null, 2));
    if (args.jsonOut) writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));
    const after = report.after ?? report.before;
    const outstanding = after.uncopied.OPEN + after.uncopied.MET + after.uncopied.RELEASED + after.recurringWithTotalAmount;
    if (report.mode === "execute" && outstanding > 0) {
      console.error("cutover NOT complete — rows remain; do not enable SECRETARY_LEDGER_STORE");
      process.exit(1);
    }
  } catch (e) {
    if (e instanceof CutoverRefusedError) {
      console.error(`REFUSED: ${e.message}`);
      process.exit(3);
    }
    throw e;
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
