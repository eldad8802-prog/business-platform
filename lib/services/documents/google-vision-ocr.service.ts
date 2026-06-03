import vision, { ImageAnnotatorClient } from "@google-cloud/vision";
import fs from "fs";
import path from "path";

const CREDENTIALS_ENV = "GOOGLE_VISION_CREDENTIALS_JSON";

export class GoogleVisionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleVisionConfigError";
  }
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

      const [batchResult] = await client.batchAnnotateFiles({
        requests: [
          {
            inputConfig: {
              mimeType: "application/pdf",
              content: pdfBytes,
            },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      });

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

    const [result] = await client.textDetection(filePath);

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
