import { MAX_FILENAME_LENGTH } from "./inbound-mime-contract";

/**
 * Make a sender-supplied filename safe to STORE AS TEXT and show to a human.
 *
 * # What this is not
 *
 * It is not a path builder, and its output is never a path. Storage derives its
 * own object key from bytes it has already verified; nothing downstream may join
 * this string onto a directory. That is the real defence, and this function is
 * the second one: even if some future caller forgets, the value it receives
 * cannot contain a separator, a traversal or a drive letter.
 *
 * # Why the separators become an underscore rather than disappearing
 *
 * Deleting them silently turns `../../etc/passwd` into `etcpasswd`, which looks
 * like an innocent filename and hides that somebody tried. Replacing keeps the
 * shape visible to whoever reads the review queue, while still producing a
 * single flat segment.
 */
export function sanitizeAttachmentFilename(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  let value = String(raw);

  // 1. Control characters, including NUL. A NUL byte is how a string gets
  //    truncated by something written in C further down the stack, so
  //    `invoice.pdf\0.exe` must never survive as two different things to two
  //    different readers. The range covers C0 and C1 plus DEL.
  value = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

  // 2. Directory separators and anything that could reintroduce a path. Windows
  //    drive-letter prefixes go too: `C:\temp\x.pdf` must not keep its colon and
  //    read as a drive on a machine that believes in them.
  value = value.replace(/[\\/]+/g, "_").replace(/:/g, "_");

  // 3. Traversal. Done after separators are gone, so `..` can no longer combine
  //    with anything to climb, and a leading run of dots cannot produce `.` or
  //    `..` as the whole name.
  value = value.replace(/\.{2,}/g, ".");
  value = value.replace(/^\.+/, "");

  // 4. Unicode direction overrides. They reverse how a name RENDERS without
  //    changing what it is, which is how `fdp.exe` is shown as `exe.pdf` to the
  //    person deciding whether to trust it.
  value = value.replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "");

  // Ordinary whitespace is collapsed rather than stripped: Hebrew and other
  // scripts are expected here and must survive untouched, so only the characters
  // named above are removed.
  value = value.replace(/\s+/g, " ").trim();

  if (value.length > MAX_FILENAME_LENGTH) {
    value = value.slice(0, MAX_FILENAME_LENGTH).trim();
  }

  // Anything that reduced to nothing, or to a name that is only punctuation, is
  // worth less than an honest absence.
  if (value.length === 0 || /^[._\- ]+$/.test(value)) return null;

  return value;
}
