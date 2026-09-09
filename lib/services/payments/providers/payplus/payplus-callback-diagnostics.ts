/**
 * TEMPORARY, OPT-IN capture for the FIRST real PayPlus sandbox callbacks.
 *
 * WHY THIS EXISTS. Three things about PayPlus's callback are documented
 * ambiguously and can only be settled by looking at a real delivery:
 *
 *   1. the HTTP method — the reference is shaped as a GET, which is unusual for
 *      a signed JSON callback;
 *   2. WHICH STRING IS SIGNED — the signature sample hashes
 *      `JSON.stringify(response.body)`, a re-serialised object, not the bytes on
 *      the wire. The two are usually identical and sometimes are not;
 *   3. retry and duplicate behaviour, which nothing in the reference states.
 *
 * Without a capture, a failed sandbox run teaches us nothing: the orchestration
 * refuses an unverifiable callback with a bare `signature_mismatch` and keeps no
 * copy of what arrived. That is correct for production and useless for a first
 * integration, which is exactly the gap this fills.
 *
 * WHAT IT DELIBERATELY DOES NOT CAPTURE. The record below is built to be safe to
 * read in a log:
 *
 *   - no request body, ever. A PayPlus callback carries an amount, a masked card
 *     and possibly a payer name or email. The body is reduced to a length, a
 *     SHA-256 and its top-level KEY NAMES;
 *   - no header VALUES except an allowlist of three that carry no secret and are
 *     needed to answer the questions above;
 *   - no query VALUES, only names — a bypass token can legitimately ride in the
 *     query string, so values there are treated as secret by default;
 *   - no credential, key or signing material of any kind. The merchant's secret
 *     is not even reachable from here.
 *
 * The SHA-256 of the body is what makes retry and duplicate behaviour legible:
 * two deliveries with the same digest are the same bytes redelivered, and two
 * with different digests are different events. It reveals nothing about content.
 *
 * This module is PURE. It performs no logging and reads no environment; the
 * caller decides whether to record anything. Delete it once the sandbox run has
 * answered the questions.
 */

import { createHash } from "node:crypto";

/**
 * Header values that may be recorded verbatim.
 *
 * `hash` is the callback's signature. It is an HMAC DIGEST, not the key, so
 * recording it cannot expose the merchant's secret — and it is the one value
 * that lets the signed-string question be re-checked offline afterwards.
 */
const SAFE_HEADER_VALUES = ["user-agent", "content-type", "hash"] as const;

export interface PayPlusCallbackDiagnostic {
  /** GET or POST — question 1, answered directly. */
  method: string;
  /** The route's own path. Never the query string. */
  path: string;
  contentType: string | null;
  /** Every header NAME that arrived, sorted. Values are not included. */
  headerNames: string[];
  /** The few header values that are safe to record. */
  headers: Record<string, string>;
  /** Query parameter NAMES only. A bypass token can ride here. */
  queryNames: string[];
  bodyLength: number;
  /** Stable identity of the bytes, with no way back to their content. */
  bodySha256: string | null;
  /** True when the body parsed as JSON at all. */
  bodyIsJson: boolean;
  /**
   * Question 2, answered without needing the secret: when re-serialising the
   * parsed body reproduces the received bytes exactly, the two signature
   * candidates are the SAME string and the ambiguity is moot for this delivery.
   */
  reserializedEqualsRaw: boolean | null;
  /** Digest of the re-serialised form, for the case where it differs. */
  reserializedSha256: string | null;
  /** Top-level key NAMES of the JSON body. No values. */
  topLevelKeys: string[];
  /** Key NAMES nested under `transaction`, which is where PayPlus nests. */
  transactionKeys: string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function keyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

export function buildPayPlusCallbackDiagnostic(input: {
  method: string;
  url: string;
  headers: Record<string, string | null | undefined>;
  rawBody: string;
}): PayPlusCallbackDiagnostic {
  const headerNames = Object.keys(input.headers)
    .map((k) => k.toLowerCase())
    .sort();

  const headers: Record<string, string> = {};
  for (const name of SAFE_HEADER_VALUES) {
    const value = input.headers[name];
    if (typeof value === "string" && value.length > 0) {
      headers[name] = value;
    }
  }

  let path = input.url;
  let queryNames: string[] = [];
  try {
    const parsed = new URL(input.url);
    path = parsed.pathname;
    queryNames = [...parsed.searchParams.keys()].sort();
  } catch {
    // A relative or malformed URL is itself worth seeing; keep it as given
    // rather than throwing inside a diagnostic.
  }

  const rawBody = input.rawBody ?? "";
  let parsedBody: unknown = null;
  let bodyIsJson = false;
  try {
    parsedBody = JSON.parse(rawBody);
    bodyIsJson = true;
  } catch {
    bodyIsJson = false;
  }

  let reserialized: string | null = null;
  if (bodyIsJson) {
    try {
      reserialized = JSON.stringify(parsedBody);
    } catch {
      reserialized = null;
    }
  }

  const transaction =
    parsedBody && typeof parsedBody === "object"
      ? (parsedBody as Record<string, unknown>).transaction
      : undefined;

  return {
    method: input.method,
    path,
    contentType: headers["content-type"] ?? null,
    headerNames,
    headers,
    queryNames,
    bodyLength: rawBody.length,
    bodySha256: rawBody.length > 0 ? sha256(rawBody) : null,
    bodyIsJson,
    reserializedEqualsRaw:
      reserialized === null ? null : reserialized === rawBody,
    reserializedSha256: reserialized === null ? null : sha256(reserialized),
    topLevelKeys: keyNames(parsedBody),
    transactionKeys: keyNames(transaction),
  };
}

/**
 * The single switch. Absent or anything other than "1" means the capture never
 * runs and the route behaves exactly as it does today — so this cannot be left
 * on by accident, and shipping it disabled costs nothing.
 */
export function payPlusDiagnosticsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PAYPLUS_CALLBACK_DIAGNOSTICS === "1";
}
