// Release Event Log — payload sanitizer (single source of truth)
//
// Pure, dependency-free. Redacts anything that looks like a credential so the
// append-only Event Log can never persist a secret. Used by the event-log core
// and by the append-event CLI.

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_STRING = 2048;

// Key substrings that must never appear in a stored payload (redacted by key).
export const FORBIDDEN_KEY =
  /(secret|token|password|passwd|api[_-]?key|authorization|auth[_-]?token|credential|database_url|direct_url|conn(ection)?[_-]?string|bearer|private[_-]?key)/i;

// Value shapes that look like credentials/connection strings (redacted wholesale).
export const FORBIDDEN_VALUE =
  /(postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/|redis:\/\/|:\/\/[^\s/]*:[^\s/]*@|Bearer\s+\S+|sk-[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,})/;

// Recursively sanitize an arbitrary value. Forbidden keys and credential-shaped
// values become REDACTED; depth and string length are bounded.
export function sanitize(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'string') {
    if (FORBIDDEN_VALUE.test(value)) return REDACTED;
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…[truncated]' : value;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = FORBIDDEN_KEY.test(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  // functions/symbols/bigints/undefined are not serialized
  return undefined;
}

// Parse a payload that may arrive as a JSON string (CLI/env) or already-structured
// value, returning a sanitized object. Non-JSON strings become an opaque note.
export function parsePayload(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return sanitize(raw);
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return sanitize(parsed);
      return { value: sanitize(parsed) };
    } catch {
      return { note: sanitize(String(raw)) };
    }
  }
  return { value: sanitize(raw) };
}
