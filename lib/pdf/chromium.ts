/**
 * The one place Chromium is launched for HTML → PDF (billing documents and the accountant report).
 *
 * A Vercel / Lambda function has no browser installed (the playwright package ships, its browser download
 * does not), so there the serverless build @sparticuz/chromium (AL2023, with its own system libraries and
 * Open Sans as the Latin fallback) is launched through playwright-core. Locally and in CI the browser
 * `npx playwright install chromium` downloaded is used.
 *
 * A route that renders through this module must be listed in next.config.ts outputFileTracingIncludes:
 * @sparticuz/chromium resolves its compressed browser at runtime, which file tracing cannot see.
 */

export type ChromiumMode = "serverless" | "local";

/** Pure. */
export function chromiumMode(env: NodeJS.ProcessEnv = process.env): ChromiumMode {
  return env.VERCEL === "1" || Boolean(env.AWS_LAMBDA_FUNCTION_NAME) ? "serverless" : "local";
}

export type PdfRenderStage = "launch" | "render" | "print";

/** A rendering failure with the stage it stopped at and a short, sanitized reason (no HTML, no data). */
export class PdfRenderError extends Error {
  constructor(
    public readonly stage: PdfRenderStage,
    public readonly mode: ChromiumMode,
    public readonly detail: string
  ) {
    super(`PDF render failed at ${stage} (${mode}): ${detail}`);
    this.name = "PdfRenderError";
  }
}

/**
 * The first line of a Chromium / Playwright error message, for the log: control characters removed,
 * whitespace collapsed, at most 240 characters. These messages carry paths and launch flags — never the
 * page's content.
 */
export function sanitizeRenderError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const first = raw.split(/\r?\n/)[0] ?? "";
  return first.replace(/[\u0000-\u001F\u007F-\u009F─-╿]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function launchChromium(mode: ChromiumMode = chromiumMode()) {
  if (mode === "serverless") {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    const { chromium } = await import("playwright-core");
    return chromium.launch({ headless: true, executablePath: await sparticuz.executablePath(), args: sparticuz.args });
  }
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
}

export type ChromiumBrowser = Awaited<ReturnType<typeof launchChromium>>;
