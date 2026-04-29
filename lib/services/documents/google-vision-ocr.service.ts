import vision from "@google-cloud/vision";
import fs from "fs";
import path from "path";

function resolveCredentialsPath() {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!envPath) {
    console.error("GOOGLE VISION OCR: GOOGLE_APPLICATION_CREDENTIALS is missing");
    return null;
  }

  const absolutePath = path.isAbsolute(envPath)
    ? envPath
    : path.join(process.cwd(), envPath);

  return absolutePath;
}

export async function runGoogleVisionOCR(
  filePath: string,
  mimeType?: string
): Promise<string> {
  try {
    console.log("GOOGLE VISION OCR: starting");

    const credentialsPath = resolveCredentialsPath();

    if (!credentialsPath || !fs.existsSync(credentialsPath)) {
      throw new Error("Google Vision credentials file not found");
    }

    if (!fs.existsSync(filePath)) {
      throw new Error("File not found for OCR");
    }

    const client = new vision.ImageAnnotatorClient({
      keyFilename: credentialsPath,
    });

    const isPdf =
      mimeType === "application/pdf" ||
      filePath.toLowerCase().endsWith(".pdf");

    // 🔥 PDF → שימוש ב־documentTextDetection
    if (isPdf) {
      console.log("GOOGLE VISION OCR: PDF detected");

      const [result] = await client.documentTextDetection(filePath);

      const text = result.fullTextAnnotation?.text || "";

      console.log("GOOGLE VISION OCR: PDF text length:", text.length);
      console.log("GOOGLE VISION OCR preview:", text.slice(0, 300));

      return text.trim();
    }

    // 🔥 תמונות רגילות
    console.log("GOOGLE VISION OCR: image detected");

    const [result] = await client.textDetection(filePath);

    const text = result.fullTextAnnotation?.text || "";

    console.log("GOOGLE VISION OCR: image text length:", text.length);
    console.log("GOOGLE VISION OCR preview:", text.slice(0, 300));

    return text.trim();
  } catch (error) {
    console.error("GOOGLE VISION OCR ERROR FULL:", error);
    return "";
  }
}