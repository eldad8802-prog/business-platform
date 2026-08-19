/**
 * Business Memory SHADOW-2 · kill switch (fail-closed).
 *
 * Shadow materialization is OFF unless BUSINESS_MEMORY_SHADOW is EXPLICITLY the string "true"
 * (trimmed, case-insensitive). Absent / empty / "false" / malformed ⇒ OFF. No tenant flag, no DB flag,
 * no dynamic rollout, no UI. Enabling in Production is a separate, separately-approved step.
 */
export function isShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.BUSINESS_MEMORY_SHADOW;
  return typeof v === "string" && v.trim().toLowerCase() === "true";
}
