/**
 * I-7C — Documents execute / ledger / idempotency verifier.
 *
 * NO database and NO network.
 *
 * # Why this file has a fake ledger instead of only structural assertions
 *
 * The failure this increment exists to prevent is "a Document was created but
 * its execution marker was not, so a retry creates it again". That state cannot
 * be produced against a real database on purpose without corrupting one, and
 * asserting that the code LOOKS right would prove nothing about what the code
 * DOES. So the ports are injectable and the harness below models the real
 * durability semantics honestly:
 *
 *   - an ImportRun is unique on (business, content, mapping, decisions)
 *   - an ImportRunRow's primary key is (run, position) and rejects a repeat
 *   - the marker written through `withinTransaction` is BUFFERED and applied
 *     only if the Document row commits, and discarded if anything throws
 *   - a rolled-back ingest deletes the object it stored
 *
 * That last group is the whole point: the harness cannot commit a Document
 * without its marker, because the real code cannot either. Every failure is
 * then injected at a real seam — storage, the Document write, the marker write,
 * terminalization, and the response itself — and the assertion is always the
 * same one: how many Documents exist afterwards.
 *
 * Run: npx tsx lib/data-transfer/documents/documents-execute.verify.test.ts
 */
process.env.AUTH_TOKEN_SECRET ||= "i7c-verify-secret-not-a-real-key";

import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import {
  executeDocumentImport,
  CANONICAL_PORTS,
  type ExecutePorts,
  type ExecuteDocumentsResult,
} from "@/lib/data-transfer/documents/documents-execute";
import {
  documentsBatchContentHash,
  documentsMappingHash,
  DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
  DOCUMENTS_IMPORT_MAX_FILES,
} from "@/lib/data-transfer/documents/documents-import-config";
import {
  documentDecisionsHash,
  stageDocumentFiles,
  type DocumentDecisions,
  type DocumentFileAction,
  type IncomingFile,
} from "@/lib/data-transfer/documents/batch-analyze";
import { issuePreviewToken } from "@/lib/data-transfer/import/preview/preview-token";
import { ingestDocument } from "@/lib/services/documents/document-ingestion.service";
import { DOCUMENT_MAX_UPLOAD_BYTES } from "@/lib/services/documents/document-ingestion.service";

/**
 * Remove block and line comments so a symbol scan reads the CODE, not the prose.
 *
 * Needed because this module documents the failure modes it prevents, and those
 * explanations name the very calls it must never make. A scan that could be
 * tripped by an explanation is a scan that punishes writing one down.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      if (i < 0) return line;
      // Only strip a marker that is not itself inside a string literal.
      const before = line.slice(0, i);
      const quotes = (before.match(/["']/g) ?? []).length;
      return quotes % 2 === 0 ? before : line;
    })
    .join("\n");
}

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ok  ${label}`);
  });
}

/* ==================================================================
   Fixtures
   ================================================================== */

const BUSINESS = 7;
const USER = 11;

const pdf = (tag: string) =>
  Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(tag)]);
const jpeg = (tag: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);

