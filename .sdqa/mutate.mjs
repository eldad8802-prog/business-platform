// Service Desk QA lists — mutation run of the migration's guards against .sdqa/battery.ts. Each mutant is ONE textual
// change of 20261129090000's migration.sql, applied to a fresh copy of an M1 lab database (template <m1-db>, without the
// migration); the battery must FAIL on every mutant (killed). The original is applied the same way and must pass.
//
//   node .sdqa/mutate.mjs <m1-template-db>
//
// env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD; psql on PATH. Synthetic only.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEMPLATE = process.argv[2];
if (!TEMPLATE) throw new Error("usage: node .sdqa/mutate.mjs <m1-template-db>");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MIG = path.join(ROOT, "prisma/migrations/20261129090000_service_desk_qa_lists/migration.sql");
const SRC = fs.readFileSync(MIG, "utf8");
const H = `${process.env.PGHOST}:${process.env.PGPORT}`;
const LP = process.env.LAB_PASSWORD;

const MUTANTS = [
  ["version holds its declared checks (count not checked)", `IF n <> NEW."itemCount" OR r <> NEW."requiredCount" OR maxpos IS DISTINCT FROM NEW."itemCount" THEN`, `IF false THEN`],
  ["a committed version gains a check", `i."listVersion" = NEW."listVersion") >= v_count THEN`, `i."listVersion" = NEW."listVersion") >= v_count + 1000 THEN`],
  ["the head's revision may skip", `IF NEW."revision" <> OLD."revision" + 1\n`, `IF false\n`],
  ["a head change without its journal event", `IF NOT FOUND OR e."listVersion" <> h."currentVersion"`, `IF false AND e."listVersion" <> h."currentVersion"`],
  ["a version that is not the head's current", `IF v_current IS NULL OR v_current <> NEW."version" THEN`, `IF v_current IS NULL THEN`],
  ["a version can be updated by its owner", `IF public.service_qa_in_erasure(TG_RELID)\n       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)\n       AND NEW."name" IS NULL`, `IF true OR public.service_qa_in_erasure(TG_RELID)\n       AND (to_jsonb(NEW) - erasable) = (to_jsonb(OLD) - erasable)\n       AND NEW."name" IS NULL`],
  ["a case takes an old / archived version", `IF NOT FOUND OR l."archivedAt" IS NOT NULL OR l."currentVersion" <> NEW."qaListVersion" THEN`, `IF NOT FOUND THEN`],
  ["a choice keeps the QA completion", `IF NEW."version" <> OLD."version" + 1 OR NEW."qaCompletedAt" IS NOT NULL THEN`, `IF NEW."version" <> OLD."version" + 1 THEN`],
  ["a choice moves the status / is fixed past QA", `IF OLD."status"::text IN ('READY', 'WORK_DONE', 'DELIVERED', 'CLOSED', 'CANCELLED', 'ABANDONED')\n     OR NEW."status" <> OLD."status" OR OLD."erasedAt" IS NOT NULL THEN`, `IF OLD."erasedAt" IS NOT NULL THEN`],
  ["a choice journaled with another list in the payload", `AND (e."payload" ->> 'listId') IS NOT DISTINCT FROM NEW."qaListId"::text`, `AND true`],
  ["QA-complete without a complete record against the list", `OR r."listVersion" IS DISTINCT FROM c."qaListVersion" OR NOT r."completed" THEN`, `OR r."listVersion" IS DISTINCT FROM c."qaListVersion" THEN`],
  ["a record outside QA", `IF c.status <> 'QA' THEN`, `IF false THEN`],
  ["a record against another checklist than the case's", `IF NEW."listId" IS DISTINCT FROM c."qaListId" OR NEW."listVersion" IS DISTINCT FROM c."qaListVersion" THEN`, `IF false THEN`],
  ["missing REQUIRED checks not re-derived", `IF v_items IS DISTINCT FROM NEW."itemCount" OR v_missing <> NEW."requiredMissing" THEN`, `IF v_items IS DISTINCT FROM NEW."itemCount" THEN`],
  ["pass / fail counts not re-derived", `IF n <> NEW."resultCount" OR p <> NEW."passCount" OR f <> NEW."failCount" OR rf <> NEW."requiredFailed" THEN`, `IF n <> NEW."resultCount" THEN`],
  ["a result's REQUIRED flag not the version's", `IF v_required IS DISTINCT FROM NEW."required" THEN`, `IF false THEN`],
  ["a committed record gains a result", `x."recordId" = NEW."recordId") >= r."resultCount" THEN`, `x."recordId" = NEW."recordId") >= r."resultCount" + 1000 THEN`],
  ["the erasure keeps the labels", `UPDATE public."ServiceQaListItem" SET "label" = NULL, "erasedAt" = CURRENT_TIMESTAMP`, `UPDATE public."ServiceQaListItem" SET "erasedAt" = "erasedAt"`],
  ["the erasure runs for a business not being deleted", `IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business\n                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN\n    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_ERASURE_NOT_DELETING`, `IF false THEN\n    RAISE EXCEPTION USING ERRCODE = 'DZS08', MESSAGE = 'SERVICE_QA_ERASURE_NOT_DELETING`],
  ["the lists are not FORCE row-level secure", `ALTER TABLE "ServiceQaList" FORCE ROW LEVEL SECURITY;`, `ALTER TABLE "ServiceQaList" NO FORCE ROW LEVEL SECURITY;`],
  ["the runtime may UPDATE a version", `GRANT SELECT, INSERT ON "ServiceQaListVersion", "ServiceQaListItem"`, `GRANT SELECT, INSERT, UPDATE ON "ServiceQaListVersion", "ServiceQaListItem"`],
  ["the event's counts are not the version's", `OR v."itemCount" IS NULL OR v."itemCount" <> NEW."itemCount" OR v."requiredCount" <> NEW."requiredCount"`, `OR v."itemCount" IS NULL`],
];

