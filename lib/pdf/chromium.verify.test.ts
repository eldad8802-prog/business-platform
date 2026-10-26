/**
 * The shared Chromium launcher (S5). Pure + source checks, no browser:
 *   npx tsx lib/pdf/chromium.verify.test.ts
 *
 *  - serverless detection (Vercel / Lambda) vs local;
 *  - sanitized, single-line render errors;
 *  - the billing renderer launches ONLY through the shared launcher and its page / print options are the
 *    ones it always used (the fix changes where the browser comes from, nothing about the document);
 *  - the accountant module re-exports the same functions (no second launcher);
 *  - every route that renders billing or accountant PDFs is in next.config.ts outputFileTracingIncludes.
 */
import { readFileSync } from "node:fs";

import * as accountant from "@/lib/accountant/package-report-pdf";
import { chromiumMode, PdfRenderError, sanitizeRenderError } from "@/lib/pdf/chromium";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else { failed += 1; console.error(`FAIL: ${name}`, extra ?? ""); }
}

ok("Vercel is serverless", chromiumMode({ VERCEL: "1" } as NodeJS.ProcessEnv) === "serverless");
ok("Lambda is serverless", chromiumMode({ AWS_LAMBDA_FUNCTION_NAME: "f" } as NodeJS.ProcessEnv) === "serverless");
ok("no flags is local", chromiumMode({} as NodeJS.ProcessEnv) === "local");
ok("VERCEL other than 1 is local", chromiumMode({ VERCEL: "0" } as NodeJS.ProcessEnv) === "local");

const s = sanitizeRenderError(new Error("browserType.launch: Failed\n  at /var/task/x.js\n╔══ log ══╗"));
ok("render error: first line only", s === "Error: browserType.launch: Failed", s);
ok("render error: at most 240 chars", sanitizeRenderError("x".repeat(500)).length === 240);
const e = new PdfRenderError("launch", "serverless", "d");
ok("PdfRenderError carries stage + mode", e.stage === "launch" && e.mode === "serverless" && e.name === "PdfRenderError");

ok("accountant re-exports the shared chromiumMode", accountant.chromiumMode === chromiumMode);
ok("accountant re-exports the shared PdfRenderError", accountant.PdfRenderError === PdfRenderError);

const renderer = readFileSync("lib/services/billing/pdf/billing-pdf-html-renderer.ts", "utf8");
ok("billing renderer does not import playwright directly", !/from\s+["']playwright(-core)?["']/.test(renderer));
ok("billing renderer launches through the shared launcher", /launchChromium\(\)/.test(renderer) && !/chromium\.launch\(/.test(renderer));
for (const opt of [
  `waitUntil: "networkidle"`,
  `format: "A4"`,
  `printBackground: true`,
  `displayHeaderFooter: true`,
  `headerTemplate: "<div></div>"`,
  `footerTemplate: buildFooterTemplate(fontDataUri, snapshot.issuer.name)`,
  `bottom: "52px"`,
  `const html = buildBillingInvoiceHtml(snapshot, fontDataUri);`,
]) ok(`billing page option unchanged: ${opt}`, renderer.includes(opt));

const launcherUsers = ["lib/accountant/package-report-pdf.ts", "lib/services/billing/pdf/billing-pdf-html-renderer.ts"];
for (const f of launcherUsers) ok(`${f}: no own launch`, !/chromium\.launch\(/.test(readFileSync(f, "utf8")));

const config = readFileSync("next.config.ts", "utf8");
for (const route of [
  "/api/accountant/packages/\\\\[packageId\\\\]/download",
  "/api/billing/documents/\\\\[id\\\\]/pdf",
  "/api/accountant/periods/\\\\[periodKey\\\\]/prepare",
]) ok(`tracing include for ${route}`, config.includes(`"${route}": ["./node_modules/@sparticuz/chromium/bin/**/*"]`));

const pdfRoute = readFileSync("app/api/billing/documents/[id]/pdf/route.ts", "utf8");
ok("billing PDF route: Node runtime, 60 s budget", /runtime = "nodejs"/.test(pdfRoute) && /maxDuration = 60;/.test(pdfRoute));

if (failed > 0) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }
console.log("\nchromium launcher: all checks passed");
