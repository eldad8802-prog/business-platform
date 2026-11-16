// Service Desk QA track defaults — mutation run of the migration's guards against .sdqad/battery.ts. Each mutant is ONE
// textual change of 20261130100000's migration.sql, applied to a fresh copy of a QA lists lab database (template <qa-db>,
// without this migration); the battery must FAIL on every mutant (killed). The original is applied the same way and must
// pass.
//
//   node .sdqad/mutate.mjs <qa-template-db> [n,n,…]
//
// env: PGHOST, PGPORT, SUPER, PGPASSWORD (superuser), LAB_PASSWORD; psql on PATH. Synthetic only.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEMPLATE = process.argv[2];
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",").map(Number)) : null;
if (!TEMPLATE) throw new Error("usage: node .sdqad/mutate.mjs <qa-template-db>");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const MIG = path.join(ROOT, "prisma/migrations/20261130100000_service_qa_track_defaults/migration.sql");
const SRC = fs.readFileSync(MIG, "utf8");
const H = `${process.env.PGHOST}:${process.env.PGPORT}`;
const LP = process.env.LAB_PASSWORD;

const MUTANTS = [
  ["a revision may skip or repeat", `IF NEW."revision" <> coalesce(v_last, 0) + 1 THEN`, `IF false THEN`],
  ["an archived list may become a default", `IF NOT FOUND OR l."archivedAt" IS NOT NULL THEN`, `IF NOT FOUND THEN`],
  ["the owner may rewrite a row", `IF public.service_qa_in_erasure(TG_RELID)\n       AND (to_jsonb(NEW) - scrubbable)`, `IF true OR public.service_qa_in_erasure(TG_RELID)\n       AND (to_jsonb(NEW) - scrubbable)`],
  ["the owner may delete a row", `IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;`, `RETURN OLD;`],
  ["a default without an acting user", `IF NEW."actorUserId" IS NULL THEN\n      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_TRACK_DEFAULT_NEW`, `IF false THEN\n      RAISE EXCEPTION USING ERRCODE = 'DZS09', MESSAGE = 'SERVICE_QA_TRACK_DEFAULT_NEW`],
  ["a business being deleted may write", `IF NOT public.service_ui_business_writable(NEW."businessId") THEN`, `IF false THEN`],
  ["not FORCE row-level secure", `ALTER TABLE "ServiceQaTrackDefault" FORCE ROW LEVEL SECURITY;`, `ALTER TABLE "ServiceQaTrackDefault" NO FORCE ROW LEVEL SECURITY;`],
  ["the runtime may UPDATE / DELETE", `GRANT SELECT, INSERT ON "ServiceQaTrackDefault" TO app_runtime;`, `GRANT SELECT, INSERT, UPDATE, DELETE ON "ServiceQaTrackDefault" TO app_runtime;`],
  ["the erasure runs for a business not being deleted", `IF NOT EXISTS (SELECT 1 FROM public."Business" b WHERE b."id" = v_business\n                   AND (b."deletionRequestedAt" IS NOT NULL OR b."deletedAt" IS NOT NULL)) THEN`, `IF false THEN`],
  ["the erasure keeps who acted", `SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL\n   WHERE "businessId" = v_business AND`, `SET "requestDigest" = "requestDigest"\n   WHERE "businessId" = v_business AND`],
  ["a first revision without a list", `CHECK ("revision" > 1 OR "listId" IS NOT NULL)`, `CHECK (true)`],
  ["the select policy is not per tenant", `CREATE POLICY service_qa_track_default_tenant_select ON "ServiceQaTrackDefault" FOR SELECT\n  USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int);`, `CREATE POLICY service_qa_track_default_tenant_select ON "ServiceQaTrackDefault" FOR SELECT\n  USING (true);`],
  ["a deleted user blocks (FK action refused)", `IF pg_trigger_depth() > 1 AND NEW."actorUserId" IS NULL`, `IF false AND NEW."actorUserId" IS NULL`],
  ["a SYSTEM actor", `CONSTRAINT "ServiceQaTrackDefault_by_owner" CHECK ("actor" = 'OWNER_USER'),`, `CONSTRAINT "ServiceQaTrackDefault_by_owner" CHECK (true),`],
  ["any track token", `CHECK ("track" IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'))`, `CHECK ("track" <> '')`],
  ["the list of another business (FK not tenant-scoped)", `FOREIGN KEY ("businessId", "listId") REFERENCES "ServiceQaList"("businessId", "id")`, `FOREIGN KEY ("listId") REFERENCES "ServiceQaList"("id")`],
];

const psqlSuper = (sql) => execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", process.env.SUPER, "-d", "postgres", "-c", sql], { stdio: ["ignore", "ignore", "ignore"] });
function battery(db, label, text) {
  psqlSuper(`DROP DATABASE IF EXISTS ${db}`);
  psqlSuper(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE} OWNER lab_owner`);
  const file = path.join(ROOT, ".sdqad", `.mutant-${db}.sql`);
  fs.writeFileSync(file, text);
  const owner = `postgresql://lab_owner:${LP}@${H}/${db}`;
  const ap = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", owner, "-f", file], { encoding: "utf8" });
  fs.rmSync(file);
  if (ap.status !== 0) { psqlSuper(`DROP DATABASE IF EXISTS ${db}`); return { label, applied: false, out: (ap.stderr || "").slice(-200) }; }
  const rt = `postgresql://app_runtime_prod:${LP}@${H}/${db}`;
  const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, ".sdqad/battery.ts")], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, OWNER_URL: owner, DATABASE_URL: `${rt}?connection_limit=10`, DIRECT_URL: rt, CHECKPOINT_DISABLE: "1" },
  });
  psqlSuper(`DROP DATABASE IF EXISTS ${db}`);
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout ?? "");
  const failed = (r.stdout ?? "").split("\n").filter((l) => l.includes("[FAIL]")).map((l) => l.trim().slice(7, 60));
  return { label, applied: true, passed: m ? Number(m[1]) : -1, failedN: m ? Number(m[2]) : -1, failed };
}

const base = battery("qad_mut_orig", "ORIGINAL", SRC);
console.log(`ORIGINAL: ${base.passed} passed, ${base.failedN} failed`);
if (!base.applied || base.failedN !== 0) { console.log("the original is not green — stop", JSON.stringify(base)); process.exit(1); }
let killed = 0;
for (const [i, [label, from, to]] of MUTANTS.entries()) {
  if (ONLY && !ONLY.has(i + 1)) continue;
  if (!SRC.includes(from)) { console.log(`  [NOT FOUND] M${i + 1} ${label}`); continue; }
  const r = battery(`qad_mut_${i + 1}`, label, SRC.replace(from, to));
  const dead = !r.applied || r.failedN > 0 || r.passed < 0;
  if (dead) killed++;
  console.log(`  [${dead ? "KILLED" : "SURVIVED"}] M${i + 1} ${label}${r.applied ? ` — ${r.failedN} failed: ${r.failed.slice(0, 3).join(" | ")}` : ` — not applied: ${r.out}`}`);
}
console.log(`\nmutants: ${ONLY ? ONLY.size : MUTANTS.length}, killed ${killed}`);
