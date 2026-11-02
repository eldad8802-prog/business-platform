/**
 * Documents illustrations — the approved hand-drawn set in
 * public/illustrations/documents/ (sage / terracotta blobs, ink line art).
 * Always decorative: the surrounding text names the state, so alt is empty.
 */
export type DocumentsIllustrationName = "upload" | "camera" | "search" | "verify" | "accountant-pack";

export default function DocumentsIllustration({
  name,
  width,
  style,
}: {
  name: DocumentsIllustrationName;
  width: number;
  style?: React.CSSProperties;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static SVG asset; next/image adds nothing for SVG
    <img
      src={`/illustrations/documents/${name}.svg`}
      alt=""
      aria-hidden
      width={width}
      height={Math.round((width * 190) / 240)}
      draggable={false}
      style={{ display: "block", maxWidth: "100%", height: "auto", ...style }}
    />
  );
}
