// Serves one local placeholder woff2 for the offline next/font mock (build time only). 127.0.0.1 only.
const http = require("node:http"); const fs = require("node:fs"); const path = require("node:path");
const buf = fs.readFileSync(path.join(__dirname, "mock-font.woff2"));
http.createServer((req, res) => { fs.appendFileSync(path.join(__dirname, "font-server.log"), `${new Date().toISOString()} ${req.method} ${req.url}\n`); res.writeHead(200, { "content-type": "font/woff2" }); res.end(buf); }).listen(3599, "127.0.0.1");
