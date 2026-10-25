/**
 * Bank file import (B1) — the old statement upload is routed, never bypassed. Static, no database.
 *
 * For a business with `bank_file_import` ON, a statement must not be uploadable without an account (owner,
 * 2026-10-25): the old screen's upload button opens /payables/bank/import, and the old upload API refuses —
 * also when the flag cannot be resolved. With the flag OFF the old screen and API behave exactly as before.
 * The flag state itself (ON / OFF per business, as the runtime) is proven in .bfi/battery.ts.
 *
 * Run: npx tsx lib/services/bank-file-import/old-upload-routing.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra && !cond ? " — " + extra : ""}`);
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Code only: comments removed, so a sentence about the code cannot satisfy a check about it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const route = code(read("app/api/payables/bank-lines/upload/route.ts"));
const page = code(read("app/(shell)/payables/bank/page.tsx"));
const http = code(read("lib/services/bank-file-import/http.ts"));

console.log("The old upload API");
const gate = route.indexOf("await bankFileImportState(user.businessId)");
const body = route.indexOf("readJsonBody(req)");
const upload = route.indexOf("obs.uploadStatement(");
check("asks the flag state, from the session's business", gate > 0);
check("before it reads the body or uploads anything", gate > 0 && gate < body && gate < upload, `gate=${gate} body=${body} upload=${upload}`);
check("refuses unless the state is exactly OFF (ON and UNKNOWN both refuse)", /if \(importState !== "OFF"\)\s*\{[\s\S]*?return NextResponse\.json\(/.test(route));
check("ON answers 409 BANK_FILE_IMPORT_REQUIRED, UNKNOWN answers 503", route.includes(`"BANK_FILE_IMPORT_REQUIRED"`) && /status: importState === "ON" \? 409 : 503/.test(route));
check("the upload call itself is unchanged", route.includes("obs.uploadStatement({") && route.includes("sourceBankAccountId: optionalPositiveInt(body, \"sourceBankAccountId\")"));

console.log("The flag state");
check("bankFileImportState resolves the bank_file_import flag", /resolveFeatureAccess\(businessId, PLATFORM_FEATURE_KEYS\.BANK_FILE_IMPORT\)/.test(http));
check("a resolution failure is UNKNOWN, never OFF", /catch\s*\{\s*return "UNKNOWN";\s*\}/.test(http));

console.log("The old screen");
check("asks whether bank file import is open (its status route answers 404 while OFF)", page.includes(`fetch("/api/payables/bank-import"`) && page.includes("setFileImportOpen(r.ok)"));
check("open ⇒ the upload button is a link to /payables/bank/import", /fileImportOpen \?\s*\(\s*<Link className=\{styles\.buttonPrimary\} href="\/payables\/bank\/import">/.test(page));
check("closed ⇒ the original upload button, unchanged", page.includes(`onClick={() => setMode(mode === "upload" ? "none" : "upload")}`));
check("the old upload form never renders while bank file import is open", page.includes(`{mode === "upload" && !fileImportOpen && <UploadForm`));
check("the manual line entry is untouched", page.includes(`onClick={() => setMode(mode === "manual" ? "none" : "manual")}`));

console.log("No other way in");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const callers = ["app", "lib", "components", "features"]
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => /\buploadStatement\s*\(/.test(code(readFileSync(f, "utf8"))))
  .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"))
  .filter((f) => f !== "lib/services/payables/payables-observation.service.ts");
check("the statement upload is called from exactly one place: the guarded route", callers.length === 1 && callers[0] === "app/api/payables/bank-lines/upload/route.ts", JSON.stringify(callers));

const sources = ["app", "lib", "components", "features"].flatMap((d) => walk(join(ROOT, d)));
const rel = (f: string) => f.slice(ROOT.length + 1).replace(/\\/g, "/");
const writers = sources
  .filter((f) => /externalTransaction\.(create|createMany|upsert)\s*\(|INSERT INTO "ExternalTransaction"/.test(code(readFileSync(f, "utf8"))))
  .map(rel)
  .sort();
check(
  "bank lines are inserted in exactly two places: the payables service and bank file import",
  JSON.stringify(writers) === JSON.stringify(["lib/services/bank-file-import/bank-file-import.service.ts", "lib/services/payables/payables-observation.service.ts"]),
  JSON.stringify(writers)
);
const ingestCallers = sources
  .filter((f) => /\bingestObservations\s*\(/.test(code(readFileSync(f, "utf8"))))
  .map(rel)
  .filter((f) => f !== "lib/services/payables/payables-observation.service.ts");
check("the payables insert (ingestObservations) is reached only from inside its own service", ingestCallers.length === 0, JSON.stringify(ingestCallers));
const serverActions = sources
  .filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8")) && /payables-observation\.service/.test(readFileSync(f, "utf8")))
  .map(rel);
check("no server action reaches the payables bank-line service", serverActions.length === 0, JSON.stringify(serverActions));
const manual = code(read("lib/services/payables/payables-observation.service.ts"));
check(
  "the only other ingest is the manual single line, under its own source (OWNER_ENTRY), never OWNER_UPLOAD",
  /export async function recordObservationManually[\s\S]*?return ingestObservations\(\{[\s\S]*?source: "OWNER_ENTRY"/.test(manual)
);

console.log(`\n${total - failures}/${total} passed`);
if (failures) process.exit(1);
