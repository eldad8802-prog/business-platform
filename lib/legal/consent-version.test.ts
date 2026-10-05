/**
 * The recorded consent version must name the text the pages actually show.
 *   npx tsx lib/legal/consent-version.test.ts
 */
import fs from "fs";
import path from "path";

import { PRIVACY_LAST_UPDATED, TERMS_LAST_UPDATED } from "./consent-version";

let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HEBREW_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];

/** "עודכן לאחרונה: 4 ביוני 2026" → "2026-06-04" */
function printedDate(file: string): string | null {
  const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const m = src.match(/עודכן לאחרונה:\s*(\d{1,2})\s+ב([א-ת]+)\s+(\d{4})/);
  if (!m) return null;
  const month = HEBREW_MONTHS.indexOf(m[2]) + 1;
  if (month === 0) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const terms = printedDate("app/(corporate)/terms/page.tsx");
const privacy = printedDate("app/(corporate)/privacy/page.tsx");
ok("terms page prints a last-updated date", terms !== null);
ok("privacy page prints a last-updated date", privacy !== null);
ok("TERMS_LAST_UPDATED matches the terms page", terms === TERMS_LAST_UPDATED, `page ${terms}, constant ${TERMS_LAST_UPDATED}`);
ok("PRIVACY_LAST_UPDATED matches the privacy page", privacy === PRIVACY_LAST_UPDATED, `page ${privacy}, constant ${PRIVACY_LAST_UPDATED}`);

if (failed > 0) process.exit(1);
console.log("\nPASS");
