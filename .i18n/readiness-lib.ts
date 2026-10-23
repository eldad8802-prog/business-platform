/**
 * English-activation readiness — pure helpers shared by the CI scripts (no DB, no network, no browser):
 *   - enumeratePages()        every app/**\/page.tsx → its URL pattern (route groups stripped)
 *   - routeAudience()         who opens the route: signed-in app user, public visitor, platform admin
 *   - fillRoute()             a dynamic pattern → a concrete URL from seeded ids (null = not fillable)
 *   - normalizeVisible()      the ONLY normalisation used by the Hebrew-parity proof (documented)
 *   - parseBuildRouteTable()  `next build` route table → { route → static | dynamic | ssg | ppr }
 *   - localeReaders()         transitive import walk: does a module reach a locale-reading entry point?
 * Pinned by .i18n/readiness-lib.test.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import path from "path";

export type PageRoute = {
  /** app-relative file, forward slashes, e.g. "app/(shell)/customers/[id]/page.tsx" */
  file: string;
  /** URL pattern, e.g. "/customers/[id]" */
  pattern: string;
  /** dynamic segment names in order, e.g. ["id"] */
  params: string[];
  /** the first route group the page lives in, e.g. "(shell)" — or null */
  group: string | null;
};

export function enumeratePages(appDir: string): PageRoute[] {
  const out: PageRoute[] = [];
  const walk = (dir: string, rel: string[]) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        // private folders (_x), parallel slots (@x) and api/ hold no pages of their own
        if (name.startsWith("_") || name.startsWith("@") || (rel.length === 0 && name === "api")) continue;
        walk(full, [...rel, name]);
      } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
        out.push(toRoute([...rel], `app/${[...rel, name].join("/")}`));
      }
    }
  };
  walk(appDir, []);
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export function toRoute(segments: string[], file: string): PageRoute {
  const group = segments.find((s) => /^\(.+\)$/.test(s)) ?? null;
  const urlSegs = segments.filter((s) => !/^\(.+\)$/.test(s));
  const params = urlSegs.filter((s) => /^\[.+\]$/.test(s)).map((s) => s.replace(/^\[+\.{0,3}|\]+$/g, ""));
  return { file, pattern: "/" + urlSegs.join("/"), params, group };
}

export type Audience = "app" | "public" | "platform-admin";

/** Signed-out public pages (marketing site + the auth screens) vs. the signed-in app vs. operators. */
export function routeAudience(r: Pick<PageRoute, "pattern" | "group">): Audience {
  if (r.group === "(platform-admin)" || r.pattern.startsWith("/dev/")) return "platform-admin";
  if (r.group === "(corporate)") return "public";
  if (/^\/(login|register|forgot-password|reset-password|verify-email)$/.test(r.pattern)) return "public";
  return "app";
}

/** Marketing (prospect-facing) pages whose content is intentionally Hebrew-only. */
export function isHebrewOnlyPublic(r: Pick<PageRoute, "group">): boolean {
  return r.group === "(corporate)";
}

/** Replace each [param] with fills[pattern][param] (or fills["*"][param]); null if any is missing. */
export function fillRoute(pattern: string, fills: Record<string, Record<string, string>>): string | null {
  let missing = false;
  const url = pattern.replace(/\[([^\]]+)\]/g, (_m, name: string) => {
    const v = fills[pattern]?.[name] ?? fills["*"]?.[name];
    if (v === undefined) { missing = true; return ""; }
    return encodeURIComponent(v);
  });
  return missing ? null : url;
}

/**
 * Normalisation for the "Hebrew users see no change" proof. Two levels, reported separately:
 *   raw       whitespace runs collapsed (layout re-flow differences are not text differences)
 *   volatile  raw + wall-clock values that move between two renders taken seconds apart:
 *             clock times (14:05 / 14:05:09) → HH:MM, numeric dates (22.10.2026 / 22/10/26) → DATE,
 *             Hebrew relative ages ("לפני 3 דקות", "לפני דקה") → "לפני N", "עכשיו" stays as is.
 * Nothing else is normalised: amounts, counts, names, labels and ids must match exactly.
 */
export function normalizeVisible(text: string, level: "raw" | "volatile"): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (level === "volatile") {
    s = s
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "HH:MM")
      .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g, "DATE")
      .replace(/לפני (\d+ )?(שנייה|שניות|דקה|דקות|שעה|שעות|יום|ימים|יומיים|שעתיים|שבוע|שבועות|חודש|חודשים)/g, "לפני N");
  }
  return s;
}

export type BuildKind = "static" | "dynamic" | "ssg" | "ppr";
const SYMBOL: Record<string, BuildKind> = { "○": "static", "ƒ": "dynamic", "λ": "dynamic", "●": "ssg", "◐": "ppr" };

/** Parses the `Route (app)` table printed by `next build`. Pages only unless includeApi. */
export function parseBuildRouteTable(log: string, includeApi = false): Map<string, BuildKind> {
  const out = new Map<string, BuildKind>();
  let inApp = false;
  for (const raw of log.split(/\r?\n/)) {
    // strip ANSI colour codes from the build log
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
    if (/^\s*Route \(app\)/.test(line)) { inApp = true; continue; }
    if (/^\s*Route \(pages\)/.test(line)) { inApp = false; continue; }
    if (!inApp) continue;
    const m = /^[\s┌├└│─]*([○ƒλ●◐])\s+(\/\S*)/.exec(line);
    if (!m) continue;
    const route = m[2];
    if (!includeApi && route.startsWith("/api/")) continue;
    out.set(route, SYMBOL[m[1]]);
  }
  return out;
}

export function diffRouteTables(off: Map<string, BuildKind>, on: Map<string, BuildKind>) {
  const changed: Array<{ route: string; off: BuildKind | "absent"; on: BuildKind | "absent" }> = [];
  for (const r of new Set([...off.keys(), ...on.keys()])) {
    const a = off.get(r) ?? "absent";
    const b = on.get(r) ?? "absent";
    if (a !== b) changed.push({ route: r, off: a, on: b });
  }
  return changed.sort((x, y) => x.route.localeCompare(y.route));
}

/** The entry points that read the interface language of the current request / browser. */
export const LOCALE_READER_RE = /\b(getRequestLocale|getServerI18n|useI18n)\s*\(/;

/** Resolves "@/x", "./x", "../x" to a file under root (ts/tsx/js/mjs or index). null for packages. */
export function resolveImport(root: string, fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  const cands = [base, ...[".ts", ".tsx", ".js", ".mjs", ".mts"].map((e) => base + e), ...["index.ts", "index.tsx"].map((i) => path.join(base, i))];
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/**
 * Walks the static import graph from `entry` (type-only imports skipped) and returns every reachable
 * file that calls a locale reader, with the import chain that reaches it.
 */
export function localeReaders(root: string, entry: string): Array<{ file: string; chain: string[] }> {
  const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
  const seen = new Set<string>();
  const hits: Array<{ file: string; chain: string[] }> = [];
  const stack: Array<{ file: string; chain: string[] }> = [{ file: path.resolve(root, entry), chain: [] }];
  while (stack.length) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    const here = [...chain, rel(file)];
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    if (LOCALE_READER_RE.test(code) && !/lib\/i18n\/server\.ts$|components\/i18n\/I18nProvider\.tsx$/.test(rel(file))) hits.push({ file: rel(file), chain: here });
    for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      if (m[2]) continue; // import type … — erased, no runtime edge
      const spec = m[3] ?? m[4];
      const next = resolveImport(root, file, spec);
      if (next) stack.push({ file: next, chain: here });
    }
  }
  return hits;
}
