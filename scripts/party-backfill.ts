/**
 * Manual Party Backfill entrypoint — Phase 1 T2c.
 *
 * Gated, fail-closed, SCRIPT-ONLY. Never import this from app/route/runtime code.
 *
 *   DRY-RUN (default — no persistence):
 *     npx tsx scripts/party-backfill.ts
 *     npx tsx scripts/party-backfill.ts --mode dry-run --batch-size 200
 *
 *   EXECUTE (requires BOTH the mode flag AND the confirm phrase):
 *     npx tsx scripts/party-backfill.ts --mode execute \
 *       --confirm-execute PARTY_BACKFILL_EXECUTE
 *
 * Guards (conservative by design):
 *   - Default mode is dry-run; anything ambiguous fails closed.
 *   - execute needs `--mode execute` AND `--confirm-execute PARTY_BACKFILL_EXECUTE`.
 *   - PRODUCTION execute is BLOCKED outright in T2c (no production runs by design).
 *     `--allow-production-execute` is intentionally NOT honored here.
 *   - DB-backed deps + the Party migrations-applied check are NOT wired in T2c:
 *     `loadBackfillDeps()` throws explicitly (no silent bypass, no real DB run).
 *
 * T2c does NOT add: real DB/backfill run · migration run · route/API/UI/cron ·
 * Billing/intake/runtime wiring · T3 anchor upgrade. The resolution / runner /
 * verification logic is reused as-is.
 */

import {
  runBackfill,
  type BackfillDeps,
  type BackfillReport,
} from "@/lib/services/party/party-backfill.service";

export const EXECUTE_CONFIRM_PHRASE = "PARTY_BACKFILL_EXECUTE";

export type BackfillScriptMode = "dry-run" | "execute";

export type NodeEnvLike = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export type ParsedArgs = {
  mode: BackfillScriptMode;
  confirmExecute: string | null;
  allowProductionExecute: boolean;
  batchSize?: number;
  oversizedThreshold?: number;
  errors: string[];
};

export type GateDecision = {
  effectiveMode: BackfillScriptMode;
  allowed: boolean;
  willPersist: boolean;
  reasons: string[];
};

const VALUE_FLAGS = new Set([
  "--mode",
  "--confirm-execute",
  "--batch-size",
  "--oversized-threshold",
]);
const BOOLEAN_FLAGS = new Set(["--allow-production-execute", "--help"]);

