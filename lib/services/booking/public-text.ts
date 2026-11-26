/**
 * Public booking — what a customer may type (G24, appointments completion program). Pure: no Node, no Prisma, so the
 * booking page and the server apply the SAME rules.
 *
 * Unicode bidirectional controls (LRE/RLE/PDF/LRO/RLO U+202A–U+202E, the isolates U+2066–U+2069, the marks LRM/RLM/ALM
 * U+200E/U+200F/U+061C) can make a name or a note DISPLAY differently from what it is (a "Trojan Source" style spoof of
 * the owner's request list, a lock screen or a WhatsApp line), and control characters (C0, DEL, C1, the line / paragraph
 * separators) have no place in a name or a phone. The rules:
 *   name    bidi controls or control characters → refused (the customer sees which field and retypes it);
 *   note    the same, except an ordinary line break (\n, \r\n) and a tab, which a multi-line note may hold;
 *   phone   bidi controls are STRIPPED first — a number copied from WhatsApp or a contact card arrives wrapped in
 *           U+202A … U+202C on many phones, and it is still the same number — then any other control character refuses.
 * Our own screens isolate customer text (FSI … PDI) when they put it into a Hebrew line; that isolation is added at
 * display time and is never accepted as input.
 */

/** Every Unicode bidirectional formatting character. */
export const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const BIDI_TEST = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** C0 controls, DEL, C1 controls, U+2028/U+2029. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
/** The same, minus TAB / LF / CR (a note may span lines). */
const CONTROL_EXCEPT_LINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;

export function hasBidiControl(text: string): boolean {
  return BIDI_TEST.test(text);
}

/** A name: no bidi control, no control character at all. */
export function nameTextProblem(text: string): boolean {
  return BIDI_TEST.test(text) || CONTROL.test(text);
}

/** A note: no bidi control, no control character other than a line break or a tab. */
export function noteTextProblem(text: string): boolean {
  return BIDI_TEST.test(text) || CONTROL_EXCEPT_LINES.test(text);
}

/** A phone as typed or pasted: bidi controls removed (they never change the number). */
export function stripPhoneBidi(raw: string): string {
  return raw.replace(BIDI_CONTROLS, "");
}

/** A phone after stripping: any remaining control character refuses it. */
export function phoneTextProblem(stripped: string): boolean {
  return CONTROL.test(stripped);
}
