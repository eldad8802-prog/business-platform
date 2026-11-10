/**
 * R2 test bucket — connection diagnosis that NEVER reveals a value. Run 42725350210 failed on the first request of
 * both jobs with a TLS "alert handshake failure" (SSL alert 40) from Cloudflare. The S3 client matches Cloudflare's
 * documented aws-sdk-js-v3 setup (region "auto", endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com, no
 * forcePathStyle); so this checks, without printing any secret, any host name built from one, or any raw error message:
 *
 *   D1  the shape of each value, as the app reads it (trimmed): Account ID = 32 hex; bucket = R2 naming rules
 *       (a-z 0-9 -, 3–63, no leading/trailing hyphen), not a URL, no spaces; key id 32 hex, secret 64 hex (SHA-256)
 *   D2  for each documented endpoint — default, eu, us, fedramp (https://<ACCOUNT_ID>[.<jurisdiction>].r2.cloudflarestorage.com) —
 *       DNS, and a TLS handshake WITH full certificate verification (Node defaults; nothing is relaxed), to the account
 *       host and to the virtual-hosted bucket host <bucket>.<account host> the SDK uses
 *   D3  where the handshake succeeds: a signed, read-only HeadBucket exactly as the app's client sends it — the HTTP
 *       status only (200 = this endpoint holds the bucket; 404 = not here; 401/403 = credentials or token scope) —
 *       and, as a comparison only, the same request in path style (the app does not use it)
 *
 * Reads only; writes nothing. Output: labels, booleans, error CODES and HTTP statuses. Always exits 0 — it is a report.
 * env: R2_TEST_ACCOUNT_ID, R2_TEST_ACCESS_KEY_ID, R2_TEST_SECRET_ACCESS_KEY, R2_TEST_BUCKET
 */
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";

import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const rawOf = (k: string) => process.env[k] ?? "";
const valueOf = (k: string) => rawOf(k).trim(); // lib/storage/config.ts reads every R2 value trimmed

const line = (s: string) => console.log(s);
const yn = (b: boolean) => (b ? "yes" : "NO");

function shape(name: string, expected: string, test: (v: string) => boolean) {
  const raw = rawOf(name);
  const v = raw.trim();
  line(`${name}: set=${yn(v.length > 0)} ${expected}=${yn(test(v))} ends-with-whitespace=${raw !== v ? "YES" : "no"} inner-whitespace=${/\s/.test(v) ? "YES" : "no"} url-like=${/:\/\/|\//.test(v) ? "YES" : "no"} has-dot=${v.includes(".") ? "YES" : "no"} has-uppercase=${/[A-Z]/.test(v) ? "YES" : "no"}`);
}

/** Error CODE only (never .message: a TLS / DNS message can carry the host, which contains the values). */
const codeOf = (e: unknown) => {
  const o = e as { code?: unknown; reason?: unknown; name?: unknown };
  const reason = typeof o.reason === "string" && /^[a-z0-9 _-]+$/i.test(o.reason) ? ` (${o.reason})` : "";
  return `${typeof o.code === "string" ? o.code : typeof o.name === "string" ? o.name : "error"}${reason}`;
};

async function dns(host: string): Promise<string> {
  try {
    const r = await lookup(host, { all: true });
    return `resolves (${r.length} address${r.length === 1 ? "" : "es"})`;
  } catch (e) {
    return `does not resolve: ${codeOf(e)}`;
  }
}

/** A TLS handshake with Node's default, full verification (rejectUnauthorized stays true; SNI = the host). */
function tls(host: string): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host, port: 443, servername: host, timeout: 10_000 });
    const done = (r: string) => { s.destroy(); resolve(r); };
    s.once("secureConnect", () => done(s.authorized ? `handshake ok, certificate valid (${s.getProtocol()})` : `handshake ok, certificate NOT valid: ${codeOf(s.authorizationError)}`));
    s.once("timeout", () => done("timeout"));
    s.once("error", (e) => done(`handshake FAILED: ${codeOf(e)}`));
  });
}

async function headBucket(endpoint: string, bucket: string, forcePathStyle = false): Promise<string> {
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId: valueOf("R2_TEST_ACCESS_KEY_ID"), secretAccessKey: valueOf("R2_TEST_SECRET_ACCESS_KEY") },
    maxAttempts: 1,
  });
  try {
    const r = await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return `HTTP ${r.$metadata.httpStatusCode} — this endpoint holds the bucket and the credentials work`;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return status ? `HTTP ${status} (${codeOf(e)})` : `no HTTP answer: ${codeOf(e)}`;
  } finally {
    client.destroy();
  }
}

async function main() {
  line("--- D1 the values' shape (as the app reads them: trimmed) — no value is printed ---");
  shape("R2_TEST_ACCOUNT_ID", "32-lowercase-hex", (v) => /^[0-9a-f]{32}$/.test(v));
  shape("R2_TEST_BUCKET", "r2-bucket-name-rules", (v) => /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(v));
  line(`R2_TEST_BUCKET: contains "test"=${yn(/test/i.test(valueOf("R2_TEST_BUCKET")))}`);
  shape("R2_TEST_ACCESS_KEY_ID", "32-hex", (v) => /^[0-9a-f]{32}$/i.test(v));
  shape("R2_TEST_SECRET_ACCESS_KEY", "64-hex", (v) => /^[0-9a-f]{64}$/i.test(v));

  const account = valueOf("R2_TEST_ACCOUNT_ID");
  const bucket = valueOf("R2_TEST_BUCKET");
  if (!account || !bucket) { line("account or bucket not set — stopping"); return; }
  if (!/test/i.test(bucket)) { line("the bucket is not a dedicated test bucket — no request is sent"); return; }

  const endpoints = [
    { label: "default", host: `${account}.r2.cloudflarestorage.com` },
    { label: "eu", host: `${account}.eu.r2.cloudflarestorage.com` },
    { label: "us", host: `${account}.us.r2.cloudflarestorage.com` },
    { label: "fedramp", host: `${account}.fedramp.r2.cloudflarestorage.com` },
  ];
  line("--- D2 DNS + TLS (full certificate verification) per documented endpoint — no host is printed ---");
  const reachable: { label: string; host: string }[] = [];
  for (const ep of endpoints) {
    const accountTls = await tls(ep.host);
    line(`${ep.label} account host:        DNS ${await dns(ep.host)}; TLS ${accountTls}`);
    line(`${ep.label} bucket host (SDK):   DNS ${await dns(`${bucket}.${ep.host}`)}; TLS ${await tls(`${bucket}.${ep.host}`)}`);
    if (accountTls.startsWith("handshake ok, certificate valid")) reachable.push(ep);
  }

  line("--- D3 signed read-only HeadBucket, the app's client settings — HTTP status only ---");
  if (reachable.length === 0) line("no endpoint completed a verified handshake — no request sent");
  for (const ep of reachable) {
    line(`${ep.label} (the app's form, bucket host): ${await headBucket(`https://${ep.host}`, bucket)}`);
    // Comparison only — the app does not use it: the same request addressed to the account host, so a failure of the
    // bucket host can be told apart from a failure of the account, the credentials or the jurisdiction.
    line(`${ep.label} (comparison: path style):     ${await headBucket(`https://${ep.host}`, bucket, true)}`);
  }
}

main()
  .catch((e) => line(`diagnosis stopped: ${codeOf(e)}`))
  .finally(() => line("diagnosis complete (report only; nothing was written)"));
