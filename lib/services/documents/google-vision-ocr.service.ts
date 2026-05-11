import vision from "@google-cloud/vision";
import fs from "fs";
import path from "path";

function resolveCredentialsPath() {
  return path.join(process.cwd(), "secrets/google-vision-key.json");
}

export async function runGoogleVisionOCR(
  filePath: string,
  mimeType?: string
): Promise<string> {
  try {
    console.log("========== GOOGLE VISION OCR START ==========");

    const credentialsPath = resolveCredentialsPath();

    console.log("credentialsPath:", credentialsPath);
    console.log("filePath:", filePath);
    console.log("mimeType:", mimeType);

    console.log("file exists:", fs.existsSync(filePath));
    console.log("credentials exists:", fs.existsSync(credentialsPath));

    if (!credentialsPath || !fs.existsSync(credentialsPath)) {
      throw new Error("Google Vision credentials file not found");
    }

    if (!fs.existsSync(filePath)) {
      throw new Error("File not found for OCR");
    }

    // קריאת הקובץ כדי לבדוק שהוא תקין
    try {
      const raw = fs.readFileSync(credentialsPath, "utf-8");
      const parsed = JSON.parse(raw);

      console.log("credentials project_id:", parsed.project_id);
      console.log("credentials client_email:", parsed.client_email);
    } catch (e) {
      console.error("FAILED TO PARSE CREDENTIALS:", e);
    }

    const client = new vision.ImageAnnotatorClient({
  keyFilename: credentialsPath,
  fallback: true,
});
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
        .map((p) => p.fullTextAnnotation?.text || "")
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
  } catch (error: any) {
    console.error("========== GOOGLE VISION OCR ERROR ==========");
    console.error("FULL:", error);
    console.error("message:", error?.message);
    console.error("code:", error?.code);
    console.error("details:", error?.details);
    console.error("stack:", error?.stack);

    try {
      console.error("json:", JSON.stringify(error, null, 2));
    } catch {}

    console.error("============================================");

    throw error;
  }
}