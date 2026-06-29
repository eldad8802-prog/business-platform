import vision, { ImageAnnotatorClient } from "@google-cloud/vision";
import fs from "fs";
import path from "path";

const CREDENTIALS_ENV = "GOOGLE_VISION_CREDENTIALS_JSON";

/**
 * Hard ceiling on a single Vision call. Without it, a large/slow PDF can hang
 * the request until the platform function timeout (→ 500 with nothing saved).
 * A timeout here surfaces as a normal OCR error, so callers persist the file as
 * a needs_review document instead of losing it. Override via OCR_TIMEOUT_MS.
 */
const OCR_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OCR_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

export class GoogleVisionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleVisionConfigError";
  }
}

export class GoogleVisionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleVisionTimeoutError";
  }
}

function withOcrTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new GoogleVisionTimeoutError(
          `Google Vision ${label} timed out after ${OCR_TIMEOUT_MS}ms`
        )
      );
    }, OCR_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function legacyCredentialsPath(): string {
  return path.join(process.cwd(), "secrets/google-vision-key.json");
}

function parseCredentialsFromEnv(): Record<string, unknown> | null {
  const raw = process.env[CREDENTIALS_ENV]?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GoogleVisionConfigError(
        `${CREDENTIALS_ENV} must be a JSON object`
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GoogleVisionConfigError) {
      throw error;
    }
    throw new GoogleVisionConfigError(`${CREDENTIALS_ENV} is invalid JSON`);
  }
}

function createVisionClient(): ImageAnnotatorClient {
  const fromEnv = parseCredentialsFromEnv();
  if (fromEnv) {
    return new vision.ImageAnnotatorClient({
      credentials: fromEnv,
      fallback: true,
    });
  }

  if (process.env.NODE_ENV === "production") {
    throw new GoogleVisionConfigError(
      "Google Vision credentials not configured. Set GOOGLE_VISION_CREDENTIALS_JSON in production."
    );
  }

  const credentialsPath = legacyCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    return new vision.ImageAnnotatorClient({
      keyFilename: credentialsPath,
      fallback: true,
    });
  }

  throw new GoogleVisionConfigError(
    "Google Vision credentials not configured. Set GOOGLE_VISION_CREDENTIALS_JSON or provide secrets/google-vision-key.json"
  );
}

export async function runGoogleVisionOCR(
  filePath: string,
  mimeType?: string
): Promise<string> {
  try {
    console.log("========== GOOGLE VISION OCR START ==========");
    console.log("filePath:", filePath);
    console.log("mimeType:", mimeType);
    console.log("credentials source:", parseCredentialsFromEnv() ? "env" : "file");

    const client = createVisionClient();

    if (!fs.existsSync(filePath)) {
      throw new Error("File not found for OCR");
    }
    const isPdf =
      mimeType === "application/pdf" ||
      filePath.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      console.log("GOOGLE VISION OCR: PDF detected");

      const pdfBytes = fs.readFileSync(filePath);

      const [batchResult] = await withOcrTimeout(
        client.batchAnnotateFiles({
          requests: [
            {
              inputConfig: {
                mimeType: "application/pdf",
                content: pdfBytes,
              },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            },
          ],
        }),
        "batchAnnotateFiles"
      );

      const pages = batchResult.responses?.[0]?.responses ?? [];
      const text = pages
        .map((p: { fullTextAnnotation?: { text?: string | null } | null }) =>
          p.fullTextAnnotation?.text || ""
        )
        .join("\n")
        .trim();

      console.log("PDF pages:", pages.length);
      console.log("PDF text length:", text.length);
      console.log("PDF preview:", text.slice(0, 300));

      return text;
    }

    console.log("GOOGLE VISION OCR: image detected");

    const [result] = await withOcrTimeout(
      client.textDetection(filePath),
      "textDetection"
    );

    const text = result.fullTextAnnotation?.text || "";

    console.log("IMAGE text length:", text.length);
    console.log("IMAGE preview:", text.slice(0, 300));

    return text.trim();
  } catch (error: unknown) {
    console.error("========== GOOGLE VISION OCR ERROR ==========");
    console.error(error);
    console.error("============================================");
    throw error;
  }
}

// ===========================================================================
// T1 — Geometry Acquisition (SHADOW ONLY)
//
// Google Vision already returns per-word bounding boxes inside
// `fullTextAnnotation.pages[].blocks[].paragraphs[].words[]`. The production
// `runGoogleVisionOCR` above keeps ONLY `.text` and discards that geometry.
//
// The exports below are ADDITIVE: they do NOT modify `runGoogleVisionOCR`, its
// signature, its text output, or any existing caller. They expose token +
// geometry through a separate shadow function for offline/eval use only. No
// interpretation, no grouping, no amount detection, no DB, no production wiring.
// ===========================================================================

export type OcrBoundingBox = {
  /** min-x of the word's vertices (pixel coords for images; may be normalized for PDF). */
  x: number;
  /** min-y of the word's vertices. */
  y: number;
  width: number;
  height: number;
};

