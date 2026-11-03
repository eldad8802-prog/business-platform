/**
 * Pure rules of the English-dictionary chunk proof (.i18n/en-chunk-proof.mts), kept here so they are
 * unit-tested (.i18n/en-chunk-rules.test.ts) instead of living as inline expressions in the E2E harness.
 * Thresholds are the proof's own and unchanged: ≥ 3 sentinels for a file to count, ≥ 90% coverage overall,
 * 1–3 dedicated files.
 */

/**
 * Production JS chunk names of this build (Turbopack, next build): a 13-character content hash from the
 * alphabet [0-9a-z_-], optionally after a name prefix — e.g. `0zn1c08lw9p-o.js`, `43_3_8_p2acet.js`,
 * `09-fn8k_4ub0p.js`, `turbopack-3tqfrf37targ2.js`. The earlier rule (`[0-9a-z]{8,}` somewhere in the name)
 * ignored `-` and `_`, which ARE hash characters, and so refused a valid hashed name whenever the hash
 * contained no run of 8 letters/digits (CI run 41706563200: `09-fn8k_4ub0p.js`). The hash length is exact,
 * so names without a hash (`main-app.js`, `webpack-runtime.js`, `en.js`) are still refused; a change of the
 * build's naming fails the proof (it never passes silently).
 */
export const HASHED_CHUNK_PATH = /^\/_next\/static\/chunks\/(?:[^/]+\/)*(?:[a-z0-9]+-)?[0-9a-z_-]{13}\.js$/i;

export function isHashedChunkPath(path: string): boolean {
  return HASHED_CHUNK_PATH.test(path);
}

export const MIN_SENTINELS_PER_FILE = 3;
export const MIN_COVERAGE = 0.9;
export const MAX_DICTIONARY_FILES = 3;

export type LoadedFile = { url: string; body: string };

/**
 * Which of the static JS files an English page loaded hold the dictionary: English-only (not loaded by the
 * Hebrew page of the same route and build) and carrying at least MIN_SENTINELS_PER_FILE sentinel strings.
 */
export function selectDictionaryChunks(files: readonly LoadedFile[], hebrewUrls: ReadonlySet<string>, sentinels: readonly string[]) {
  const covered = new Set<string>();
  const chunks: string[] = [];
  for (const f of files) {
    const hits = sentinels.filter((x) => f.body.includes(x));
    if (hits.length >= MIN_SENTINELS_PER_FILE && !hebrewUrls.has(f.url)) {
      chunks.push(f.url);
      hits.forEach((h) => covered.add(h));
    }
  }
  return { chunks, covered };
}

/** The two assertions the proof makes on the selection. Both must hold; an empty selection fails both. */
export function dictionaryChunkVerdict(chunkCount: number, coveredCount: number, sentinelCount: number) {
  return {
    coverageOk: coveredCount >= Math.floor(sentinelCount * MIN_COVERAGE),
    countOk: chunkCount >= 1 && chunkCount <= MAX_DICTIONARY_FILES,
  };
}
