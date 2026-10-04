// M6 battery lab — Production's row-level security on a `prisma db push` schema.
//
// Replays, in migration order, every RLS / policy / role statement of every migration except the
// ones named on the command line (applied verbatim beforehand), as .tx3a1/exact-grant-battery does.
// A statement that cannot apply on a pushed schema (an object it needs is not there) is skipped and
// counted; the script then ASSERTS the tables the M6 battery relies on are FORCE-RLS'd with
// policies, so a silent replay gap fails the lab instead of weakening it.
//
//   node .m6/replay-rls.mjs <ownerUrl> [skipMigrationName ...]
import { readdirSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const [ownerUrl, ...skip] = process.argv.slice(2);
const db = new PrismaClient({ datasourceUrl: ownerUrl });
let applied = 0;
let skipped = 0;
for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
  if (skip.includes(d)) continue;
  let sql;
  try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
  const stmts = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean);
  for (const st of stmts) {
    if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(st)) continue;
    try { await db.$executeRawUnsafe(st); applied++; } catch { skipped++; }
  }
}
const must = ["Lead", "Customer", "IntakeEvent", "IntakeNormalizedEvent", "IdentityLink", "IdentityProposal", "LeadLifecycleEvent", "AcquisitionConnection", "Business"];
const rows = await db.$queryRawUnsafe(
  `SELECT c.relname, c.relforcerowsecurity AS f, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS n
     FROM pg_class c WHERE c.relname = ANY($1::text[]) AND c.relkind = 'r'`, must);
const bad = must.filter((t) => { const r = rows.find((x) => x.relname === t); return !r || !r.f || r.n === 0; });
console.log(`RLS replay: ${applied} statements applied, ${skipped} not applicable on the pushed schema`);
await db.$disconnect();
if (bad.length) { console.error(`RLS replay left these without FORCE RLS + policies: ${bad.join(", ")}`); process.exit(1); }
console.log(`FORCE RLS + policies present on: ${must.join(", ")}`);
