const fs = require("fs");
const path = require("path");

const fontPath = path.join(
  process.cwd(),
  "public",
  "fonts",
  "NotoSansHebrew-Regular.ttf"
);

const outputPath = path.join(
  process.cwd(),
  "lib",
  "pdf",
  "hebrew-font-vfs.ts"
);

if (!fs.existsSync(fontPath)) {
  throw new Error(`Font not found: ${fontPath}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const base64 = fs.readFileSync(fontPath).toString("base64");

const content = `export const hebrewFontVfs = {
  "NotoSansHebrew-Regular.ttf": "${base64}"
};
`;

fs.writeFileSync(outputPath, content, "utf8");

console.log("Hebrew font VFS created:", outputPath);