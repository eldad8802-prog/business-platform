/**
 * Accountant ZIP collect verify — deadlock regression guard (run manually):
 *   npx tsx lib/reports/accountant-export-collect.verify.test.ts
 *
 * The historic 504: the route awaited archive.finalize() with no consumer
 * attached, so any archive larger than the internal stream buffers (~1MB)
 * stalled on backpressure forever. This test pushes ~30MB of incompressible
 * entries through collectArchiveToBuffer — far past every internal
 * highWaterMark — and requires it to complete quickly and produce a parseable
 * ZIP whose entries round-trip byte-for-byte.
 */

import { randomBytes } from "node:crypto";
import { collectArchiveToBuffer } from "@/lib/reports/accountant-export-zip";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

function collectZipEntries(zipBuffer: Buffer): Map<string, Buffer> {
  // Minimal ZIP parse: scan for local file headers (PK\x03\x04).
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zipBuffer.length) {
    if (
      zipBuffer[offset] !== 0x50 ||
      zipBuffer[offset + 1] !== 0x4b ||
      zipBuffer[offset + 2] !== 0x03 ||
      zipBuffer[offset + 3] !== 0x04
    ) {
      break;
    }
    const nameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const compSize = zipBuffer.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const name = zipBuffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    entries.set(name, zipBuffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
}

async function main() {
  const ENTRY_COUNT = 30;
  const ENTRY_BYTES = 1024 * 1024; // 1MB, random → incompressible

  const payloads: Buffer[] = [];
  for (let i = 0; i < ENTRY_COUNT; i++) {
    payloads.push(randomBytes(ENTRY_BYTES));
  }

  const startedAt = Date.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("collectArchiveToBuffer deadlocked (>60s)")),
      60_000
    ).unref()
  );

  const zip = await Promise.race([
    collectArchiveToBuffer(async (archive) => {
      for (let i = 0; i < ENTRY_COUNT; i++) {
        // store: mirrors how originals are appended in the real pack.
        archive.append(payloads[i], { name: `approved/doc-${i}.bin`, store: true });
      }
      archive.append("summary", { name: "סיכום.txt" });
    }),
    timeout,
  ]);

  const elapsedMs = Date.now() - startedAt;
  console.log(`collected ${zip.length} bytes in ${elapsedMs}ms`);

  ok("completes without deadlock", true);
  ok("output is well past the 1MB backpressure threshold", zip.length > 25 * ENTRY_BYTES);

  const entries = collectZipEntries(zip);
  ok(`ZIP parses (${entries.size} entries)`, entries.size === ENTRY_COUNT + 1);
  ok(
    "stored entry bytes round-trip exactly",
    entries.get("approved/doc-0.bin")?.equals(payloads[0]) === true &&
      entries.get(`approved/doc-${ENTRY_COUNT - 1}.bin`)?.equals(
        payloads[ENTRY_COUNT - 1]
      ) === true
  );

  if (failed > 0) {
    process.exit(1);
  }
  console.log("accountant export collect verify tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
