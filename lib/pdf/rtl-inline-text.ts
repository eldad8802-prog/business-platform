/**
 * Right-to-left text for pdfmake documents. Pure — browser and server.
 *
 * pdfmake 0.3 has no bidi support. It lays a text's words out left to right, and fontkit then draws each word's glyphs
 * reversed when the word's first letter is from a right-to-left script, and as written otherwise. So a Hebrew line
 * kept as one word ("מלאי · Dubiz", spaces turned into NBSP) prints its Latin part backwards ("zibuD"), and a Hebrew
 * text left with its spaces ("מוצר א") reads in reversed word order ("א מוצר").
 *
 * rtlInlines returns the text as pdfmake inlines in VISUAL order (left to right), one inline per direction run, with
 * spaces as NBSP so pdfmake never splits a run into words: fontkit reverses the Hebrew runs into reading order and
 * leaves the Latin / digit runs as written. The paragraph direction is right to left (the documents are Hebrew), so a
 * text with no Hebrew at all comes out unchanged. A simplified Unicode bidi algorithm: digits run left to right with
 * their separators and %/#/currency signs, neutrals between two left-to-right runs join them, any other neutral takes
 * the paragraph direction; brackets in right-to-left runs are mirrored here (fontkit does not mirror them).
 * No bidi control characters are emitted (the Hebrew font draws them as squares), and incoming ones are dropped.
 */
export type PdfInline = { text: string };

const NBSP = " ";
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
const RTL_LETTER = /[\p{Script=Hebrew}\p{Script=Arabic}]/u;
const LTR_LETTER = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;
const NUMBER_SIGN = /[%#$€₪£°]/;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

type Dir = "R" | "L" | "N";

export function rtlInlines(value: string | null | undefined): PdfInline[] {
  const chars = [...String(value ?? "").replace(BIDI_CONTROLS, "")];
  if (chars.length === 0) return [{ text: "" }];

  const dir: Dir[] = chars.map((c) => (RTL_LETTER.test(c) ? "R" : LTR_LETTER.test(c) ? "L" : "N"));
  // a %/#/currency sign touching a digit belongs to the number
  for (let i = 0; i < chars.length; i++) {
    if (dir[i] === "N" && NUMBER_SIGN.test(chars[i]) && (DIGIT.test(chars[i - 1] ?? "") || DIGIT.test(chars[i + 1] ?? ""))) dir[i] = "L";
  }
  // neutrals: between two left-to-right runs they join them, otherwise they take the paragraph direction
  for (let i = 0; i < chars.length; ) {
    if (dir[i] !== "N") { i++; continue; }
    let j = i;
    while (j < chars.length && dir[j] === "N") j++;
    const resolved: Dir = dir[i - 1] === "L" && dir[j] === "L" ? "L" : "R";
    for (let k = i; k < j; k++) dir[k] = resolved;
    i = j;
  }

  const runs: { dir: Dir; text: string }[] = [];
  chars.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (last && last.dir === dir[i]) last.text += c;
    else runs.push({ dir: dir[i], text: c });
  });

  return runs.reverse().map((run) => {
    const text = run.text.replaceAll(" ", NBSP);
    if (run.dir === "L") return { text };
    // fontkit reverses a right-to-left run but does not mirror its brackets, and reverses it only when its first
    // letter is right-to-left: a run of neutrals alone (e.g. a closing bracket after Latin) is reversed here instead
    const mirrored = [...text].map((c) => MIRROR[c] ?? c);
    return { text: (RTL_LETTER.test(text) ? mirrored : mirrored.reverse()).join("") };
  });
}
