/**
 * Collect an `archiver` zip stream into a single in-memory Buffer.
 *
 * Extracted VERBATIM (behaviour unchanged) from
 * `lib/reports/accountant-export-zip.ts`, which still re-exports it so every
 * existing caller and test keeps working. It moved because it is not a
 * Documents concern: the Import/Export Center needs the same helper for
 * multi-domain CSV archives, and importing it from the accountant module would
 * have dragged Prisma, object storage and ExcelJS into a path that needs none
 * of them.
 *
 * THE ORDERING BELOW IS THE WHOLE POINT — do not "simplify" it:
 *
 * The output collector is attached BEFORE anything is appended and BEFORE
 * `finalize()` is awaited. `finalize()` only resolves once the underlying
 * zip-stream has flushed to a consumer; awaiting it with no consumer attached
 * deadlocks as soon as the archive outgrows the internal stream buffers
 * (~1MB) — which was the historic 504 on any real month of documents.
 */

import archiver from "archiver";

export async function collectArchiveToBuffer(
  build: (archive: archiver.Archiver) => Promise<void>
): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });

  const chunks: Buffer[] = [];
  const collected = new Promise<void>((resolve, reject) => {
    archive.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    archive.on("warning", (err) => {
      // ENOENT-style warnings mean a silently incomplete archive — treat as fatal.
      reject(err);
    });
    archive.on("error", reject);
    archive.on("end", resolve);
  });

  await build(archive);
  // Awaited together: if the archive errors while finalize() is in flight, the
  // rejection must be observed immediately (not after finalize settles).
  await Promise.all([archive.finalize(), collected]);

  return Buffer.concat(chunks);
}
