// next/font/google offline mock for the local build (NEXT_FONT_GOOGLE_MOCKED_RESPONSES): no request to
// Google Fonts is made; font files are placeholders, so pages render with the fallback font stack.
"use strict";
const face = (name) => `/* latin */\n@font-face {\n  font-family: '${name}';\n  font-style: normal;\n  font-weight: 300 700;\n  font-display: swap;\n  src: url(http://127.0.0.1:3599/${name}.woff2) format('woff2');\n}\n`;
module.exports = {
  "https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600&display=swap": face("Heebo"),
  "https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap": face("Rubik"),
};