export type OcrToken = {
  /** Word value reconstructed by concatenating Vision symbol texts. */
  value: string;
  /** 1-based page number. */
  page: number;
  /** null when Vision provided no usable vertices for this word — never guessed. */
  bbox: OcrBoundingBox | null;
  /** 0..1 when Vision provides it; otherwise null. */
  confidence: number | null;
  provenance: { source: "google_vision"; unit: "word"; page: number };
};

export type OcrGeometryResult = {
  /** Same text extraction as runGoogleVisionOCR (shadow copy; production path unchanged). */
  text: string;
  tokens: OcrToken[];
  /** true iff at least one token carries a bounding box. */
  geometryAvailable: boolean;
  pageCount: number;
};

// Minimal structural view of the Vision response we read from. Intentionally
// permissive so a token with missing fields is handled, never assumed.
type VisionVertex = { x?: number | null; y?: number | null };
type VisionBoundingPoly = {
  vertices?: VisionVertex[] | null;
  normalizedVertices?: VisionVertex[] | null;
};
type VisionWord = {
  symbols?: { text?: string | null }[] | null;
  boundingBox?: VisionBoundingPoly | null;
  confidence?: number | null;
};
type VisionParagraph = { words?: VisionWord[] | null };
type VisionBlock = { paragraphs?: VisionParagraph[] | null };
type VisionPage = { blocks?: VisionBlock[] | null };
export type VisionFullTextAnnotation = {
  text?: string | null;
  pages?: VisionPage[] | null;
};

/** Pure: derive an axis-aligned box from a Vision bounding poly, or null. */
export function boundingBoxFromPoly(
  poly: VisionBoundingPoly | null | undefined
): OcrBoundingBox | null {
  const raw =
    poly?.vertices && poly.vertices.length > 0
      ? poly.vertices
      : poly?.normalizedVertices ?? [];

  const xs = raw
    .map((v) => v?.x)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const ys = raw
    .map((v) => v?.y)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

  if (xs.length === 0 || ys.length === 0) return null;

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pure: walk a fullTextAnnotation and emit word-level tokens with geometry. */
export function extractTokensFromFullTextAnnotation(
  fta: VisionFullTextAnnotation | null | undefined,
  pageNumber: number
): OcrToken[] {
  const tokens: OcrToken[] = [];

  for (const page of fta?.pages ?? []) {
    for (const block of page?.blocks ?? []) {
      for (const paragraph of block?.paragraphs ?? []) {
        for (const word of paragraph?.words ?? []) {
          const value = (word?.symbols ?? [])
            .map((s) => s?.text ?? "")
            .join("");

          if (value.length === 0) continue;

          tokens.push({
            value,
            page: pageNumber,
            bbox: boundingBoxFromPoly(word?.boundingBox),
            confidence:
              typeof word?.confidence === "number" ? word.confidence : null,
            provenance: { source: "google_vision", unit: "word", page: pageNumber },
          });
        }
      }
    }
  }

  return tokens;
}

/**
 * SHADOW: run the same Vision call as production, but ALSO return tokens with
 * geometry. The returned `text` mirrors runGoogleVisionOCR; production keeps
 * calling runGoogleVisionOCR and is unaffected.
 */
export async function runGoogleVisionOCRWithGeometry(
  filePath: string,
  mimeType?: string
): Promise<OcrGeometryResult> {
  const client = createVisionClient();

  if (!fs.existsSync(filePath)) {
    throw new Error("File not found for OCR");
  }

  const isPdf =
    mimeType === "application/pdf" || filePath.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    const pdfBytes = fs.readFileSync(filePath);

    const [batchResult] = await withOcrTimeout(
      client.batchAnnotateFiles({
        requests: [
          {
            inputConfig: { mimeType: "application/pdf", content: pdfBytes },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
      "batchAnnotateFiles"
    );

    const pageResponses = batchResult.responses?.[0]?.responses ?? [];

    const text = pageResponses
      .map((p) => p.fullTextAnnotation?.text || "")
      .join("\n")
      .trim();

    const tokens: OcrToken[] = [];
    pageResponses.forEach((p, index) => {
      tokens.push(
        ...extractTokensFromFullTextAnnotation(
          p.fullTextAnnotation as unknown as VisionFullTextAnnotation | null,
          index + 1
        )
      );
    });

    return {
      text,
      tokens,
      geometryAvailable: tokens.some((t) => t.bbox !== null),
      pageCount: pageResponses.length,
    };
  }

  const [result] = await withOcrTimeout(
    client.textDetection(filePath),
    "textDetection"
  );

  const text = (result.fullTextAnnotation?.text || "").trim();
  const tokens = extractTokensFromFullTextAnnotation(
    result.fullTextAnnotation as unknown as VisionFullTextAnnotation | null,
    1
  );

  return {
    text,
    tokens,
    geometryAvailable: tokens.some((t) => t.bbox !== null),
    pageCount: result.fullTextAnnotation?.pages?.length ?? (tokens.length > 0 ? 1 : 0),
  };
}
