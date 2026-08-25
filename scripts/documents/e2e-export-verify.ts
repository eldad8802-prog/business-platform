/**
 * Wave 0A E2E verify (dev DB, run manually):
 *   npx tsx scripts/documents/e2e-export-verify.ts [businessId] [YYYY-MM]
 *
 * Builds a real accountant pack through the FIXED path (collector + bounded
 * parallel storage reads) against the current DATABASE_URL, writes the ZIP to
 * a temp file, and verifies it parses and contains the expected entries.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prisma } from "@/lib/prisma";
import { buildAccountantPackZipBuffer } from "@/lib/reports/accountant-export-zip";

/**
 * Reads entry names from the CENTRAL DIRECTORY (PK\x01\x02). Local-header
 * scanning breaks on deflated streaming entries (bit-3 data descriptors leave
 * compSize=0 in the local header); the central directory always has real sizes.
 */
function collectZipEntryNames(zipBuffer: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset + 46 <= zipBuffer.length; offset++) {
    if (
      zipBuffer[offset] !== 0x50 ||
      zipBuffer[offset + 1] !== 0x4b ||
      zipBuffer[offset + 2] !== 0x01 ||
      zipBuffer[offset + 3] !== 0x02
    ) {
      continue;
    }
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    names.push(zipBuffer.subarray(nameStart, nameStart + nameLen).toString("utf8"));
    offset = nameStart + nameLen + extraLen + commentLen - 1;
  }
  return names;
}

async function main() {
  const months = (await prisma.$queryRaw`
    SELECT "businessId", to_char(date, 'YYYY-MM') AS month, COUNT(*)::int AS records
    FROM "FinancialRecord" GROUP BY 1, 2 ORDER BY records DESC
  `) as Array<{ businessId: number; month: string; records: number }>;
  console.log("months in DB:", JSON.stringify(months));

  const businessId = Number(process.argv[2]) || months[0]?.businessId;
  const month = process.argv[3] || months.find((m) => m.businessId === businessId)?.month;
  if (!businessId || !month) {
    console.log("no financial records found — nothing to export");
    return;
  }

  console.log(`building pack for business ${businessId}, month ${month}...`);
  const started = Date.now();
  const zip = await buildAccountantPackZipBuffer(businessId, {
    type: "month",
    month,
  });
  console.log(`built ${zip.length} bytes in ${Date.now() - started}ms`);

  const out = path.join(os.tmpdir(), `accountant-pack-e2e-${businessId}-${month}.zip`);
  await writeFile(out, zip);
  console.log("written:", out);

  const entries = collectZipEntryNames(zip);
  console.log(`entries (${entries.length}):`);
  for (const e of entries) console.log("  -", e);

  const hasXlsx = entries.some((e) => e.endsWith(".xlsx"));
  const hasManifest = entries.includes("_meta/manifest.json");
  const hasSummary = entries.includes("סיכום.txt");
  const hasMissing = entries.includes("_meta/missing-files.txt");
  console.log(
    JSON.stringify({ hasXlsx, hasManifest, hasSummary, hasMissing }, null, 2)
  );
  if (!hasXlsx || !hasManifest || !hasSummary || !hasMissing) {
    process.exitCode = 1;
    console.error("FAIL: expected core entries missing");
  } else {
    console.log("E2E export verify passed");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
