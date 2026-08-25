/**
 * Documents dedup backfill — hash existing originals (Wave 1B, Blueprint §6).
 *
 * Computes contentHashSha256 + sizeBytes for Document rows created before the
 * dedup wave, by reading each original from storage (R2 / local fallback).
 *
 * MANUAL, GATED — never runs automatically. Dry-run by default; pass --write to
 * persist. Run with the target environment's DATABASE_URL + storage env:
 *
 *   npx tsx scripts/documents/backfill-content-hash.ts            # dry run
 *   npx tsx scripts/documents/backfill-content-hash.ts --write    # persist
 *
 * Rows whose original is unreadable (e.g. the 72 legacy /uploads/* rows whose
 * files were purged) are reported and left untouched — a missing original is a
 * truthful state, not an error to hide.
 */

import { prisma } from "@/lib/prisma";
import {
  readDocumentObject,
  STORED_DOCUMENT_FILENAME_REGEX,
} from "@/lib/services/documents/document-storage.service";
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

async function main() {
  const write = process.argv.includes("--write");

  const docs = await prisma.document.findMany({
    where: { contentHashSha256: null },
    select: { id: true, businessId: true, fileUrl: true },
    orderBy: { id: "asc" },
  });

  console.log(
    `[backfill-content-hash] ${docs.length} documents without a hash (mode: ${
      write ? "WRITE" : "dry-run"
    })`
  );

  let hashed = 0;
  let unreadable = 0;
  let invalidName = 0;

  for (const doc of docs) {
    const basename = String(doc.fileUrl ?? "").trim();
    if (!STORED_DOCUMENT_FILENAME_REGEX.test(basename)) {
      invalidName += 1;
      console.log(`  doc ${doc.id}: legacy/invalid fileUrl (${doc.fileUrl}) — skipped`);
      continue;
    }

    try {
      const buffer = await readDocumentObject(doc.businessId, basename);
      const hash = sha256Hex(buffer);
      if (write) {
        await prisma.document.update({
          where: { id: doc.id },
          data: { contentHashSha256: hash, sizeBytes: buffer.byteLength },
        });
      }
      hashed += 1;
      console.log(
        `  doc ${doc.id}: ${hash.slice(0, 12)}… (${buffer.byteLength} bytes)${
          write ? "" : " [dry]"
        }`
      );
    } catch {
      unreadable += 1;
      console.log(`  doc ${doc.id}: original unreadable — skipped`);
    }
  }

  console.log(
    `[backfill-content-hash] done: ${hashed} hashed, ${unreadable} unreadable, ${invalidName} legacy names`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
