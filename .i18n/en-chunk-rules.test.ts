/**
 * Unit tests for the pure rules of the English-dictionary chunk proof (.i18n/en-chunk-rules.ts).
 * Run: npx tsx .i18n/en-chunk-rules.test.ts
 *
 * 1. the chunk name that failed CI run 41706563200 (`09-fn8k_4ub0p.js`) is recognised as hashed,
 *    together with the other name shapes this build produces; names without a hash stay refused;
 * 2. the dictionary file is the English-only file carrying the sentinels — not a file the Hebrew page
 *    also loads, not a file with too few sentinels;
 * 3. a missing dictionary file (or too many) still fails the proof's assertions;
 * 4. the proof uses these rules and no longer carries the old inline expression.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { MAX_DICTIONARY_FILES, MIN_SENTINELS_PER_FILE, dictionaryChunkVerdict, isHashedChunkPath, selectDictionaryChunks } from "./en-chunk-rules";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// ── 1 · hashed chunk names ──────────────────────────────────────────────
const OLD_RULE = /^\/_next\/static\/chunks\/(.*\/)?[^/]*[0-9a-z]{8,}[^/]*\.js$/i;
const failed = "/_next/static/chunks/09-fn8k_4ub0p.js";
check("the name that failed CI is recognised as hashed", isHashedChunkPath(failed), failed);
check("…and the old rule really refused it (the test reproduces the bug)", !OLD_RULE.test(failed));
for (const p of [
  "/_next/static/chunks/0zn1c08lw9p-o.js", // '-' inside the hash (main build)
  "/_next/static/chunks/43_3_8_p2acet.js", // '_' inside the hash, no 8-run of letters/digits (main build)
  "/_next/static/chunks/3z1as6y9dfgjm.js", // letters and digits only
  "/_next/static/chunks/turbopack-3tqfrf37targ2.js", // name prefix + hash (runtime chunk)
  "/_next/static/chunks/app/inventory/page-1ppwy_36pb0wi.js", // nested directory + prefix
]) check(`hashed: ${p}`, isHashedChunkPath(p));
for (const p of [
  "/_next/static/chunks/main-app.js", // no hash
  "/_next/static/chunks/webpack-runtime.js", // no hash, 15 letters and '-'
  "/_next/static/chunks/en.js",
  "/_next/static/chunks/09-fn8k_4ub0.js", // 12 hash characters
  "/_next/static/chunks/09-fn8k_4ub0p.css", // not JS
  "/_next/static/chunks/09-fn8k_4ub0p.js.map",
  "/static/chunks/09-fn8k_4ub0p.js", // not under /_next/static/
  "/_next/static/media/09-fn8k_4ub0p.js", // not a chunk
  "/api/i18n/09-fn8k_4ub0p.js",
]) check(`not hashed: ${p}`, !isHashedChunkPath(p));
// Not weaker than before: unhashed names the OLD rule accepted (any 8-letter run) are refused now.
for (const p of ["/_next/static/chunks/framework.js", "/_next/static/chunks/polyfills.js", "/_next/static/chunks/dictionary.js"]) {
  check(`old rule accepted, new rule refuses: ${p}`, OLD_RULE.test(p) && !isHashedChunkPath(p));
}

// ── 2 · selecting the dictionary file ───────────────────────────────────
const SENT = ["Sales overview", "Add product", "Supplier orders", "Count stock", "Not now", "Open the product"];
const dict = { url: "http://x/_next/static/chunks/09-fn8k_4ub0p.js", body: `x=${JSON.stringify(SENT)}` };
const shared = { url: "http://x/_next/static/chunks/0zn1c08lw9p-o.js", body: `Sales overview Add product Supplier orders Count stock` }; // loaded by the Hebrew page too
const few = { url: "http://x/_next/static/chunks/43_3_8_p2acet.js", body: `Add product Not now` }; // 2 < 3 sentinels
const plain = { url: "http://x/_next/static/chunks/3z1as6y9dfgjm.js", body: `function a(){}` };
const he = new Set([shared.url, plain.url]);
const sel = selectDictionaryChunks([plain, shared, few, dict], he, SENT);
check("the English-only file with the sentinels is selected — and only it", sel.chunks.length === 1 && sel.chunks[0] === dict.url, JSON.stringify(sel.chunks));
check("a file the Hebrew page also loads is never selected, even with sentinels", !sel.chunks.includes(shared.url));
check(`a file with fewer than ${MIN_SENTINELS_PER_FILE} sentinels is not selected`, !sel.chunks.includes(few.url));
check("coverage counts the selected file's sentinels", sel.covered.size === SENT.length, String(sel.covered.size));
const okVerdict = dictionaryChunkVerdict(sel.chunks.length, sel.covered.size, SENT.length);
check("a correct selection passes both assertions", okVerdict.coverageOk && okVerdict.countOk, JSON.stringify(okVerdict));

// ── 3 · a missing (or wrong) dictionary file still fails ────────────────
const none = selectDictionaryChunks([plain, shared, few], he, SENT);
const noneVerdict = dictionaryChunkVerdict(none.chunks.length, none.covered.size, SENT.length);
check("no dictionary file → nothing selected", none.chunks.length === 0);
check("no dictionary file → the count assertion fails", !noneVerdict.countOk);
check("no dictionary file → the coverage assertion fails", !noneVerdict.coverageOk);
const onlyHebrewLoaded = selectDictionaryChunks([dict], new Set([dict.url]), SENT);
check("dictionary loaded by the Hebrew page too → not accepted (fails)", !dictionaryChunkVerdict(onlyHebrewLoaded.chunks.length, onlyHebrewLoaded.covered.size, SENT.length).countOk);
const partial = selectDictionaryChunks([{ url: dict.url, body: SENT.slice(0, 3).join(" ") }], he, SENT);
check("a file carrying only half the dictionary → coverage fails (≥ 90% unchanged)", !dictionaryChunkVerdict(partial.chunks.length, partial.covered.size, SENT.length).coverageOk);
check(`more than ${MAX_DICTIONARY_FILES} dictionary files → the count assertion fails`, !dictionaryChunkVerdict(MAX_DICTIONARY_FILES + 1, SENT.length, SENT.length).countOk);

// ── 4 · the proof uses these rules ──────────────────────────────────────
const proof = readFileSync(join(__dirname, "en-chunk-proof.mts"), "utf8");
check("the proof imports the rules module", /from "\.\/en-chunk-rules"/.test(proof));
check("the proof checks chunk names with isHashedChunkPath", /isHashedChunkPath\(p\)/.test(proof));
check("the proof selects the dictionary with selectDictionaryChunks", /selectDictionaryChunks\(/.test(proof));
check("the proof asserts both verdicts", /verdict\.coverageOk/.test(proof) && /verdict\.countOk/.test(proof));
check("the old inline name rule is gone", !proof.includes("[0-9a-z]{8,}"));
check("the DOM and byte assertions are unchanged", proof.includes("MAIN = BRANCH (meta, text, DOM)") && proof.includes("const englishHtmlNotLarger = (mainBytes: number, branchBytes: number) => branchBytes <= mainBytes;") && proof.includes("<= 2048"));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
