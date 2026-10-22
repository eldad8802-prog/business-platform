/**
 * What an auth / signup route may log about an unexpected error.
 *
 * A whole error object can carry what a log line must not: Prisma's validation and request errors
 * embed the failing invocation (the address, the password hash, the session secret), a driver error
 * can carry the connection string, and `cause` chains drag in whatever the inner library held. So the
 * auth routes log only the error's CLASS and its machine CODE — enough to tell a database outage
 * (P1001, ECONNRESET) from a constraint (P2002) from a bug (TypeError) — and never its message,
 * meta, cause or stack.
 */

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

export type SafeErrorSummary = { error: string; code?: string };

export function safeErrorSummary(error: unknown): SafeErrorSummary {
  if (!(error instanceof Error)) return { error: typeof error === "object" && error !== null ? "NonError" : typeof error };
  const name = SAFE_CODE.test(error.name) ? error.name : "Error";
  const raw = (error as { code?: unknown; errorCode?: unknown }).code ?? (error as { errorCode?: unknown }).errorCode;
  const code = typeof raw === "string" && SAFE_CODE.test(raw) ? raw : typeof raw === "number" ? String(raw) : undefined;
  return code ? { error: name, code } : { error: name };
}