function f(name: string, buffer: Buffer, mimeType = "application/pdf"): IncomingFile {
  return { filename: name, mimeType, buffer };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/* ==================================================================
   The harness: an in-memory ledger with real durability semantics
   ================================================================== */

type Doc = { id: number; businessId: number; hash: string; status: string };
type Run = {
  id: number;
  businessId: number;
  contentHash: string;
  mappingHash: string;
  decisionsHash: string;
  status: "EXECUTING" | "COMPLETED" | "PARTIAL" | "FAILED";
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
};
type Marker = {
  runId: number;
  position: number;
  action: "CREATE" | "SKIP";
  status: "CREATED" | "SKIPPED" | "FAILED";
  errorCode: string | null;
};

/**
 * The primary-key violation, raised through Prisma's own error class.
 *
 * classifyRowFailure narrows with `instanceof PrismaClientKnownRequestError`, so
 * a hand-rolled look-alike would take a different branch and the harness would
 * be exercising a path production never reaches.
 */
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

class World {
  docs: Doc[] = [];
  runs: Run[] = [];
  markers: Marker[] = [];
  storage = new Set<string>();
  nextDoc = 1;
  nextRun = 1;
  /** Injected failures, keyed by 1-based batch position. */
  failStorage = new Set<number>();
  failCreate = new Set<number>();
  failMarker = new Set<number>();
  failTerminalize = false;
  ingestCalls: { position: number; allowDuplicate: boolean }[] = [];

  seedDocument(businessId: number, buffer: Buffer, status = "processing") {
    this.docs.push({
      id: this.nextDoc++,
      businessId,
      hash: sha(buffer),
      status,
    });
  }

  docsFor(businessId: number) {
    return this.docs.filter((d) => d.businessId === businessId);
  }

  markersFor(runId: number) {
    return this.markers.filter((m) => m.runId === runId);
  }

  /** Insert honouring the (run, position) primary key. */
  insertMarker(marker: Marker) {
    const clash = this.markers.some(
      (m) => m.runId === marker.runId && m.position === marker.position
    );
    if (clash) throw uniqueViolation();
    this.markers.push(marker);
  }

  /** Position is derived from the batch under test, set before each execute. */
  batch: IncomingFile[] = [];

  positionOf(buffer: Buffer): number {
    const i = this.batch.findIndex((b) => b.buffer.equals(buffer));
    return i + 1;
  }

  ports(): ExecutePorts {
    return portsFor(this);
  }
}

/** The ledger ports, bound to one world. A free function so nothing aliases `this`. */
function portsFor(w: World): ExecutePorts {
  return {
      ingest: (async (input) => {
        const hash = sha(input.buffer);
        const position = w.positionOf(input.buffer);
        w.ingestCalls.push({
          position,
          allowDuplicate: Boolean(input.allowDuplicate),
        });

        if (!input.allowDuplicate) {
          const dup = w.docs.find(
            (d) =>
              d.businessId === input.businessId &&
              d.hash === hash &&
              d.status !== "failed"
          );
          if (dup) {
            return {
              ok: false as const,
              reason: "DUPLICATE" as const,
              duplicate: {
                documentId: dup.id,
                status: dup.status,
                uploadedAt: new Date(0).toISOString(),
                vendorName: null,
                amount: null,
                date: null,
              },
            };
          }
        }

        // --- storage FIRST, exactly as the real service does ---
        if (w.failStorage.has(position)) throw new Error("storage unavailable");
        const objectKey = `obj-${position}-${w.storage.size}`;
        w.storage.add(objectKey);

        // --- ONE transaction: the caller's marker, then the Document row ---
        const buffered: Marker[] = [];
        const tx = {
          importRunRow: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              if (w.failMarker.has(position)) throw new Error("ledger write lost");
              const runId = data.importRunId as number;
              const pos = data.sourceRowNumber as number;
              const clash =
                w.markers.some((m) => m.runId === runId && m.position === pos) ||
                buffered.some((m) => m.runId === runId && m.position === pos);
              if (clash) throw uniqueViolation();
              buffered.push({
                runId,
                position: pos,
                action: data.action as Marker["action"],
                status: data.status as Marker["status"],
                errorCode: (data.errorCode as string) ?? null,
              });
            },
          },
        };

        try {
          if (input.withinTransaction) {
            await input.withinTransaction(tx as never);
          }
          if (w.failCreate.has(position)) throw new Error("document write failed");
          const doc: Doc = {
            id: w.nextDoc++,
            businessId: input.businessId,
            hash,
            status: "processing",
          };
          // COMMIT — marker and row become durable together, or neither does.
          w.markers.push(...buffered);
          w.docs.push(doc);
          return { ok: true as const, documentId: doc.id, status: "processing" as const };
        } catch (error) {
          // Rolled back. The service removes the object it stored.
          w.storage.delete(objectKey);
          throw error;
        }
      }) as ExecutePorts["ingest"],

      findExistingHashes: async (businessId, hashes) => {
        const set = new Set<string>();
        for (const d of w.docs) {
          if (d.businessId === businessId && d.status !== "failed" && hashes.includes(d.hash)) {
            set.add(d.hash);
          }
        }
        return set;
      },

      findExistingRun: async (id) => {
        const run = w.runs.find(
          (r) =>
            r.businessId === id.businessId &&
            r.contentHash === id.contentHash &&
            r.mappingHash === id.mappingHash &&
            r.decisionsHash === id.decisionsHash
        );
        return run ? toOpened(run, false) : null;
      },

      openOrResumeRun: async (id) => {
        const found = w.runs.find(
          (r) =>
            r.businessId === id.businessId &&
            r.contentHash === id.contentHash &&
            r.mappingHash === id.mappingHash &&
            r.decisionsHash === id.decisionsHash
        );
        if (found) return toOpened(found, false);
        const run: Run = {
          id: w.nextRun++,
          businessId: id.businessId,
          contentHash: id.contentHash,
          mappingHash: id.mappingHash,
          decisionsHash: id.decisionsHash,
          status: "EXECUTING",
          createdCount: null,
          skippedCount: null,
          failedCount: null,
        };
        w.runs.push(run);
        return toOpened(run, true);
      },

      loadExecutedRowNumbers: async (_businessId, runId) =>
        new Set(w.markersFor(runId).map((m) => m.position)),

      // Standalone marker writes enforce the composite primary key, exactly as
      // the real table does. Without that the harness would silently accept a
      // second marker for a position and hide the concurrency case.
      markSkippedRow: async (_businessId, marker) => {
        w.insertMarker({
          runId: marker.importRunId,
          position: marker.sourceRowNumber,
          action: "SKIP",
          status: "SKIPPED",
          errorCode: null,
        });
      },

      markFailedRow: async (_businessId, marker) => {
        w.insertMarker({
          runId: marker.importRunId,
          position: marker.sourceRowNumber,
          action: marker.action,
          status: "FAILED",
          errorCode: marker.errorCode ?? null,
        });
      },

      countRunRowsByStatus: async (_businessId, runId) => {
        const rows = w.markersFor(runId);
        return {
          createdCount: rows.filter((r) => r.status === "CREATED").length,
          skippedCount: rows.filter((r) => r.status === "SKIPPED").length,
          failedCount: rows.filter((r) => r.status === "FAILED").length,
        };
      },

      terminalizeRun: async (_businessId, runId, status, counts) => {
        if (w.failTerminalize) throw new Error("terminalize failed");
        const run = w.runs.find((r) => r.id === runId);
        if (!run) return;
        run.status = status;
        run.createdCount = counts.createdCount;
        run.skippedCount = counts.skippedCount;
        run.failedCount = counts.failedCount;
      },

      loadFailedRunRows: async (_businessId, runId) =>
        w.markersFor(runId)
          .filter((m) => m.status === "FAILED")
          .map((m) => ({ sourceRowNumber: m.position, errorCode: m.errorCode }))
          .sort((a, b) => a.sourceRowNumber - b.sourceRowNumber),
  };
}

