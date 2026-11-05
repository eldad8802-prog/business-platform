/**
 * A0 — records the PURE baselines (golden + PDF render) from the code as it is.
 *
 * Manual, deliberate, never run by CI. It refuses unless:
 *   - invoked with --write;
 *   - the working tree has no change outside .billing-a0/ (the baseline must
 *     describe committed, unmodified code — never code edited to make a test pass).
 *
 * It stamps the source commit and the runtime into the file, so the provenance of
 * every expected value is visible in review. The database battery records its own
 * baseline (battery.mts --record) under the same rule.
 *
 *   npx -y -p node@22 node node_modules/tsx/dist/cli.mjs .billing-a0/record-baseline.mts --write
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeObservations } from "./golden-observations";
import { computePdfRenderObservations } from "./pdf-render-observations";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (!process.argv.includes("--write")) {
  console.log("refusing: pass --write to record the baseline deliberately");
  process.exit(2);
}

const dirty = git(["status", "--porcelain"])
  .split("\n")
  .filter(Boolean)
  .filter((l) => !l.slice(3).startsWith(".billing-a0/"));
if (dirty.length > 0) {
  console.log("refusing: the working tree has changes outside .billing-a0/ —");
  for (const l of dirty) console.log("  " + l);
  process.exit(2);
}

const meta = {
  sourceCommit: git(["rev-parse", "HEAD"]),
  sourceCommitSubject: git(["log", "-1", "--format=%s"]),
  recordedAt: new Date().toISOString(),
  recordedWith: `node ${process.version} ${process.platform}`,
  note: "Recorded by .billing-a0/record-baseline.mts from unmodified code. Never edited by hand, never rewritten by a test.",
};

mkdirSync(path.join(here, "baseline"), { recursive: true });

const observations = await computeObservations();
writeFileSync(path.join(here, "baseline", "golden.json"), JSON.stringify({ meta, observations }, null, 2) + "\n");
console.log(`golden.json: ${Object.keys(observations).length} observations`);

if (process.argv.includes("--pdf")) {
  const pdf = await computePdfRenderObservations();
  writeFileSync(path.join(here, "baseline", "pdf-render.json"), JSON.stringify({ meta, observations: pdf }, null, 2) + "\n");
  console.log(`pdf-render.json: ${Object.keys(pdf).length} observations`);
}
