export function normalizeText(raw: string): string {
  if (!raw) return "";

  return raw
    .replace(/\r/g, "")
    .replace(/\n+/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}