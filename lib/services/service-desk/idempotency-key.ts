/**
 * Service Desk — the idempotency key of a DERIVED journal row. SERVER-ONLY (node:crypto).
 *
 * One request can write more than one row under UNIQUE (businessId, idempotencyKey): the after-sale resolution's second
 * and later transitions, the part releases of a case cancel, the QA list event of an opening. Each such row needs its own
 * key, derived from the request's key and a step token. Every Service Desk key column has the same CHECK
 * `^[A-Za-z0-9:_#-]{8,200}$` (ServiceCaseEvent_tokens, ServicePartEvent, ServiceSettingsEvent …), so a plain
 * `${key}#${step}` could leave that range for a long (or a very short) client key and fail on the constraint instead of
 * answering cleanly.
 *
 *   PLAIN   `${clientKey}#${step}`                          when the client key is in the client alphabet [A-Za-z0-9_-]
 *                                                           (no ':' and no '#') and the result is 8..200 characters;
 *   HASHED  `h:${base64url(sha256(clientKey))}#${step}`     otherwise (2 + 43 + 1 + ≤ 32 ≤ 78 characters).
 *
 *   - deterministic: the same (clientKey, step) always gives the same key, so a replay finds the row it wrote;
 *   - injective: PLAIN never contains ':' and HASHED always does, so the two forms never meet; PLAIN splits at its only
 *     '#' (the client key has none); HASHED is as distinct as sha256 (a collision is not a practical event);
 *   - never a client key: every derived key contains '#', which no accepted client key has (prepare() takes a UUIDv7,
 *     IDEMPOTENCY_KEY_PATTERN is [A-Za-z0-9_-]), so a derived row can never answer another request's key;
 *   - always within the column CHECK: alphabet [A-Za-z0-9:_#-], length 8..200.
 *
 * Today's client keys are UUIDv7 (36 characters), for which the result is exactly the former `${key}#${step}` — rows
 * already written keep matching. A step token is a short server-chosen constant (`2`, `rel17`, …); anything else is a
 * programming error and throws.
 */
import { createHash } from "node:crypto";

/** The CHECK on every Service Desk idempotency key column. */
export const SERVICE_KEY_COLUMN = /^[A-Za-z0-9:_#-]{8,200}$/;
export const SERVICE_KEY_MIN = 8;
export const SERVICE_KEY_MAX = 200;
/** A step token: server-chosen, short, in the client alphabet. */
export const DERIVED_STEP = /^[A-Za-z0-9_-]{1,32}$/;
/** The prefix of the hashed form; ':' is outside every client alphabet and never in the plain form. */
export const HASHED_PREFIX = "h:";

const PLAIN_CLIENT_KEY = /^[A-Za-z0-9_-]+$/;

export function deriveIdempotencyKey(clientKey: string, step: string | number): string {
  const s = String(step);
  if (!DERIVED_STEP.test(s)) throw new Error("deriveIdempotencyKey: invalid step token");
  if (typeof clientKey !== "string" || clientKey.length === 0) throw new Error("deriveIdempotencyKey: empty client key");
  const plain = `${clientKey}#${s}`;
  if (PLAIN_CLIENT_KEY.test(clientKey) && plain.length >= SERVICE_KEY_MIN && plain.length <= SERVICE_KEY_MAX) return plain;
  const digest = createHash("sha256").update(clientKey, "utf8").digest("base64url");
  return `${HASHED_PREFIX}${digest}#${s}`;
}