const psqlSuper = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.SUPER, "-d", "postgres", "-c", sql], { stdio: ["ignore", "ignore", "ignore"] });
function battery(db, label, text) {
  psqlSuper(`DROP DATABASE IF EXISTS ${db}`);
  psqlSuper(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE} OWNER lab_owner`);
  const file = path.join(ROOT, ".sdqa", `.mutant-${db}.sql`);
  fs.writeFileSync(file, text);
  const owner = `postgresql://lab_owner:${LP}@${H}/${db}`;
  const ap = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", owner, "-f", file], { encoding: "utf8" });
  fs.rmSync(file);
  if (ap.status !== 0) return { label, applied: false, out: (ap.stderr || "").slice(-200) };
  const rt = `postgresql://app_runtime_prod:${LP}@${H}/${db}`;
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, ".sdqa/battery.ts")], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OWNER_URL: owner, DATABASE_URL: `${rt}?connection_limit=10`, DIRECT_URL: rt, TASK_REQUEST_HMAC_KEY: "sdqa-mutant-hmac-key-0123456789abcdef", TASK_REQUEST_HMAC_KEY_ID: "sdqa-m", AUTH_TOKEN_SECRET: "sdqa-mutant-auth-secret-0123456789abcdef", CHECKPOINT_DISABLE: "1" },
  });
  psqlSuper(`DROP DATABASE IF EXISTS ${db}`);
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout ?? "");
  const failed = (r.stdout ?? "").split("\n").filter((l) => l.includes("[FAIL]")).map((l) => l.trim().slice(7, 60));
  return { label, applied: true, passed: m ? Number(m[1]) : -1, failedN: m ? Number(m[2]) : -1, failed };
}

const base = battery("qa_mut_orig", "ORIGINAL", SRC);
console.log(`ORIGINAL: ${base.passed} passed, ${base.failedN} failed`);
if (!base.applied || base.failedN !== 0) { console.log("the original is not green — stop"); process.exit(1); }
let killed = 0;
for (const [i, [label, from, to]] of MUTANTS.entries()) {
  if (!SRC.includes(from)) { console.log(`  [NOT FOUND] M${i + 1} ${label}`); continue; }
  const r = battery(`qa_mut_${i + 1}`, label, SRC.replace(from, to));
  const dead = !r.applied || r.failedN > 0 || r.passed < 0;
  if (dead) killed++;
  console.log(`  [${dead ? "KILLED" : "SURVIVED"}] M${i + 1} ${label}${r.applied ? ` — ${r.failedN} failed: ${r.failed.slice(0, 3).join(" | ")}` : ` — not applied: ${r.out}`}`);
}
console.log(`\nmutants: ${MUTANTS.length}, killed ${killed}`);
