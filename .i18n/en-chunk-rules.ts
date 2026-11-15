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

/**
 * The ONE owner-approved exception to "the BRANCH may not grow the English HTML" (owner, 2026-11-15, the
 * notification settings round): the settings phone card reuses the task centre's browser-push client
 * (lib/push/push-client.ts) instead of a second copy, so Turbopack moves that client into a small chunk of its own
 * and the /tasks document carries one more chunk reference — up to 251 bytes, with no more JavaScript loaded.
 *
 * It applies ONLY when every condition holds; otherwise the strict rule stands:
 *   - the route is /tasks (no other page);
 *   - the growth is 1..251 bytes;
 *   - the document references exactly one chunk more than MAIN's;
 *   - that is the split push-client chunk: exactly one small chunk (≤ 8 KB) on the BRANCH carries the push-client
 *     sentinel, and MAIN has no such split chunk — so once this change is on main, MAIN has it too and the exception
 *     can never apply again (it does not add up with later changes);
 *   - the JavaScript unique to /tasks is at most 310 raw bytes (owner: 300 on 2026-11-15, raised to 310 on 2026-11-16 after CI measured 307): the growth of the
 *     JavaScript /tasks loads (sum of every referenced chunk) minus the growth measured on /app in the same build
 *     (the notification stack every page shares; never counted below zero). Brotli bytes are reported, not gated.
 * The general rule (englishHtmlNotLarger in the proof) is unchanged.
 */
export const APPROVED_TASKS_PUSH_CHUNK_EXCEPTION = Object.freeze({
  route: "/tasks",
  maxExtraBytes: 251,
  /** A string literal of lib/push/push-client.ts that survives minification. */
  pushClientSentinel: "ios-needs-install",
  maxPushChunkBytes: 8192,
  /** Raw JS bytes /tasks may grow beyond the shared growth measured on sharedBaselineRoute. */
  maxUniqueJsRawBytes: 310,
  sharedBaselineRoute: "/app",
  approved: "owner 2026-11-15",
});

/** Distinct hashed JS chunk paths an HTML document references (script tags and the RSC payload alike). */
export function chunkPathsInHtml(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\/_next\/static\/chunks\/[0-9A-Za-z_\-/]+?\.js/g)) {
    if (isHashedChunkPath(m[0])) found.add(m[0]);
  }
  return [...found];
}

export type MeasuredChunk = { path: string; bytes: number; brBytes: number; body: string };
export type MeasuredPage = { htmlBytes: number; chunks: readonly MeasuredChunk[] };

export function tasksPushChunkExceptionVerdict(route: string, main: MeasuredPage, branch: MeasuredPage, shared: { main: MeasuredPage; branch: MeasuredPage }) {
  const x = APPROVED_TASKS_PUSH_CHUNK_EXCEPTION;
  const split = (p: MeasuredPage) => p.chunks.filter((c) => c.bytes <= x.maxPushChunkBytes && c.body.includes(x.pushClientSentinel));
  const sum = (p: MeasuredPage, f: "bytes" | "brBytes") => p.chunks.reduce((n, c) => n + c[f], 0);
  const growth = branch.htmlBytes - main.htmlBytes;
  const sharedRaw = Math.max(0, sum(shared.branch, "bytes") - sum(shared.main, "bytes"));
  const sharedBr = Math.max(0, sum(shared.branch, "brBytes") - sum(shared.main, "brBytes"));
  const uniqueRaw = sum(branch, "bytes") - sum(main, "bytes") - sharedRaw;
  const uniqueBr = sum(branch, "brBytes") - sum(main, "brBytes") - sharedBr;
  const conditions = {
    route: route === x.route,
    growthWithinApproval: growth > 0 && growth <= x.maxExtraBytes,
    exactlyOneMoreChunk: branch.chunks.length === main.chunks.length + 1,
    theExtraChunkIsThePushClient: split(branch).length === 1 && split(main).length === 0,
    uniqueJavaScriptWithinApproval: uniqueRaw <= x.maxUniqueJsRawBytes,
  };
  return {
    ok: Object.values(conditions).every(Boolean),
    conditions,
    growth,
    js: { mainRaw: sum(main, "bytes"), branchRaw: sum(branch, "bytes"), mainBr: sum(main, "brBytes"), branchBr: sum(branch, "brBytes"), sharedRaw, sharedBr, uniqueRaw, uniqueBr },
  };
}

/** The two assertions the proof makes on the selection. Both must hold; an empty selection fails both. */
export function dictionaryChunkVerdict(chunkCount: number, coveredCount: number, sentinelCount: number) {
  return {
    coverageOk: coveredCount >= Math.floor(sentinelCount * MIN_COVERAGE),
    countOk: chunkCount >= 1 && chunkCount <= MAX_DICTIONARY_FILES,
  };
}
