/**
 * SEC-F — the error-observability seam.
 *
 * One function every server error path can call, one scrubber every error
 * passes through before it leaves the process, and an adapter interface so a
 * monitoring vendor (Sentry, Datadog, …) is a one-file decision for the owner
 * rather than a refactor. The default adapter writes one structured console
 * line — the product's current behaviour, minus the personal data.
 *
 * The scrubber is deliberately aggressive: an error message is free text that
 * any library may have filled with a request body. It removes bearer tokens,
 * JWT-shaped strings, Authorization / Cookie / Set-Cookie values, key=value
 * secrets, email addresses, phone numbers, IBAN-like and card-like numbers and
 * Israeli-ID-like 9-digit numbers, and it drops whole context keys whose names
 * say they carry credentials or contact data.
 */

export type ErrorContext = Record<string, unknown>;

export type ScrubbedError = {
  name: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  at: string;
};

export interface ErrorReporterAdapter {
  readonly name: string;
  report(error: ScrubbedError): void | Promise<void>;
}

const REDACTED = "[redacted]";

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization / cookie headers rendered into text
  [/\b(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+(\s+[^\s,;]+)?/gi, "$1: [redacted]"],
  [/\b(set-cookie|cookie)\s*[:=]\s*[^\n]*/gi, "$1: [redacted]"],
  [/\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]"],
  // JWT-shaped
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]"],
  // key=value / "key": "value" secrets
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|pwd|client[_-]?secret|signature|otp)["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi, "$1[redacted]"],
  // connection strings with credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@"],
  // email
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  // IBAN-like (country code + 2 check digits + 11..30 alnum, optional spaces)
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, "[redacted-iban]"],
  // card-like: 13–19 digits, optionally separated
  [/\b(?:\d[ -]?){12,18}\d\b/g, "[redacted-number]"],
  // phone: +972 / 05x / international forms
  [/(?:\+|00)\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}/g, "[redacted-phone]"],
  [/\b0\d{1,2}[\s-]?\d{3}[\s-]?\d{4}\b/g, "[redacted-phone]"],
  // Israeli-ID-like (exactly 9 digits)
  [/\b\d{9}\b/g, "[redacted-id]"],
];

const SENSITIVE_CONTEXT_KEY = /token|password|passwd|secret|cookie|authori[sz]ation|bearer|e-?mail|phone|otp|credential|iban|card|taxid|idnumber|body|payload|headers/i;

export function scrubText(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out.length > 4000 ? `${out.slice(0, 4000)}…` : out;
}

export function scrubValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = SENSITIVE_CONTEXT_KEY.test(k) ? REDACTED : scrubValue(v, depth + 1);
    }
    return out;
  }
  return String(typeof value);
}

export function scrubError(error: unknown, context: ErrorContext = {}): ScrubbedError {
  const e = error instanceof Error ? error : null;
  return {
    name: e?.name ?? typeof error,
    message: scrubText(e?.message ?? (typeof error === "string" ? error : "non-Error thrown")),
    stack: e?.stack ? scrubText(e.stack.split("\n").slice(0, 12).join("\n")) : null,
    context: scrubValue(context) as Record<string, unknown>,
    at: new Date().toISOString(),
  };
}

export const consoleErrorAdapter: ErrorReporterAdapter = {
  name: "console",
  report(err) {
    console.error(JSON.stringify({ event: "SERVER_ERROR", ...err }));
  },
};

let adapter: ErrorReporterAdapter = consoleErrorAdapter;

/** Install a vendor adapter (owner decision). Returns the previous one. */
export function setErrorReporterAdapter(next: ErrorReporterAdapter): ErrorReporterAdapter {
  const prev = adapter;
  adapter = next;
  return prev;
}

/** Report an error. Never throws; a failing adapter falls back to the console. */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  let scrubbed: ScrubbedError;
  try {
    scrubbed = scrubError(error, context);
  } catch {
    console.error(JSON.stringify({ event: "SERVER_ERROR", name: "ScrubberFailure" }));
    return;
  }
  try {
    const r = adapter.report(scrubbed);
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => consoleErrorAdapter.report(scrubbed));
    }
  } catch {
    consoleErrorAdapter.report(scrubbed);
  }
}
