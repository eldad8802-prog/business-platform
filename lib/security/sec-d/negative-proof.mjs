/**
 * sec(D) negative proofs — one mutation per control.
 *
 *   node lib/security/sec-d/negative-proof.mjs <ID>      (e.g. M2, H4, L17)
 *   node lib/security/sec-d/negative-proof.mjs --list
 *
 * For the given ID:
 *   1. sha256 the target file, apply ONE mutation whose anchor must occur
 *      EXACTLY once, and require the file to have changed (a mutation that did
 *      not apply would "prove" nothing);
 *   2. run the proof (battery or renderer proof) and capture its output;
 *   3. restore the file and require a byte-identical sha256;
 *   4. require exit != 0 AND the SPECIFIC "[FAIL] <label>" line for the
 *      control under test — red for any other reason (a crash, another check)
 *      is a failed negative proof.
 * Prints MUTATION / EXPECTED RED / ACTUAL RED / INTENDED REASON / RESTORE.
 * The workflow runs the proof again afterwards (POST-RESTORE GREEN).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BATTERY = ["npx", "tsx", "lib/security/sec-d/sec-d-battery.test.ts"];
const RENDERER = ["npx", "tsx", "lib/security/sec-d/renderer-proof.test.ts"];

const MUTATIONS = {
  H4: {
    file: "lib/storage/r2-storage.adapter.ts",
    anchor: "      ? r2.publicBucketName\n      : r2.privateBucketName;",
    replacement: "      ? r2.publicBucketName\n      : r2.publicBucketName;",
    run: BATTERY,
    label: "[FAIL] H-4 · private-domain key (documents) is written to the PRIVATE bucket",
    reason: "private documents routed to the public bucket",
  },
  M2: {
    file: "lib/services/storage/public-asset-storage.service.ts",
    anchor: "  if (!verdict.ok) {\n    throw new PublicAssetRejectedError(verdict);",
    replacement: "  if (false && !verdict.ok) {\n    throw new PublicAssetRejectedError(verdict);",
    run: BATTERY,
    label: "[FAIL] M-2 · SVG declared image/svg+xml refused with 415 and zero writes",
    reason: "public asset verification bypassed — SVG reaches storage",
  },
  L13: {
    file: "lib/services/crm/crm-attachment-content.ts",
    anchor: '      return detectFileSignature(buffer) === "pdf" ? { ok: true } : fail("CONTENT_MISMATCH");',
    replacement: "      return { ok: true };",
    run: BATTERY,
    label: "[FAIL] L-13 · HTML declared application/pdf → CONTENT_MISMATCH",
    reason: "declared PDF no longer checked against its bytes",
  },
  L5: {
    file: "lib/data-transfer/format/xlsx-reader.ts",
    anchor: "  const { deadline } = assertXlsxWithinLimits(buffer, limits);",
    replacement: "  const deadline = Date.now() + limits.timeBudgetMs;",
    run: BATTERY,
    label: "[FAIL] L-5 · sheet dimension A1:XFD1048576 refused with XLSX_DIMENSION_TOO_LARGE",
    reason: "zip/dimension guard not run before ExcelJS load",
  },
  L6: {
    file: "lib/archive/zip-buffer.ts",
    anchor: "    assertSafeZipEntryName(data?.name);\n",
    replacement: "",
    run: BATTERY,
    label: '[FAIL] L-6 · archive entry name "../evil.txt" aborts the archive',
    reason: "entry names reach archiver unchecked (zip-slip)",
  },
  L15: {
    file: "lib/services/integrations/whatsapp/media-fetch.service.ts",
    anchor: '    if (!isMetaMediaTokenUrl(url)) {\n      return { ok: false, reason: "untrusted_media_host" };\n    }\n    let current',
    replacement: "    let current",
    run: BATTERY,
    label: "[FAIL] L-15 · Graph URL on a non-Meta host: request never made, token never sent",
    reason: "bearer token sent to an arbitrary host",
  },
  L17: {
    file: "lib/services/integrations/gmail/token-crypto.placeholder.ts",
    anchor: "|biz=${ctx.businessId}|conn=${ctx.connectionId}",
    replacement: "",
    run: BATTERY,
    label: "[FAIL] L-17 · v2 blob copied to another business's row does not decrypt",
    reason: "AAD no longer binds the ciphertext to its row",
  },
  L20: {
    file: "lib/data-transfer/import/execute/import-executor.ts",
    anchor: "  if (facts.userId !== input.userId) {",
    replacement: "  if (false && facts.userId !== input.userId) {",
    run: BATTERY,
    label: "[FAIL] L-20 · preview token minted for user A is refused for user B with TOKEN_WRONG_USER",
    reason: "import token not bound to the executing user",
  },
  L16: {
    file: "lib/services/integrations/whatsapp/sender-trust.ts",
    anchor: '  return trust === "allowlist" ? WHATSAPP_TRUSTED_SOURCE : WHATSAPP_UNVERIFIED_SOURCE;',
    replacement: "  return WHATSAPP_TRUSTED_SOURCE;",
    run: BATTERY,
    label: "[FAIL] L-16 · media from a NON-allowlisted sender is labelled whatsapp_unverified",
    reason: "unverified sender's document indistinguishable from a trusted one",
  },
  L14JS: {
    file: "lib/services/billing/pdf/billing-pdf-html-renderer.ts",
    anchor: "      javaScriptEnabled: false,",
    replacement: "      javaScriptEnabled: true,",
    run: RENDERER,
    label: "[FAIL] L-14 · hardened renderer does NOT execute page script",
    reason: "page JavaScript enabled in the PDF renderer",
  },
  L14NET: {
    file: "lib/services/billing/pdf/billing-pdf-html-renderer.ts",
    anchor: '      return route.abort("blockedbyclient");',
    replacement: "      return route.continue();",
    run: RENDERER,
    label: "[FAIL] L-14 · hardened renderer makes ZERO network requests",
    reason: "renderer network no longer closed",
  },
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

const id = process.argv[2];
if (id === "--list") {
  console.log(Object.keys(MUTATIONS).join(" "));
  process.exit(0);
}
const m = MUTATIONS[id];
if (!m) {
  console.error(`unknown mutation ${id}; known: ${Object.keys(MUTATIONS).join(" ")}`);
  process.exit(64);
}

const original = readFileSync(m.file);
const before = sha(original);
const text = original.toString("utf8");
const count = text.split(m.anchor).length - 1;
if (count !== 1) {
  console.error(`MUTATION NOT APPLIED: anchor occurs ${count} times in ${m.file}`);
  process.exit(65);
}
writeFileSync(m.file, text.replace(m.anchor, () => m.replacement));
if (sha(readFileSync(m.file)) === before) {
  writeFileSync(m.file, original);
  console.error("MUTATION NOT APPLIED: file unchanged");
  process.exit(65);
}

let out = "";
let rc = -1;
try {
  const r = spawnSync(m.run[0], m.run.slice(1), {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  rc = r.status ?? -1;
} finally {
  writeFileSync(m.file, original);
}
const after = sha(readFileSync(m.file));

const failLines = out.split("\n").filter((l) => l.startsWith("[FAIL]") || l.startsWith("[CRASH]"));
console.log(`MUTATION:        ${id} — ${m.file} (anchor x1, sha ${before.slice(0, 12)} → mutated)`);
console.log(`EXPECTED RED:    ${m.label}`);
console.log(`ACTUAL RED:      rc=${rc}; ${failLines.length ? failLines.join(" | ") : "(no [FAIL] line)"}`);
console.log(`INTENDED REASON: ${m.reason}`);
console.log(`RESTORE:         sha ${after.slice(0, 12)} ${after === before ? "== original (byte-identical)" : "!= original"}`);

if (after !== before) {
  console.error("RESTORE NOT BYTE-IDENTICAL");
  process.exit(3);
}
if (rc === 0) {
  console.error("NEGATIVE-PROOF FAIL: the proof stayed green under the mutation");
  process.exit(1);
}
if (out.includes("[CRASH]")) {
  console.error("NEGATIVE-PROOF FAIL: red because of a crash, not the control under test");
  process.exit(1);
}
if (!out.split("\n").some((l) => l.startsWith(m.label))) {
  console.error("NEGATIVE-PROOF FAIL: red, but not for the reason under test");
  console.error(out.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log("NEGATIVE-PROOF PASS");