function toOpened(run: Run, created: boolean) {
  return {
    id: run.id,
    status: run.status,
    created,
    startedAt: new Date(0),
    counts: {
      createdCount: run.createdCount,
      skippedCount: run.skippedCount,
      failedCount: run.failedCount,
    },
  };
}

/* ==================================================================
   Driving a batch
   ================================================================== */

type Confirmed = {
  files: IncomingFile[];
  decisions: DocumentDecisions;
  previewToken: string;
};

/** Mint the attestation the way the analyze route does. */
function confirm(
  files: IncomingFile[],
  decisions: DocumentDecisions,
  over: Partial<{
    businessId: number;
    userId: number;
    domain: string;
    contentHash: string;
    mappingHash: string;
    decisionsHash: string;
    sheetName: string | null;
    rowCount: number;
    issuedAt: Date;
  }> = {}
): Confirmed {
  const { contentHashes } = stageDocumentFiles(files);
  const previewToken = issuePreviewToken(
    {
      businessId: over.businessId ?? BUSINESS,
      userId: over.userId ?? USER,
      domain: (over.domain ?? "documents") as "documents",
      contentHash: over.contentHash ?? documentsBatchContentHash(contentHashes),
      mappingHash: over.mappingHash ?? documentsMappingHash(),
      decisionsHash: over.decisionsHash ?? documentDecisionsHash(decisions),
      sheetName: over.sheetName ?? null,
      rowCount: over.rowCount ?? files.length,
    },
    over.issuedAt ?? new Date()
  );
  return { files, decisions, previewToken };
}

/** Decisions object from a positional list of actions. */
function decide(...actions: DocumentFileAction[]): DocumentDecisions {
  const out: DocumentDecisions = {};
  actions.forEach((a, i) => (out[i] = a));
  return out;
}

async function run(
  world: World,
  confirmed: Confirmed,
  files = confirmed.files
): Promise<ExecuteDocumentsResult> {
  world.batch = files;
  return executeDocumentImport(
    {
      businessId: BUSINESS,
      userId: USER,
      files,
      decisions: confirmed.decisions,
      previewToken: confirmed.previewToken,
    },
    world.ports()
  );
}

function ok(r: ExecuteDocumentsResult) {
  assert.equal(r.ok, true, `expected success, got ${JSON.stringify(r)}`);
  return r as Extract<ExecuteDocumentsResult, { ok: true }>;
}
function rejected(r: ExecuteDocumentsResult) {
  assert.equal(r.ok, false, `expected refusal, got ${JSON.stringify(r)}`);
  return r as Extract<ExecuteDocumentsResult, { ok: false }>;
}

/* ==================================================================
   1. Binding — nothing is believed without the attestation
   ================================================================== */

const A = f("a.pdf", pdf("aaa"));
const B = f("b.pdf", pdf("bbb"));
const C = f("c.jpg", jpeg("ccc"), "image/jpeg");

