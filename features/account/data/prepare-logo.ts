"use client";

/**
 * Turn a picked image file into a logo data URL the server will accept.
 *
 * The server is the authority (`/api/billing/invoice-profile`): PNG, JPEG or
 * WebP, as a base64 data URL of at most 500,000 characters. A phone photo is
 * many times that, so the picture is drawn onto a canvas no larger than the
 * logo is ever shown (512px) and re-encoded — keeping PNG for transparency
 * when it fits, else WebP, else JPEG — and only an encoding the server would
 * accept is returned.
 */

export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
export const LOGO_MAX_CHARS = 500_000;

const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SERVER_SHAPE = /^data:image\/(png|jpe?g|webp);base64,/i;
const SIZES = [512, 384, 256];

export type LogoPrepResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "type" | "unreadable" | "too_large" };

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("unreadable"));
    };
    img.src = url;
  });
}

function encode(img: HTMLImageElement, maxSide: number, type: string, quality?: number): string | null {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (type === "image/jpeg") {
    // JPEG has no transparency; a transparent logo gets a white ground, not black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL(type, quality);
  return SERVER_SHAPE.test(out) ? out : null;
}

export async function prepareLogo(file: File): Promise<LogoPrepResult> {
  if (!ACCEPTED_TYPES.has(file.type)) return { ok: false, reason: "type" };

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  for (const side of SIZES) {
    for (const [type, quality] of [
      ["image/png", undefined],
      ["image/webp", 0.9],
      ["image/jpeg", 0.88],
    ] as const) {
      const dataUrl = encode(img, side, type, quality);
      if (dataUrl && dataUrl.length <= LOGO_MAX_CHARS) return { ok: true, dataUrl };
    }
  }
  return { ok: false, reason: "too_large" };
}

export const LOGO_ERROR_MESSAGE: Record<"type" | "unreadable" | "too_large" | "rejected" | "failed", string> = {
  type: "אפשר להעלות לוגו בפורמט PNG, JPEG או WebP.",
  unreadable: "לא הצלחנו לקרוא את התמונה. נסו קובץ אחר.",
  too_large: "התמונה גדולה מדי גם לאחר הקטנה. נסו קובץ קטן יותר.",
  rejected: "הלוגו לא התקבל. נסו תמונה אחרת בפורמט PNG, JPEG או WebP.",
  failed: "שמירת הלוגו נכשלה. נסו שוב.",
};
