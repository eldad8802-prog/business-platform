/**
 * Appointment notes — appending a cancellation reason without ever breaking the row's length rule. PURE.
 *
 * The database holds notes to Appointment_text_length (char_length(notes) <= 4000, migration 20261029090000), and
 * every write is checked against it. A cancel appends its free-text reason to the notes; without a cap the sum could
 * pass 4000 and the cancel failed with a database error (500) instead of cancelling (owner P0-1, 2026-11-01).
 *
 * The rule, deterministic: what the notes already hold is never changed; the reason is appended on a new line, as
 * much of it as fits, and a cut reason ends with "…". When not even one character of it fits, the notes stay as
 * they were (the cancel itself, its closed reason and the journal are unaffected). Lengths count code points, as
 * PostgreSQL's char_length does, so a surrogate pair is never split.
 */

export const NOTES_MAX = 4000;
const CUT = "…";

const codePoints = (s: string) => Array.from(s);

export function mergeNote(existing: string | null, addition: string | null, max: number = NOTES_MAX): string | null {
  const add = addition?.trim();
  if (!add) return existing;
  const hasNotes = existing !== null && existing.trim().length > 0;
  const prefix = hasNotes ? `${existing}\n` : "";
  const room = max - codePoints(prefix).length;
  const parts = codePoints(add);
  if (parts.length <= room) return `${prefix}${add}`;
  if (room < 2) return existing; // only when the notes already fill the row (without notes the room is the whole max)
  return `${prefix}${parts.slice(0, room - 1).join("").trimEnd()}${CUT}`;
}
