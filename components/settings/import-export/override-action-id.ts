/**
 * The client half of override action identity.
 *
 * The server decides whether an override is genuine. What it cannot decide is
 * WHICH override action a request belongs to — a retry of the one the owner
 * just took, or a new decision to override again. Only the screen knows that,
 * because only the screen knows whether the owner touched anything in between.
 *
 * So the screen mints an id when the owner turns an override ON, and holds it
 * for as long as that selection stands. Every attempt to run that same import
 * — the first one, the retry after a timeout, the second click on a button
 * that seemed not to respond — carries the same id and resolves to the same
 * run. Change the selection and the id is minted again, because that is a
 * different decision.
 *
 * Losing it is safe in the direction that matters. After a reload the owner
 * has to look at the duplicate and choose to override AGAIN, which is a new
 * deliberate act and is allowed to add a record. What cannot happen is the
 * reverse: an id alone never creates anything, because the server ignores one
 * that is not attached to a real override.
 */

/**
 * A fresh id for one deliberate override action.
 *
 * Opaque and URL-safe, matching the shape the server accepts. It is never
 * parsed, displayed, or given meaning — it only has to differ from the last
 * one and stay the same across retries.
 */
export function newOverrideActionId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
          .toString(36)
          .slice(2)}`;
  // Hyphens are allowed by the server's shape, but stripping them keeps the id
  // a single uniform token and comfortably inside the length bounds.
  return uuid.replace(/-/g, "").slice(0, 64).padEnd(32, "0");
}
