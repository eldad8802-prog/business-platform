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
 * text with no Hebrew at all comes out unchanged. A simplified Unicode bidi algorithm: a number keeps its separators and
 * %/#/currency signs and goes with a Latin word before it; neutrals between two Latin runs join them, any other takes
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
const NUMBER_SEPARATOR = /[.,:/-]/;
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };

// R: right-to-left letter · L: other letter · EN: number · N: neutral (space, punctuation)
type Dir = "R" | "L" | "EN" | "N";

export function rtlInlines(value: string | null | undefined): PdfInline[] {
  const chars = [...String(value ?? "").replace(BIDI_CONTROLS, "")];
  if (chars.length === 0) return [{ text: "" }];

  const dir: Dir[] = chars.map((c) => (RTL_LETTER.test(c) ? "R" : DIGIT.test(c) ? "EN" : LTR_LETTER.test(c) ? "L" : "N"));
  // a separator between two digits (1.5, 1,000, 12:30, 3/4, 2-3) and a %/#/currency sign touching a number belong to it
  for (let i = 1; i < chars.length - 1; i++) {
    if (dir[i] === "N" && NUMBER_SEPARATOR.test(chars[i]) && dir[i - 1] === "EN" && dir[i + 1] === "EN") dir[i] = "EN";
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < chars.length; i++) {
      if (dir[i] === "N" && NUMBER_SIGN.test(chars[i]) && (dir[i - 1] === "EN" || dir[i + 1] === "EN")) { dir[i] = "EN"; changed = true; }
    }
  }
  // a number after a Latin word goes with it (iPhone 15); after Hebrew, or at the start, it stands alone
  let lastStrong: "R" | "L" = "R";
  for (let i = 0; i < chars.length; i++) {
    if (dir[i] === "R" || dir[i] === "L") lastStrong = dir[i] as "R" | "L";
    else if (dir[i] === "EN" && lastStrong === "L") dir[i] = "L";
  }
  // neutrals: between two Latin runs they join them, otherwise (numbers count as right-to-left here) they take the
  // paragraph direction — so "3% 1" inside Hebrew stays two numbers read right to left
  const side = (d: Dir | undefined): "R" | "L" => (d === "L" ? "L" : "R");
  for (let i = 0; i < chars.length; ) {
    if (dir[i] !== "N") { i++; continue; }
    let j = i;
    while (j < chars.length && dir[j] === "N") j++;
    const resolved: Dir = side(dir[i - 1]) === "L" && side(dir[j]) === "L" ? "L" : "R";
    for (let k = i; k < j; k++) dir[k] = resolved;
    i = j;
  }

  // Latin letters and numbers next to each other display as one left-to-right run (1.5L)
  const runs: { dir: "R" | "L"; text: string }[] = [];
  chars.forEach((c, i) => {
    const d = dir[i] === "R" ? "R" : "L";
    const last = runs[runs.length - 1];
    if (last && last.dir === d) last.text += c;
    else runs.push({ dir: d, text: c });
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
