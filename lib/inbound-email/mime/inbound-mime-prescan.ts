import { MAX_MIME_PARTS } from "./inbound-mime-contract";

/**
 * A bounded structural pre-scan, and an honest account of what it proves.
 *
 * # Why this exists at all
 *
 * The parser enforces nesting depth itself — it takes `maxNestingDepth` and
 * throws during its own descent, which is the strongest place such a check can
 * live. It does not expose a part COUNT. Its result is a flattened object:
 * headers, addresses, subject, body, attachments. A message of two hundred and
 * one empty text parts and a message of one produce the same shape, so "how many
 * parts were there" cannot be answered from the output at all.
 *
 * So the count is measured before parsing, from the raw bytes.
 *
 * # What this is NOT
 *
 * It is not a MIME parser and must never become one. It does not decode, does
 * not build a tree, does not interpret headers beyond finding boundary
 * declarations, and never looks at content. A second parser would be a second
 * opinion about what a message means, and the two disagreeing is precisely the
 * bug class this whole area exists to avoid.
 *
 * # What it actually guarantees
 *
 * It reads the declared `boundary=` tokens, then counts the delimiter lines that
 * match one of them. Every part in a multipart body is introduced by such a
 * line, so the count is an UPPER BOUND on the number of parts: a message with
 * more parts than the limit always has more delimiters than the limit, and is
 * refused. The converse is not claimed. A body whose text happens to contain a
 * line identical to a declared boundary inflates the count, which can refuse a
 * message that was merely unlucky — the trade is deliberate, because a boundary
 * is supposed to be unguessable and failing closed is the safe direction.
 *
 * Bounded in its own right: it stops scanning once the limit is exceeded, so a
 * hostile message cannot make the pre-scan itself the expensive part.
 */
export type PrescanResult =
  | { ok: true; boundaryDelimiters: number }
  | { ok: false; code: "MIME_TOO_MANY_PARTS" };

/** How far into the message boundary declarations are still believed. */
const MAX_BOUNDARY_DECLARATIONS = 1000;

export function prescanMimeStructure(raw: Buffer): PrescanResult {
  // latin1 maps every byte to exactly one code unit, so offsets stay byte
  // offsets and no multi-byte sequence can hide a line break from the scan.
  const text = raw.toString("latin1");

  const boundaries = new Set<string>();
  const declaration = /boundary\s*=\s*(?:"([^"]{1,200})"|([^\s;"]{1,200}))/gi;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(text)) !== null) {
    const value = match[1] ?? match[2];
    if (value) boundaries.add(value);
    if (boundaries.size >= MAX_BOUNDARY_DECLARATIONS) break;
  }

  // No boundary declared means no multipart structure, so there is one part and
  // nothing to count. A malformed message that declares none is the parser's
  // problem, not this function's.
  if (boundaries.size === 0) return { ok: true, boundaryDelimiters: 0 };

  let delimiters = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    // Only the cheap shape is tested first; the set lookup happens for the few
    // lines that could possibly be delimiters.
    if (text.charCodeAt(lineStart) === 45 /* - */ && text.charCodeAt(lineStart + 1) === 45) {
      let line = text.slice(lineStart + 2, lineEnd);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.endsWith("--")) line = line.slice(0, -2);
      if (boundaries.has(line.trimEnd())) {
        delimiters += 1;
        // +1 so the closing delimiter of the outermost part does not make a
        // message of exactly the limit read as over it.
        if (delimiters > MAX_MIME_PARTS + 1) {
          return { ok: false, code: "MIME_TOO_MANY_PARTS" };
        }
      }
    }
    lineStart = lineEnd + 1;
  }

  return { ok: true, boundaryDelimiters: delimiters };
}
