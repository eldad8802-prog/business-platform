// WP1 A-16 enforcement helper.
// Reads an ESLint JSON report (path in argv[2]) and fails (exit 1) if ANY
// jsx-a11y rule fired. Used by the a11y-changed-files CI job to enforce
// accessibility on CHANGED files only, while jsx-a11y stays `warn` in the base
// config so a full lint never fails on grandfathered legacy code.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node check-jsx-a11y.mjs <eslint-json-report>");
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, "utf8"));
const issues = report.flatMap((f) =>
  (f.messages || [])
    .filter((m) => m.ruleId && m.ruleId.startsWith("jsx-a11y/"))
    .map((m) => `${f.filePath}:${m.line}:${m.column} ${m.ruleId} — ${m.message}`)
);

if (issues.length > 0) {
  console.error(
    "New jsx-a11y issues in changed files — fix them, or add a justified\n" +
      "`eslint-disable` (documented exception). Legacy files are not checked."
  );
  for (const i of issues) console.error("  " + i);
  process.exit(1);
}

console.log("No new jsx-a11y issues in changed files.");
