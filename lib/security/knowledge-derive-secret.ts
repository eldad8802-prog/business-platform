/**
 * L-8 — which secret authenticates the knowledge-derive scheduler.
 *
 * The derive route used to share CRON_SECRET with settlement recovery, so one leaked
 * bearer opened both a money-recovery path and a tenant-writing derivation path.
 * This gives the derive route a credential of its own.
 *
 * RESOLUTION (deliberately explicit, never silent):
 *   - KNOWLEDGE_DERIVE_SECRET set (non-blank)  -> it is the ONLY accepted secret.
 *     CRON_SECRET no longer opens this route. If the dedicated secret is too short
 *     the route is NOT_CONFIGURED (fail closed) — it never falls back to CRON_SECRET.
 *   - KNOWLEDGE_DERIVE_SECRET unset/blank      -> TRANSITIONAL fallback to CRON_SECRET,
 *     with a one-time warning, so the scheduled derive keeps working until the owner
 *     provisions the dedicated secret. The fallback is an owner action to remove.
 *
 * Secret values are never logged or returned; only the SOURCE name is.
 */
export type KnowledgeDeriveSecretSource =
  | "KNOWLEDGE_DERIVE_SECRET"
  | "CRON_SECRET_FALLBACK"
  | "NONE";

export type KnowledgeDeriveSecret = {
  secret: string | undefined;
  source: KnowledgeDeriveSecretSource;
};

let warned = false;

export function resolveKnowledgeDeriveSecret(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = (m) => console.warn(m)
): KnowledgeDeriveSecret {
  const dedicated = env.KNOWLEDGE_DERIVE_SECRET?.trim();
  if (dedicated) {
    return { secret: dedicated, source: "KNOWLEDGE_DERIVE_SECRET" };
  }
  const shared = env.CRON_SECRET?.trim();
  if (shared) {
    if (!warned) {
      warned = true;
      warn(
        "[knowledge/derive] KNOWLEDGE_DERIVE_SECRET is not set — falling back to CRON_SECRET " +
          "(transitional). Provision a dedicated secret and remove the fallback."
      );
    }
    return { secret: shared, source: "CRON_SECRET_FALLBACK" };
  }
  return { secret: undefined, source: "NONE" };
}

/** Test seam: reset the one-time warning latch. */
export function __resetKnowledgeDeriveSecretWarning(): void {
  warned = false;
}
