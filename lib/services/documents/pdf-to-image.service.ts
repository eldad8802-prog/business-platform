import path from "path";
import fs from "fs";
import { exec } from "child_process";

export async function convertPdfToImage(
  pdfPath: string
): Promise<string> {
  const outputDir = path.dirname(pdfPath);
  const fileName = path.basename(pdfPath, ".pdf");

  const outputPath = path.join(outputDir, `${fileName}-page1.jpg`);

  return new Promise((resolve, reject) => {
    const command = `pdftoppm -jpeg -f 1 -singlefile "${pdfPath}" "${path.join(
      outputDir,
      fileName
    )}"`;

    exec(command, (error) => {
      if (error) {
        console.error("PDF CONVERT ERROR:", error);
        return reject(error);
      }

      if (!fs.existsSync(outputPath)) {
        return reject(new Error("PDF conversion failed"));
      }

      resolve(outputPath);
    });
  });
}