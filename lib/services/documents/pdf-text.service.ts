import fs from "fs";

type PdfParseResult = {
  text?: string;
};

type PdfParseFn = (
  dataBuffer: Buffer,
  options?: Record<string, unknown>
) => Promise<PdfParseResult>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: PdfParseFn = require("pdf-parse");

export async function extractTextFromPdf(filePath: string): Promise<string> {
  try {
    console.log("PDF PARSE: starting");

    const dataBuffer = fs.readFileSync(filePath);

    const result = await pdfParse(dataBuffer);

    const text = result.text || "";

    console.log("PDF PARSE: text length:", text.length);
    console.log("PDF PARSE preview:", text.slice(0, 300));

    return text.trim();
  } catch (error) {
    console.error("PDF PARSE ERROR:", error);
    return "";
  }
}