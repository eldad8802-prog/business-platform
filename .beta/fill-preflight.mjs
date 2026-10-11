// Fills ops/evidence/beta-cohort-enrollment-preflight.sql with every migration on main before this one.
// Run once when the file is (re)generated: node .beta/fill-preflight.mjs. Idempotent only on the template.
import fs from "node:fs";

const MIG = "20261017090000_beta_cohort_enrollment";
const FILE = "ops/evidence/beta-cohort-enrollment-preflight.sql";
const names = fs.readdirSync("prisma/migrations").filter((n) => /^2/.test(n) && n < MIG).sort();
const src = fs.readFileSync(FILE, "utf8");
if (!src.includes("@@LIST@@")) throw new Error("already filled");
const out = src
  .replaceAll("@@N@@", String(names.length))
  .replace("@@LIST@@", names.map((n) => `    ('${n}')`).join(",\n"));
fs.writeFileSync(FILE, out);
console.log(`${names.length} names, last ${names.at(-1)}`);