function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  errors: string[]
): number | undefined {
  if (raw === undefined) {
    errors.push(`${flag} requires a value`);
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${flag} must be a positive integer (got "${raw}")`);
    return undefined;
  }
  return n;
}

/** Pure argv parser. Unknown/invalid tokens accumulate in `errors` (fail closed). */
export function parseArgs(argv: string[]): ParsedArgs {
  const errors: string[] = [];
  let mode: BackfillScriptMode = "dry-run";
  let modeSeen = false;
  let confirmExecute: string | null = null;
  let allowProductionExecute = false;
  let batchSize: number | undefined;
  let oversizedThreshold: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === "--allow-production-execute") allowProductionExecute = true;
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      i += 1;
      switch (token) {
        case "--mode":
          if (value === "dry-run" || value === "execute") {
            mode = value;
            modeSeen = true;
          } else {
            errors.push(`--mode must be "dry-run" or "execute" (got "${value ?? ""}")`);
          }
          break;
        case "--confirm-execute":
          confirmExecute = value ?? null;
          if (value === undefined) errors.push("--confirm-execute requires a value");
          break;
        case "--batch-size":
          batchSize = parsePositiveInt(value, "--batch-size", errors);
          break;
        case "--oversized-threshold":
          oversizedThreshold = parsePositiveInt(value, "--oversized-threshold", errors);
          break;
      }
      continue;
    }
    errors.push(`unknown argument: ${token}`);
  }

  void modeSeen; // default is dry-run whether or not --mode was passed
  return {
    mode,
    confirmExecute,
    allowProductionExecute,
    batchSize,
    oversizedThreshold,
    errors,
  };
}

export function isProductionEnv(env: NodeEnvLike): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

/**
 * Pure gate. Decides whether the run is allowed and whether it will persist.
 * Fail-closed: invalid args, missing confirm, or production execute → not allowed.
 */
export function evaluateGate(parsed: ParsedArgs, env: NodeEnvLike): GateDecision {
  if (parsed.errors.length > 0) {
    return {
      effectiveMode: "dry-run",
      allowed: false,
      willPersist: false,
      reasons: ["invalid arguments — failing closed", ...parsed.errors],
    };
  }

  if (parsed.mode === "dry-run") {
    return {
      effectiveMode: "dry-run",
      allowed: true,
      willPersist: false,
      reasons: ["dry-run: rolled back, no persistence"],
    };
  }

  // execute requested — double confirmation required.
  if (parsed.confirmExecute !== EXECUTE_CONFIRM_PHRASE) {
    return {
      effectiveMode: "execute",
      allowed: false,
      willPersist: false,
      reasons: [
        `execute requires --confirm-execute ${EXECUTE_CONFIRM_PHRASE} (got "${parsed.confirmExecute ?? ""}")`,
      ],
    };
  }

  // Production execute is hard-blocked in T2c (conservative; no prod runs by design).
  if (isProductionEnv(env)) {
    return {
      effectiveMode: "execute",
      allowed: false,
      willPersist: false,
      reasons: [
        "production execute is BLOCKED in T2c — no production runs by design",
        "--allow-production-execute is intentionally not honored in T2c",
      ],
    };
  }

  return {
    effectiveMode: "execute",
    allowed: true,
    willPersist: true,
    reasons: ["execute confirmed (non-production)"],
  };
}

/**
 * DB-backed deps factory — NOT wired in T2c. Throws so a direct invocation fails
 * closed instead of silently doing nothing or touching the DB. Wiring real
 * `BackfillDeps` (prisma reads) AND the Party migrations-applied guard is a later
 * ticket; do that before enabling real runs.
 */
export async function loadBackfillDeps(): Promise<BackfillDeps> {
  throw new Error(
    "[party-backfill] DB-backed deps are NOT wired in T2c. " +
      "Real backfill execution and the Party migrations-applied check are a later ticket. " +
      "Wire BackfillDeps to prisma + add the migrations-applied guard before enabling real runs."
  );
}

/** Human-readable run report (also surfaces whether persistence happened). */
export function renderReport(report: BackfillReport, willPersist: boolean): string {
  const t = report.totals;
  const h = report.health;
  const lines = [
    "--- party backfill report ---",
    `mode: ${report.mode}`,
    `businesses processed: ${t.businesses}`,
    `failed businesses: ${t.failedBusinesses}`,
    `batches: ${t.batches} (failed: ${t.batchesFailed})`,
    `customers/leads read: ${t.customersRead}/${t.leadsRead}`,
    `applied/noop/singleton/conflict: ${t.applied}/${t.noop}/${t.singleton}/${t.conflict}`,
    `signal/anchor claims: ${t.signalClaims}/${t.anchorClaims}`,
    `health: anomalies=${h.anomalyCount} multiPartySignals=${h.multiPartySignals} ` +
      `oversized=${h.oversizedParties} conflictAnchors=${h.conflictAnchors}`,
    h.anyInvariantViolation
      ? "⚠ INVARIANT VIOLATION DETECTED (signal → >1 party) — investigate before trusting results"
      : "invariant violations: none",
    willPersist
      ? "PERSISTENCE: COMMITTED (execute mode — changes were written)"
      : "PERSISTENCE: none (dry-run — nothing was written)",
  ];
  return lines.join("\n");
}

export type BackfillRunner = typeof runBackfill;

/**
 * Orchestrator. Returns a process exit code (0 ok, 1 blocked/failed). The deps
 * factory and runner are injectable for testing; defaults are the real (throwing)
 * deps factory and `runBackfill`.
 */
export async function main(
  argv: string[],
  env: NodeEnvLike,
  io: {
    depsFactory?: () => Promise<BackfillDeps>;
    runner?: BackfillRunner;
    log?: (line: string) => void;
  } = {}
): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const parsed = parseArgs(argv);
  const decision = evaluateGate(parsed, env);

  log(
    `[party-backfill] requested=${parsed.mode} effective=${decision.effectiveMode} ` +
      `allowed=${decision.allowed} willPersist=${decision.willPersist}`
  );
  for (const reason of decision.reasons) log(`  - ${reason}`);

  if (!decision.allowed) {
    log("[party-backfill] BLOCKED — failing closed. Nothing ran.");
    return 1;
  }

  const depsFactory = io.depsFactory ?? loadBackfillDeps;
  const runner = io.runner ?? runBackfill;
  const deps = await depsFactory();
  const report = await runner(deps, {
    mode: decision.effectiveMode,
    batchSize: parsed.batchSize,
    oversizedThreshold: parsed.oversizedThreshold,
  });
  log(renderReport(report, decision.willPersist));
  return 0;
}

// Run only when invoked directly (never on import).
if (require.main === module) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
