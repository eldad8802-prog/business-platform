/**
 * Conditional writes + prefix listing (business documents, owner-approved 2026-11-06) — local adapter, pure.
 *   npx tsx lib/storage/storage-conditional.test.ts
 * The R2 adapter is exercised against a dedicated test bucket by .business-documents/r2.battery.mts.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalFsStorageService,
  StorageKeyError,
  assertSafeListPrefix,
  assertUnconditionalPutAllowed,
  getRequiredVisibility,
  isConditionalOnlyDomain,
  type PutObjectInput,
} from "./index";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function throwsKeyError(fn: () => unknown): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return e instanceof StorageKeyError;
  }
}

const doc = (key: string, body: string, businessId = 42): PutObjectInput => ({
  key,
  body: Buffer.from(body),
  contentType: "application/pdf",
  metadata: { businessId, domain: "business-docs", visibility: "private" },
});

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-conditional-"));
  const s = new LocalFsStorageService({ provider: "local", localRoot: root, signedUrlTtlSeconds: 300 });
  try {
    console.log("--- domain policy ---");
    ok("business-docs is private", getRequiredVisibility("business-docs") === "private");
    ok("business-docs is conditional-only", isConditionalOnlyDomain("business-docs"));
    ok("no existing domain became conditional-only", (["documents", "billing", "content", "inventory", "offers", "crm", "trust", "exports"] as const).every((d) => !isConditionalOnlyDomain(d)));
    ok("assertUnconditionalPutAllowed refuses business-docs", await throwsKeyError(() => assertUnconditionalPutAllowed("business-docs")));
    ok("a plain putObject in business-docs is refused", await throwsKeyError(() => s.putObject(doc("biz/42/business-docs/a.pdf", "x"))));
    ok("public visibility in business-docs is refused", await throwsKeyError(() => s.putObjectIfAbsent({ ...doc("biz/42/business-docs/p.pdf", "x"), metadata: { businessId: 42, domain: "business-docs", visibility: "public" } })));
    ok("key/business mismatch is refused", await throwsKeyError(() => s.putObjectIfAbsent(doc("biz/43/business-docs/m.pdf", "x", 42))));

    console.log("--- existing domains unchanged ---");
    const plain = await s.putObject({ key: "biz/42/documents/d.bin", body: Buffer.from("v1"), contentType: "application/octet-stream", metadata: { businessId: 42, domain: "documents", visibility: "private" } });
    const over = await s.putObject({ key: "biz/42/documents/d.bin", body: Buffer.from("v2"), contentType: "application/octet-stream", metadata: { businessId: 42, domain: "documents", visibility: "private" } });
    ok("a plain putObject still overwrites in an existing domain", plain.key === over.key && (await s.getObject("biz/42/documents/d.bin")).body.toString() === "v2");

    console.log("--- create-once ---");
    const first = await s.putObjectIfAbsent(doc("biz/42/business-docs/q/1.pdf", "first"));
    ok("first conditional write → CREATED", first.status === "CREATED");
    const second = await s.putObjectIfAbsent(doc("biz/42/business-docs/q/1.pdf", "second"));
    ok("second conditional write → EXISTS", second.status === "EXISTS");
    ok("the object keeps the first body", (await s.getObject("biz/42/business-docs/q/1.pdf")).body.toString() === "first");
    ok("metadata readable after a conditional write", (await s.headObject("biz/42/business-docs/q/1.pdf")).metadata?.domain === "business-docs");

    const racers = await Promise.all(Array.from({ length: 25 }, (_, i) => s.putObjectIfAbsent(doc("biz/42/business-docs/q/race.pdf", `body-${i}`))));
    const created = racers.filter((r) => r.status === "CREATED");
    ok("25 concurrent conditional writes → exactly one CREATED", created.length === 1, `${created.length}`);
    const body = (await readFile(path.join(root, "biz", "42", "business-docs", "q", "race.pdf"))).toString();
    ok("the stored body is one complete racer body (never partial or mixed)", /^body-\d+$/.test(body), body);

    await s.deleteObject("biz/42/business-docs/q/1.pdf");
    ok("after a delete the key can be created again", (await s.putObjectIfAbsent(doc("biz/42/business-docs/q/1.pdf", "again"))).status === "CREATED");
    await s.deleteObject("biz/42/business-docs/q/never-existed.pdf");
    ok("deleting a missing key is not an error", true);

    console.log("--- listing ---");
    await s.putObjectIfAbsent(doc("biz/42/business-docs/l/a.pdf", "a"));
    await s.putObjectIfAbsent(doc("biz/42/business-docs/l/sub/b.pdf", "bb"));
    await s.putObjectIfAbsent(doc("biz/7/business-docs/l/x.pdf", "x", 7));
    const listed = await s.listObjects("biz/42/business-docs/l/");
    ok("lists every object under the prefix, nested included, sidecars and temp files excluded", JSON.stringify(listed.map((o) => o.key)) === JSON.stringify(["biz/42/business-docs/l/a.pdf", "biz/42/business-docs/l/sub/b.pdf"]), JSON.stringify(listed.map((o) => o.key)));
    ok("sizes are reported", listed[1]?.size === 2);
    ok("a partial-name prefix filters", (await s.listObjects("biz/42/business-docs/l/su")).length === 1);
    ok("another business's objects are not listed", !listed.some((o) => o.key.startsWith("biz/7/")));
    ok("an empty prefix lists nothing (no error)", (await s.listObjects("biz/42/business-docs/none/")).length === 0);
    ok("a bucket-wide prefix is refused", await throwsKeyError(() => assertSafeListPrefix("biz/")));
    ok("a non-positive business prefix is refused", await throwsKeyError(() => assertSafeListPrefix("biz/0/business-docs/")));
    ok("an unknown domain prefix is refused", await throwsKeyError(() => assertSafeListPrefix("biz/42/nope/")));
    ok("a traversal prefix is refused", await throwsKeyError(() => assertSafeListPrefix("biz/42/business-docs/../../x")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
