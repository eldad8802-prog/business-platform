/**
 * WP2.7 — Packaging to the OPENFRMT directory structure (spec 1.31 §2.2).
 *
 * Writes `INI.TXT` (uncompressed) and the compressed `BKMVDATA` archive under
 * `<root>/OPENFRMT/<8-digit עוסק>.<YY>/<MMDDhhmm>/`. Thin IO layer over the pure
 * builder; the record bytes are already produced by `buildUniformExportFiles`.
 */

import archiver from "archiver";
import { PassThrough } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UniformBuildResult } from "@/lib/services/billing/uniform/uniform-file-builder";

/** Zip a single BKMVDATA.TXT buffer into a `BKMVDATA.zip` buffer (§2.2.ד). */
export function zipBkmvdata(bkmvdataTxt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    sink.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.pipe(sink);
    archive.append(bkmvdataTxt, { name: "BKMVDATA.TXT" });
    void archive.finalize();
  });
}

export type WriteResult = {
  outputDir: string;
  iniPath: string;
  bkmvdataZipPath: string;
};

/**
 * Materialize the OPENFRMT structure under `rootDir`. Returns the paths written.
 * (`INI.TXT` uncompressed; `BKMVDATA` zipped, per spec.)
 */
export async function writeUniformExport(
  rootDir: string,
  result: UniformBuildResult
): Promise<WriteResult> {
  const outputDir = join(rootDir, result.meta.dirPath);
  mkdirSync(outputDir, { recursive: true });

  const iniPath = join(outputDir, "INI.TXT");
  writeFileSync(iniPath, result.iniBuffer);

  const zip = await zipBkmvdata(result.bkmvdataBuffer);
  const bkmvdataZipPath = join(outputDir, "BKMVDATA.zip");
  writeFileSync(bkmvdataZipPath, zip);

  return { outputDir, iniPath, bkmvdataZipPath };
}
