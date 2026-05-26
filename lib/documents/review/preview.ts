export function getPreviewKind(
  fileUrl: string,
  mimeType: string | null | undefined
): "pdf" | "image" | "unsupported" {
  const lowerUrl = fileUrl.toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();

  if (lowerMime.includes("pdf") || lowerUrl.endsWith(".pdf")) return "pdf";
  if (
    lowerMime.startsWith("image/") ||
    lowerUrl.endsWith(".png") ||
    lowerUrl.endsWith(".jpg") ||
    lowerUrl.endsWith(".jpeg") ||
    lowerUrl.endsWith(".webp")
  ) {
    return "image";
  }

  return "unsupported";
}
