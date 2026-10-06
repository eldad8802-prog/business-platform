// M7-A battery lab — the schema WITHOUT the M6 / M7-A models, so `db push` builds everything else and the
// REAL M6 and M7-A migrations then create their tables exactly as Production will.
//   node .m7a/strip-schema.mjs <in.prisma> <out.prisma>
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
let s = readFileSync(input, "utf8");
const MODELS = ["AcquisitionConnection", "CommerceOrder", "CommerceOrderLine", "CommerceOrderEvent", "CallActivity"];
for (const m of MODELS) {
  const a = s.indexOf(`model ${m} {`);
  if (a < 0) throw new Error(`model ${m} not found`);
  const b = s.indexOf("\n}\n", a) + 3;
  // Drop the doc comment lines directly above the model too.
  let start = a;
  while (true) {
    const prev = s.lastIndexOf("\n", start - 2);
    const line = s.slice(prev + 1, start - 1);
    if (!line.trim().startsWith("///")) break;
    start = prev + 1;
  }
  s = s.slice(0, start) + s.slice(b);
}
// Back-relation fields pointing at the stripped models.
s = s.replace(new RegExp(`\\n\\s*\\w+\\s+(${MODELS.join("|")})(\\[\\]|\\?)?(\\s+@relation\\([^)]*\\))?\\s*(?=\\n)`, "g"), "");
// M7-B/C (20261014090000): the column, index and enum value its migration adds to models that stay.
s = s.replace(/\n\s*\/\/\/ M7-B — the store order line \(source COMMERCE only; CHECK\)\.\n\s*commerceOrderLineId\s+Int\?/, "");
s = s.replace(/\n\s*@@index\(\[businessId, commerceOrderLineId\]\)/, "");
s = s.replace(/\n\s*\/\/\/ M7-B — a line of an online-store order whose SKU names exactly one active product\.\n\s*COMMERCE(?=\n)/, "");
for (const leftover of ["commerceOrderLineId", "lineLabels"]) if (s.includes(leftover)) throw new Error(`${leftover} remains`);
if (/enum OfferingDemandSource \{[^}]*COMMERCE/.test(s)) throw new Error("OfferingDemandSource.COMMERCE remains");
for (const m of MODELS) if (new RegExp(`\\b${m}\\b`).test(s)) throw new Error(`a reference to ${m} remains`);
writeFileSync(output, s);
console.log(`stripped ${MODELS.join(", ")}`);
