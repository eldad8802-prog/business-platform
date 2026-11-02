/**
 * Revenue report uploads — the parser registry. docs/revenue-report-uploads.md.
 *
 * SHIPPED EMPTY, ON PURPOSE. Dubiz has no real Z report or settlement report from any source system yet, and a
 * parser written from a guess would record wrong money as truth. Until a real sample arrives (and its parser is
 * reviewed with that sample as a test fixture), every upload answers FORMAT_NOT_SUPPORTED with a request to send
 * a sample. Adding a vendor = one parser module + one line in SHIPPED_PARSERS + its fixture test.
 *
 * Tests register a TEST-ONLY fixture parser through `createParserRegistry` inside the test file itself; nothing
 * test-only is ever listed here (core.test.ts asserts the shipped registry is empty).
 *
 * Pure: no I/O.
 */
import type { ParserOf, ReportFile, ReportKind, ReportParser } from "./contract";

const PARSER_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** Below this, a parser's "maybe" is not a match. */
export const DETECT_THRESHOLD = 0.5;

export type ParserRegistry = {
  readonly parsers: readonly ReportParser[];
  /** The one parser for this file, or why there is none. */
  select<K extends ReportKind>(kind: K, file: ReportFile): ParserSelection<K>;
  byKey<K extends ReportKind>(kind: K, key: string): ParserOf<K> | null;
};

export type ParserSelection<K extends ReportKind> =
  | { ok: true; parser: ParserOf<K>; confidence: number }
  | { ok: false; reason: "NO_PARSER" | "AMBIGUOUS" };

export function createParserRegistry(parsers: readonly ReportParser[]): ParserRegistry {
  const seen = new Set<string>();
  for (const p of parsers) {
    if (!PARSER_KEY.test(p.key)) throw new Error(`revenue report parser key "${p.key}" is not a token`);
    if (!Number.isInteger(p.version) || p.version < 1) throw new Error(`revenue report parser "${p.key}": version must be a positive integer`);
    const id = `${p.kind}:${p.key}`;
    if (seen.has(id)) throw new Error(`revenue report parser "${id}" registered twice`);
    seen.add(id);
  }
  const frozen = Object.freeze([...parsers]);

  return {
    parsers: frozen,
    select<K extends ReportKind>(kind: K, file: ReportFile): ParserSelection<K> {
      const scored: { parser: ParserOf<K>; confidence: number }[] = [];
      for (const p of frozen) {
        if (p.kind !== kind) continue;
        let c = 0;
        try {
          c = p.detect(file);
        } catch {
          c = 0; // A detector that throws has not recognised the file.
        }
        if (Number.isFinite(c) && c >= DETECT_THRESHOLD) scored.push({ parser: p as ParserOf<K>, confidence: Math.min(1, c) });
      }
      if (scored.length === 0) return { ok: false, reason: "NO_PARSER" };
      scored.sort((a, b) => b.confidence - a.confidence);
      // Two parsers equally sure of one file: never pick one silently.
      if (scored.length > 1 && scored[0].confidence === scored[1].confidence) return { ok: false, reason: "AMBIGUOUS" };
      return { ok: true, parser: scored[0].parser, confidence: scored[0].confidence };
    },
    byKey<K extends ReportKind>(kind: K, key: string): ParserOf<K> | null {
      return (frozen.find((p) => p.kind === kind && p.key === key) as ParserOf<K> | undefined) ?? null;
    },
  };
}

/**
 * The parsers Dubiz ships. EMPTY until a real sample of a source system's report has been received and its parser
 * reviewed against it. Do not add a parser written from documentation or a guess.
 */
export const SHIPPED_PARSERS: readonly ReportParser[] = Object.freeze([]);

export const SHIPPED_REGISTRY: ParserRegistry = createParserRegistry(SHIPPED_PARSERS);