async function main() {
  await check("a valid confirmed batch creates exactly its CREATE files", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "SKIP"));
    const r = ok(await run(w, c));
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.counts.createdCount, 1);
    assert.equal(r.counts.skippedCount, 1);
    assert.equal(w.docsFor(BUSINESS).length, 1);
    assert.equal(w.markersFor(r.importRunId).length, 2);
  });

  await check("one changed byte is refused, and writes nothing", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    const r = rejected(await run(w, c, [A, f("b.pdf", pdf("bbX"))]));
    assert.equal(r.code, "TOKEN_MISMATCH");
    assert.equal(w.docs.length, 0);
    assert.equal(w.runs.length, 0);
  });

  await check("reordering the same files is a different batch", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    const r = rejected(await run(w, c, [B, A]));
    assert.equal(r.code, "TOKEN_MISMATCH");
    assert.equal(w.docs.length, 0);
  });

  await check("removing a file is refused", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    const r = rejected(await run(w, c, [A]));
    assert.equal(r.code, "TOKEN_MISMATCH");
    assert.equal(w.docs.length, 0);
  });

  await check("adding a file is refused", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    const r = rejected(await run(w, c, [A, B, C]));
    assert.equal(r.code, "TOKEN_MISMATCH");
    assert.equal(w.docs.length, 0);
  });

  await check("a decision changed after confirmation is refused", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "SKIP"));
    c.decisions = decide("CREATE", "CREATE");
    const r = rejected(await run(w, c));
    assert.equal(r.code, "TOKEN_MISMATCH");
    assert.equal(w.docs.length, 0);
  });

  await check("a malformed token is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    c.previewToken = "not-a-token";
    assert.equal(rejected(await run(w, c)).code, "TOKEN_MALFORMED");
    assert.equal(w.docs.length, 0);
  });

  await check("a tampered payload is refused on the signature", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    const [body, mac] = c.previewToken.split(".");
    const decoded = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    decoded.businessId = 999;
    const forged = Buffer.from(JSON.stringify(decoded))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    c.previewToken = `${forged}.${mac}`;
    assert.equal(rejected(await run(w, c)).code, "TOKEN_BAD_SIGNATURE");
    assert.equal(w.docs.length, 0);
  });

  await check("an expired attestation is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), {
      issuedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_EXPIRED");
    assert.equal(w.docs.length, 0);
  });

  await check("a token minted for another business is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), { businessId: BUSINESS + 1 });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_WRONG_TENANT");
    assert.equal(w.docs.length, 0);
    assert.equal(w.runs.length, 0);
  });

  await check("a token minted for another user is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), { userId: USER + 1 });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_WRONG_USER");
  });

  await check("a token for another import domain is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), { domain: "customers" });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_WRONG_DOMAIN");
  });

  await check("a token carrying a real column mapping is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), {
      mappingHash: createHash("sha256").update("0=name\n1=phone").digest("hex"),
    });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_WRONG_MAPPING");
  });

  await check("a token carrying a worksheet name is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"), { sheetName: "Sheet1" });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_WRONG_MAPPING");
  });

  await check("a mismatched file count is refused", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"), { rowCount: 5 });
    assert.equal(rejected(await run(w, c)).code, "TOKEN_MISMATCH");
  });

  /* ==================================================================
     2. Limits
     ================================================================== */

  await check("an empty batch is refused", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    assert.equal(rejected(await run(w, c, [])).code, "NO_FILES");
  });

  await check("more than the file ceiling is refused before the token", async () => {
    const w = new World();
    const many = Array.from({ length: DOCUMENTS_IMPORT_MAX_FILES + 1 }, (_, i) =>
      f(`f${i}.pdf`, pdf(`f${i}`))
    );
    const c = confirm(many, decide(...many.map(() => "CREATE" as const)));
    assert.equal(rejected(await run(w, c)).code, "TOO_MANY_FILES");
    assert.equal(w.runs.length, 0);
  });

  await check("a batch over the byte ceiling is refused", async () => {
    const w = new World();
    const big = f("big.pdf", pdf("x".repeat(DOCUMENTS_IMPORT_MAX_BATCH_BYTES)));
    const c = confirm([big], decide("CREATE"));
    assert.equal(rejected(await run(w, c)).code, "BATCH_TOO_LARGE");
    assert.equal(w.docs.length, 0);
  });

  await check("a file over the per-file ceiling cannot be executed", async () => {
    const w = new World();
    const big = f("big.pdf", pdf("x".repeat(DOCUMENT_MAX_UPLOAD_BYTES)));
    const c = confirm([big], decide("CREATE"));
    const r = rejected(await run(w, c));
    assert.equal(r.code, "FILE_REJECTED");
    assert.equal(w.docs.length, 0);
    assert.equal(w.runs.length, 0, "a batch that cannot execute leaves no ledger trace");
  });

  /* ==================================================================
     3. Content signature — Phase 17
     ================================================================== */

  await check("the same bytes re-declared as another type are refused", async () => {
    const w = new World();
    // The declared MIME is NOT covered by the content hash, so this passes every
    // hash comparison and must still be caught by re-verifying the signature.
    const honest = f("a.pdf", pdf("aaa"), "application/pdf");
    const relabelled = f("a.pdf", pdf("aaa"), "image/png");
    const c = confirm([honest], decide("CREATE"));
    const r = rejected(await run(w, c, [relabelled]));
    assert.equal(r.code, "FILE_REJECTED");
    assert.equal(r.position, 1);
    assert.equal(w.docs.length, 0);
    assert.equal(w.runs.length, 0);
  });

  await check("an unsupported file cannot be executed even if confirmed", async () => {
    const w = new World();
    const bogus = f("evil.pdf", Buffer.from("MZ\x90\x00 not a pdf"), "application/pdf");
    const c = confirm([bogus], decide("CREATE"));
    assert.equal(rejected(await run(w, c)).code, "FILE_REJECTED");
    assert.equal(w.docs.length, 0);
  });

  await check("an unsupported file the owner skipped does not block the batch", async () => {
    const w = new World();
    const bogus = f("evil.pdf", Buffer.from("MZ\x90\x00 not a pdf"), "application/pdf");
    const c = confirm([A, bogus], decide("CREATE", "SKIP"));
    const r = ok(await run(w, c));
    assert.equal(r.counts.createdCount, 1);
    assert.equal(r.counts.skippedCount, 1);
    assert.equal(w.docsFor(BUSINESS).length, 1);
  });

  /* ==================================================================
     4. Duplicates, overrides, and drift
     ================================================================== */

  await check("a duplicate the owner skipped is skipped, not created", async () => {
    const w = new World();
    w.seedDocument(BUSINESS, A.buffer);
    const before = w.docs.length;
    const c = confirm([A], decide("SKIP"));
    const r = ok(await run(w, c));
    assert.equal(r.counts.skippedCount, 1);
    assert.equal(w.docs.length, before, "nothing created");
    assert.equal(w.ingestCalls.length, 0, "a skipped file never reaches ingestion");
  });

  await check("CREATE_ANYWAY creates exactly one further copy", async () => {
    const w = new World();
    w.seedDocument(BUSINESS, A.buffer);
    const c = confirm([A], decide("CREATE_ANYWAY"));
    const r = ok(await run(w, c));
    assert.equal(r.counts.createdCount, 1);
    assert.equal(w.docsFor(BUSINESS).length, 2);
    assert.equal(w.ingestCalls[0].allowDuplicate, true, "the override is passed through");
  });

  await check("a plain CREATE never carries the duplicate override", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    ok(await run(w, c));
    assert.equal(w.ingestCalls[0].allowDuplicate, false);
  });

  await check("in-file duplicates import once — the winner only", async () => {
    const w = new World();
    const twin = f("copy.pdf", pdf("aaa"));
    const c = confirm([A, twin], decide("CREATE", "SKIP"));
    const r = ok(await run(w, c));
    assert.equal(r.counts.createdCount, 1);
    assert.equal(r.counts.skippedCount, 1);
    assert.equal(w.docsFor(BUSINESS).length, 1);
  });

  await check("an in-file duplicate cannot be confirmed as a create", async () => {
    const w = new World();
    const twin = f("copy.pdf", pdf("aaa"));
    const c = confirm([A, twin], decide("CREATE", "CREATE_ANYWAY"));
    const r = rejected(await run(w, c));
    assert.equal(r.code, "DECISION_NOT_PERMITTED");
    assert.equal(r.position, 2);
    assert.equal(w.docs.length, 0);
  });

  await check("a duplicate confirmed as a plain CREATE is refused", async () => {
    const w = new World();
    w.seedDocument(BUSINESS, A.buffer);
    // CREATE asserts "this was not already held". Only CREATE_ANYWAY overrides.
    const c = confirm([A], decide("CREATE"));
    const r = rejected(await run(w, c));
    assert.equal(r.code, "DECISION_NOT_PERMITTED");
  });

  await check("DRIFT — a duplicate appearing after preview fails the file, silently creating nothing", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    // Confirmed when both were new. Between confirmation and execution the
    // owner uploads `A` by hand through the normal upload screen.
    w.batch = [A, B];
    const ports = w.ports();
    const drifting: ExecutePorts = {
      ...ports,
      openOrResumeRun: async (id) => {
        const opened = await ports.openOrResumeRun(id);
        w.seedDocument(BUSINESS, A.buffer); // the drift, after validation
        return opened;
      },
    };
    const r = ok(
      await executeDocumentImport(
        {
          businessId: BUSINESS,
          userId: USER,
          files: [A, B],
          decisions: c.decisions,
          previewToken: c.previewToken,
        },
        drifting
      )
    );
    assert.equal(r.counts.failedCount, 1, "the drifted file fails");
    assert.equal(r.counts.createdCount, 1, "its neighbour still imports");
    assert.equal(r.failures[0].code, "DUPLICATE_CHANGED");
    assert.equal(r.failures[0].position, 1);
    // The seeded document plus B. `A` was NOT created a second time.
    assert.equal(w.docsFor(BUSINESS).length, 2);
    assert.equal(w.docsFor(BUSINESS).filter((d) => d.hash === sha(A.buffer)).length, 1);
  });

  await check("a drifted file is not silently re-read as an override", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    w.batch = [A];
    const ports = w.ports();
    const drifting: ExecutePorts = {
      ...ports,
      openOrResumeRun: async (id) => {
        const opened = await ports.openOrResumeRun(id);
        w.seedDocument(BUSINESS, A.buffer);
        return opened;
      },
    };
    const r = ok(
      await executeDocumentImport(
        { businessId: BUSINESS, userId: USER, files: [A], decisions: c.decisions, previewToken: c.previewToken },
        drifting
      )
    );
    assert.equal(r.status, "FAILED");
    assert.equal(w.ingestCalls[0].allowDuplicate, false, "never upgraded to an override");
    assert.equal(w.docsFor(BUSINESS).length, 1);
  });

  /* ==================================================================
     5. Replay — the invariant
     ================================================================== */

  await check("REPLAY — an exact repeat of a finished batch creates nothing more", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    const first = ok(await run(w, c));
    assert.equal(first.counts.createdCount, 2);
    assert.equal(w.docsFor(BUSINESS).length, 2);

    const second = ok(await run(w, c));
    assert.equal(second.alreadyExecuted, true);
    assert.equal(second.importRunId, first.importRunId);
    assert.equal(w.docsFor(BUSINESS).length, 2, "no additional documents");
    assert.equal(w.runs.length, 1, "no second run");
  });

  await check("REPLAY — five repeats still leave exactly the original documents", async () => {
    const w = new World();
    const c = confirm([A, B, C], decide("CREATE", "CREATE", "CREATE"));
    ok(await run(w, c));
    for (let i = 0; i < 5; i++) ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 3);
    assert.equal(w.runs.length, 1);
  });

  await check("REPLAY OF AN OVERRIDE — CREATE_ANYWAY replayed creates exactly one copy", async () => {
    // The case duplicate detection cannot protect, because the owner turned it
    // off. Only the per-position marker stops the second create.
    const w = new World();
    w.seedDocument(BUSINESS, A.buffer);
    const c = confirm([A], decide("CREATE_ANYWAY"));

    ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 2, "the seeded one plus the override");

    for (let i = 0; i < 4; i++) {
      const again = ok(await run(w, c));
      assert.equal(again.alreadyExecuted, true);
    }
    assert.equal(w.docsFor(BUSINESS).length, 2, "the override did NOT repeat");
    assert.equal(w.ingestCalls.length, 1, "ingestion was attempted exactly once");
  });

  await check("REPLAY OF A MIXED BATCH — creates and skips both replay cleanly", async () => {
    const w = new World();
    w.seedDocument(BUSINESS, C.buffer);
    const c = confirm([A, B, C], decide("CREATE", "SKIP", "CREATE_ANYWAY"));
    const first = ok(await run(w, c));
    assert.equal(first.counts.createdCount, 2);
    assert.equal(first.counts.skippedCount, 1);
    const before = w.docsFor(BUSINESS).length;
    ok(await run(w, c));
    ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, before);
  });

  /* ==================================================================
     6. Failure injection — every crash point
     ================================================================== */

  await check("STORAGE FAILS — no document, no marker, and the file stays retryable", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    w.failStorage.add(1);
    const r = ok(await run(w, c));
    assert.equal(r.status, "EXECUTING", "the run stays open");
    assert.equal(r.unexecutedFiles, 1);
    assert.equal(w.docsFor(BUSINESS).length, 1, "only the healthy file");
    assert.equal(w.markersFor(r.importRunId).length, 1);

    w.failStorage.clear();
    const retry = ok(await run(w, c));
    assert.equal(retry.status, "COMPLETED");
    assert.equal(w.docsFor(BUSINESS).length, 2, "exactly one more, never two");
  });

  await check("DOCUMENT WRITE FAILS — its marker rolls back with it", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    w.failCreate.add(1);
    const r = ok(await run(w, c));
    assert.equal(w.docs.length, 0, "no document");
    assert.equal(w.markersFor(r.importRunId).length, 0, "and NO orphan marker");
    assert.equal(w.storage.size, 0, "the stored object was cleaned up");
    assert.equal(r.status, "EXECUTING");
  });

  await check("LEDGER MARKER FAILS — the document is NOT created (mandatory)", async () => {
    // The failure this whole increment exists to prevent. Because the marker is
    // written inside the transaction that creates the Document row, a marker
    // that cannot be written takes the Document row down with it — leaving a
    // clean, retryable absence rather than an untracked document.
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    w.failMarker.add(1);
    const r = ok(await run(w, c));
    assert.equal(w.docs.length, 0, "NO document was created without its marker");
    assert.equal(w.markersFor(r.importRunId).length, 0);
    assert.equal(w.storage.size, 0);
    assert.equal(r.status, "EXECUTING", "the position is still owed");
    assert.equal(r.unexecutedFiles, 1);
  });

  await check("LEDGER MARKER FAILS THEN THE OWNER RETRIES — exactly one document", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    w.failMarker.add(1);
    ok(await run(w, c));
    assert.equal(w.docs.length, 0);

    w.failMarker.clear();
    const retry = ok(await run(w, c));
    assert.equal(retry.status, "COMPLETED");
    assert.equal(w.docsFor(BUSINESS).length, 1, "exactly one, not zero and not two");
  });

  await check("LEDGER MARKER FAILS ON AN OVERRIDE — still exactly one after retry", async () => {
    const w = new World();
    w.seedDocument(BUSINESS, A.buffer);
    const c = confirm([A], decide("CREATE_ANYWAY"));
    w.failMarker.add(1);
    ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 1, "nothing was created");

    w.failMarker.clear();
    ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 2);
    ok(await run(w, c));
    ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 2, "and the retries added nothing");
  });

  await check("RESPONSE LOST AFTER SUCCESS — the retry creates nothing", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    ok(await run(w, c)); // succeeded; imagine the owner never saw the answer
    assert.equal(w.docsFor(BUSINESS).length, 2);
    const retry = ok(await run(w, c));
    assert.equal(retry.alreadyExecuted, true);
    assert.equal(retry.counts.createdCount, 2, "it reports the original outcome");
    assert.equal(w.docsFor(BUSINESS).length, 2);
  });

  await check("PARTIAL BATCH — one failure does not roll back its nineteen neighbours", async () => {
    const w = new World();
    const files = Array.from({ length: 20 }, (_, i) => f(`f${i}.pdf`, pdf(`f${i}`)));
    const c = confirm(files, decide(...files.map(() => "CREATE" as const)));
    w.failStorage.add(20);
    const r = ok(await run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 19, "nineteen are durably ingested");
    assert.equal(r.status, "EXECUTING");
    assert.equal(r.unexecutedFiles, 1);

    w.failStorage.clear();
    const retry = ok(await run(w, c));
    assert.equal(retry.status, "COMPLETED");
    assert.equal(w.docsFor(BUSINESS).length, 20);
    assert.equal(w.ingestCalls.filter((c2) => c2.position === 1).length, 1, "file 1 was ingested once");
  });

  await check("TERMINALIZATION FAILS — the run stays open and the retry adds nothing", async () => {
    const w = new World();
    const c = confirm([A, B], decide("CREATE", "CREATE"));
    w.failTerminalize = true;
    await assert.rejects(() => run(w, c));
    assert.equal(w.docsFor(BUSINESS).length, 2, "the documents are already durable");
    assert.equal(w.runs[0].status, "EXECUTING");

    w.failTerminalize = false;
    const retry = ok(await run(w, c));
    assert.equal(retry.status, "COMPLETED");
    assert.equal(w.docsFor(BUSINESS).length, 2, "no duplication from the retry");
  });

  await check("A CONCURRENT EXECUTION of the same run is not counted as a failure", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    w.batch = [A];
    const ports = w.ports();
    const raced: ExecutePorts = {
      ...ports,
      loadExecutedRowNumbers: async () => new Set<number>(), // stale read
    };
    // Pre-commit position 1 exactly as a concurrent request would.
    await ports.openOrResumeRun({
      businessId: BUSINESS,
      userId: USER,
      domain: "documents",
      contentHash: documentsBatchContentHash(stageDocumentFiles([A]).contentHashes),
      mappingHash: documentsMappingHash(),
      decisionsHash: documentDecisionsHash(c.decisions),
      sheetName: null,
      totalRows: 1,
    });
    w.markers.push({ runId: 1, position: 1, action: "CREATE", status: "CREATED", errorCode: null });
    w.docs.push({ id: 99, businessId: BUSINESS, hash: sha(A.buffer), status: "processing" });

    const r = ok(
      await executeDocumentImport(
        { businessId: BUSINESS, userId: USER, files: [A], decisions: c.decisions, previewToken: c.previewToken },
        raced
      )
    );
    assert.equal(r.counts.failedCount, 0, "the primary-key clash is not a failure");
    assert.equal(w.docsFor(BUSINESS).length, 1, "and no second document");
  });

  /* ==================================================================
     7. Tenant
     ================================================================== */

  await check("a file another tenant holds is still new for this one", async () => {
    const w = new World();
    w.seedDocument(BUSINESS + 1, A.buffer);
    const c = confirm([A], decide("CREATE"));
    const r = ok(await run(w, c));
    assert.equal(r.counts.createdCount, 1);
    assert.equal(w.docsFor(BUSINESS).length, 1);
    assert.equal(w.docsFor(BUSINESS + 1).length, 1, "the other tenant is untouched");
  });

  await check("a run belonging to another tenant is never resumed", async () => {
    const w = new World();
    const c = confirm([A], decide("CREATE"));
    const { contentHashes } = stageDocumentFiles([A]);
    w.runs.push({
      id: 500,
      businessId: BUSINESS + 1,
      contentHash: documentsBatchContentHash(contentHashes),
      mappingHash: documentsMappingHash(),
      decisionsHash: documentDecisionsHash(c.decisions),
      status: "COMPLETED",
      createdCount: 1,
      skippedCount: 0,
      failedCount: 0,
    });
    const r = ok(await run(w, c));
    assert.notEqual(r.importRunId, 500);
    assert.equal(r.alreadyExecuted, false, "another tenant's run is not this one's replay");
  });

  /* ==================================================================
     8. Structural — the contracts source alone can prove
     ================================================================== */

  const execCode = fs.readFileSync("lib/data-transfer/documents/documents-execute.ts", "utf8");
  // A forbidden-symbol scan must read the CODE, not the prose about it. The
  // module documents the failure modes it prevents, and those explanations name
  // the very calls it must not make.
  const execExec = stripComments(execCode);
  const routeCode = fs.readFileSync("app/api/data-transfer/documents/execute/route.ts", "utf8");
  const serviceCode = fs.readFileSync(
    "lib/services/documents/document-ingestion.service.ts",
    "utf8"
  );

  await check("the canonical ports ARE the canonical implementations", () => {
    assert.equal(CANONICAL_PORTS.ingest, ingestDocument);
    assert.equal(typeof CANONICAL_PORTS.openOrResumeRun, "function");
    assert.equal(typeof CANONICAL_PORTS.terminalizeRun, "function");
  });

  await check("execution never reproduces any part of ingestion", () => {
    for (const forbidden of [
      "putDocumentObject",
      "deleteDocumentObjectQuiet",
      "processDocumentPipeline",
      "buildStoredDocumentFileName",
      "document.create",
      "contentHashSha256",
      "after(",
    ]) {
      assert.equal(
        execExec.includes(forbidden),
        false,
        `execute must not contain ${forbidden}`
      );
    }
  });

  await check("the marker is written INSIDE the ingestion transaction", () => {
    // The invariant, asserted where it is expressed: markRow is passed as the
    // withinTransaction hook and appears nowhere else in the create path.
    assert.equal(/withinTransaction:\s*async \(tx\) => \{\s*await markRow\(/.test(execCode), true);
    // And the service runs that hook before the Document write, in one tx.
    const txStart = serviceCode.indexOf("withTenantTransaction(async (tx) => {");
    const hook = serviceCode.indexOf("input.withinTransaction(tx)");
    const create = serviceCode.indexOf("tx.document.create(");
    assert.equal(txStart >= 0 && hook > txStart && create > hook, true);
  });

  await check("there is no standalone writer for a CREATED marker", () => {
    const store = fs.readFileSync(
      "lib/data-transfer/import/execute/import-run-store.ts",
      "utf8"
    );
    assert.equal(store.includes("markSkippedRow"), true);
    assert.equal(store.includes("markFailedRow"), true);
    assert.equal(/export async function mark\w*CreatedRow/.test(store), false);
  });

  await check("the run is resolved BEFORE the decisions are re-validated", () => {
    const find = execCode.indexOf("ports.findExistingRun(");
    const validate = execCode.indexOf("isDecisionPermitted(");
    const open = execCode.indexOf("ports.openOrResumeRun(");
    assert.equal(find < validate, true, "I-6 truth order: resolve, then validate");
    assert.equal(validate < open, true, "but validate before the first durable write");
  });

  await check("the tenant check precedes any comparison of the bytes", () => {
    const tenant = execCode.indexOf("TOKEN_WRONG_TENANT");
    const content = execCode.indexOf("documentsBatchContentHash(contentHashes) !== facts.contentHash");
    assert.equal(tenant < content, true);
  });

  await check("the override is read from the signed decision, never from live truth", () => {
    assert.equal(execCode.includes('allowDuplicate: action === "CREATE_ANYWAY"'), true);
    // There must be no duplicate lookup feeding allowDuplicate.
    assert.equal(/allowDuplicate:[^,\n]*findExisting/.test(execCode), false);
  });

  await check("execution touches no other business domain", () => {
    for (const forbidden of [
      "billingDocument",
      "BillingDocument",
      "customer.",
      "supplier.",
      "lead.",
      "inventoryItem",
      "reviewEvent",
      "financialRecord",
      "vendorLearning",
    ]) {
      assert.equal(execExec.includes(forbidden), false, `execute must not touch ${forbidden}`);
    }
  });

  await check("the tenant is server-derived and never read from the request", () => {
    assert.equal(routeCode.includes("businessId: user.businessId"), true);
    assert.equal(routeCode.includes("userId: user.id"), true);
    assert.equal(/form\.get\(\s*["']businessId/.test(routeCode), false);
    assert.equal(/form\.get\(\s*["']userId/.test(routeCode), false);
  });

  await check("the execute route is rate limited fail-closed before the body is read", () => {
    const limit = routeCode.indexOf("checkRateLimit(");
    const body = routeCode.indexOf("req.formData()");
    assert.equal(limit < body, true);
    assert.equal(routeCode.includes("DATA_TRANSFER_DOCUMENTS_IMPORT"), true);
    const buckets = fs.readFileSync("lib/security/rate-limiter/buckets.ts", "utf8");
    const cfg = buckets.slice(buckets.indexOf("DATA_TRANSFER_DOCUMENTS_IMPORT:"));
    assert.equal(cfg.slice(0, 200).includes('failMode: "closed"'), true);
  });

  await check("the documents bucket caps daily documents at the single-upload ceiling", () => {
    const buckets = fs.readFileSync("lib/security/rate-limiter/buckets.ts", "utf8");
    const cfg = buckets.slice(
      buckets.indexOf("DATA_TRANSFER_DOCUMENTS_IMPORT:"),
      buckets.indexOf("DATA_TRANSFER_DOCUMENTS_IMPORT:") + 500
    );
    const daily = /scope: "business", limit: (\d+), windowSeconds: 24 \* 60 \* 60/.exec(cfg);
    assert.notEqual(daily, null);
    assert.equal(Number(daily![1]) * DOCUMENTS_IMPORT_MAX_FILES <= 500, true);
  });

  await check("the error path never echoes a filename", () => {
    const tail = routeCode.slice(routeCode.indexOf("} catch (error)"));
    assert.equal(tail.includes("error.message"), false);
    assert.equal(tail.includes("error.name"), true);
  });

  await check("analyze and execute share ONE parser, so their limits cannot drift", () => {
    const analyze = fs.readFileSync("app/api/data-transfer/documents/analyze/route.ts", "utf8");
    assert.equal(analyze.includes("readDocumentBatchForm("), true);
    assert.equal(routeCode.includes("readDocumentBatchForm("), true);
    assert.equal(analyze.includes("DOCUMENTS_IMPORT_MAX_FILES"), true);
  });

  await check("analyze and execute share ONE file-acceptance pass", () => {
    const analyzeLib = fs.readFileSync(
      "lib/data-transfer/documents/batch-analyze.ts",
      "utf8"
    );
    assert.equal(analyzeLib.includes("export function stageDocumentFiles("), true);
    assert.equal(analyzeLib.includes("stageDocumentFiles(input.files)"), true);
    assert.equal(execCode.includes("stageDocumentFiles(input.files)"), true);
    // and execute does not carry its own signature logic
    assert.equal(execCode.includes("verifyFileSignature"), false);
  });

  await check("the UI confirms before it executes, and never before", () => {
    const ui = fs.readFileSync(
      "components/settings/import-export/DocumentsImportScreen.tsx",
      "utf8"
    );
    // Exactly one control triggers Execute, and it sits inside the confirm
    // panel — so nothing on the check screen can reach it.
    const invocations = [...ui.matchAll(/void onExecute\(\)/g)].map(
      (m) => m.index ?? -1
    );
    assert.equal(invocations.length, 1, "Execute is triggered from one control only");
    const checkPanel = ui.indexOf('{stage === "check" && result ?');
    const confirmPanel = ui.indexOf('{stage === "confirm" && result ?');
    assert.equal(checkPanel > 0 && confirmPanel > checkPanel, true);
    assert.equal(
      invocations[0] > confirmPanel,
      true,
      "the only Execute trigger lives in the confirm panel"
    );
    assert.equal(
      ui.slice(checkPanel, confirmPanel).includes("onExecute"),
      false,
      "no control on the check screen can trigger execution"
    );
    assert.equal(ui.includes("disabled={busy}"), true, "double submission is blocked");
    assert.equal(ui.includes("CREATE_ANYWAY"), true, "the override is explicit");
  });

  await check("the ledger stores evidence, never document contents", () => {
    assert.equal(/markRow\([\s\S]{0,300}filename/.test(execCode), false);
    assert.equal(/markRow\([\s\S]{0,300}buffer/.test(execCode), false);
    assert.equal(/markFailedRow\([\s\S]{0,300}filename/.test(execCode), false);
  });

  await check("the run identity is the documents sentinel, not an invented mapping", () => {
    assert.equal(execCode.includes("documentsMappingHash()"), true);
    assert.equal(execCode.includes('domain: "documents"'), true);
    assert.equal(execCode.includes("sheetName: null"), true);
  });

  console.log(`\nI-7C DOCUMENTS EXECUTE VERIFY PASS — ${passed} checks green.`);
}

main().catch((error) => {
  console.error("\nFAILED:", error);
  process.exit(1);
});
