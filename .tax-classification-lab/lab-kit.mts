/**
 * Shared kit for the tax-classification readiness lab (PR-0). Tests only — no product code.
 *
 * What it gives the battery:
 *   - a verdict ledger: every check is one of
 *       OK        the behaviour the product needs, observed;
 *       DEFECT    a reproduced defect (the check passes BECAUSE the defect reproduced — a fix flips it red
 *                 and the expectation must be updated on purpose);
 *       OBSERVED  current behaviour recorded for a product / legal decision (not a verdict);
 *       UNTESTED  a gap this lab cannot exercise — never reported as passing.
 *     A check whose observation differs from its expectation is a FAIL (the lab's model of the code is wrong).
 *   - the repository's RLS replayed (same approach as billing-issue-exempt-dealer.rls.integration.test.ts),
 *     the battery itself connected as a NOBYPASSRLS role;
 *   - a network trap: any non-loopback connection attempt from this process is refused and counted
 *     (CI adds an OS-level iptables owner rule on top — see the workflow);
 *   - evidence files (PDFs, extracted text, JSON results) under $LAB_EVIDENCE_DIR.
 *
 * Synthetic data only. No secrets, no Neon, no network, no authority.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

// ------------------------------------------------------------------ network trap
export const networkAttempts: string[] = [];
function isLoopback(host: string | undefined): boolean {
  if (!host) return true; // unix socket / unspecified
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
const realConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; path?: string } | number | string | undefined;
  let host: string | undefined;
  if (typeof first === "object" && first !== null) host = first.path ? undefined : first.host ?? "localhost";
  else if (typeof first === "number") host = typeof args[1] === "string" ? (args[1] as string) : "localhost";
  if (!isLoopback(host)) {
    networkAttempts.push(`socket:${host}`);
    const err = new Error(`lab network trap: refused connection to ${host}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  networkAttempts.push(`fetch:${url}`);
  throw new Error(`lab network trap: fetch refused (${url})`);
}) as typeof fetch;

// ------------------------------------------------------------------ verdict ledger
export type Verdict = "OK" | "DEFECT" | "OBSERVED" | "UNTESTED";
export type Via = "API" | "SERVICE" | "PURE" | "STATIC" | "UI";
export type Row = {
  id: string;
  verdict: Verdict;
  via: Via;
  title: string;
  observed: string;
  matched: boolean;
  classification?: string;
  docType?: string;
  legal?: string;
};
export type Tags = { classification?: string; docType?: string; legal?: string };
export const rows: Row[] = [];
let failures = 0;

/**
 * Record one check. `holds` = the expected observation was made:
 *   OK      → the needed behaviour holds;
 *   DEFECT  → the defect reproduced;
 *   OBSERVED→ the recorded current behaviour matches what is written in `title`.
 */
export function check(
  id: string,
  verdict: Exclude<Verdict, "UNTESTED">,
  via: Via,
  title: string,
  holds: boolean,
  observed: unknown,
  tags: Tags = {}
) {
  const obs =
    typeof observed === "string"
      ? observed
      : JSON.stringify(observed, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "undefined";
  rows.push({ id, verdict, via, title, observed: obs.slice(0, 600), matched: holds, ...tags });
  if (!holds) failures++;
  const mark = holds ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id} ${verdict} (${via}) ${title}${holds ? "" : " — observed: " + obs.slice(0, 300)}`);
}

export function untested(id: string, title: string, reason: string, tags: Tags = {}) {
  rows.push({ id, verdict: "UNTESTED", via: "STATIC", title, observed: reason, matched: true, ...tags });
  console.log(`  [GAP ] ${id} UNTESTED ${title} — ${reason}`);
}

export function failureCount() {
  return failures;
}

// ------------------------------------------------------------------ evidence
export const EVIDENCE_DIR = process.env.LAB_EVIDENCE_DIR ?? path.resolve(".tax-classification-lab/.evidence");
mkdirSync(path.join(EVIDENCE_DIR, "pdf"), { recursive: true });

export function saveEvidence(name: string, data: string | Buffer) {
  const p = path.join(EVIDENCE_DIR, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

export function writeLedger(extra: Record<string, unknown>) {
  const summary = {
    generatedAt: new Date().toISOString(),
    totals: {
      checks: rows.length,
      ok: rows.filter((r) => r.verdict === "OK").length,
      defect: rows.filter((r) => r.verdict === "DEFECT").length,
      observed: rows.filter((r) => r.verdict === "OBSERVED").length,
      untested: rows.filter((r) => r.verdict === "UNTESTED").length,
      mismatched: failures,
    },
    networkAttempts,
    ...extra,
    rows,
  };
  saveEvidence("results.json", JSON.stringify(summary, null, 2));
  const md = [
    "| id | verdict | via | classification | type | check | observed | legal |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.matched ? r.verdict : "**MISMATCH " + r.verdict + "**"} | ${r.via} | ${r.classification ?? ""} | ${r.docType ?? ""} | ${r.title.replace(/\|/g, "/")} | ${r.observed.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} | ${r.legal ?? ""} |`
    ),
  ].join("\n");
  saveEvidence("results.md", md);
  return summary;
}

// ------------------------------------------------------------------ PDF text
export async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}
/** Hebrew may be extracted in visual order — accept either direction, whitespace-insensitive. */
export function printed(text: string, needle: string): boolean {
  const t = text.replace(/\s+/g, "");
  const n = needle.replace(/\s+/g, "");
  return t.includes(n) || t.includes([...n].reverse().join(""));
}

// ------------------------------------------------------------------ RLS replay
/** Replays every RLS / policy / role statement the repository's migrations ship. */
export async function replayRepositoryRls(adminUrl: string): Promise<number> {
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let applied = 0;
  try {
    for (const r of ["app_admin", "app_auth", "app_ctlplane", "app_runtime"]) {
      await admin.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
           CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
         END IF; END $do$`
      );
    }
    for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
      let sql: string;
      try {
        sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      for (const st of sql
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
        try {
          await admin.$executeRawUnsafe(st);
          applied++;
        } catch {
          /* already present */
        }
      }
    }
  } finally {
    await admin.$disconnect();
  }
  return applied;
}

// ------------------------------------------------------------------ route calls
export type RouteResult = { status: number; json: any; headers: Headers; buffer?: Buffer };

export async function callRoute(
  handler: (req: any, ctx: any) => Promise<Response>,
  opts: { method: string; url: string; token?: string; body?: unknown; params?: Record<string, string> }
): Promise<RouteResult> {
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const req = new NextRequest(`http://localhost${opts.url}`, {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) });
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/pdf")) {
    return { status: res.status, json: null, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  }
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw };
  }
  return { status: res.status, json, headers: res.headers };
}

export function errorText(r: RouteResult): string {
  return String(r.json?.error ?? r.json?.message ?? r.json?.raw ?? "");
}
