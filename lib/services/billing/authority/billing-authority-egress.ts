/**
 * ITA-specific outbound transport (dedicated egress).
 *
 * Every server-side request to the Israel Tax Authority (token exchange, token
 * refresh, Approval, InvoiceDecision, validation probe, token network probe)
 * must leave through the dedicated gateway whose static IPv4 is the one ITA has
 * whitelisted:
 *
 *   Dubiz runtime → mTLS HTTPS proxy (HTTP CONNECT) → ITA-approved egress IP → ITA
 *
 * Design rules (non-negotiable):
 *   - Scoped: only the authority call-sites use this fetch. No global fetch
 *     replacement, no global dispatcher, no HTTP_PROXY/HTTPS_PROXY behaviour.
 *   - Fail closed: missing OR malformed config, an unexpected environment, or a
 *     destination outside the allowlist throws BEFORE any network I/O. There is
 *     no direct-network fallback in any environment (development included).
 *   - Proxy TLS: the proxy certificate is verified against the dedicated
 *     SERVER_CA only (not the public trust store), with normal hostname / IP SAN
 *     verification, and the client authenticates with its mTLS certificate.
 *   - Inner TLS: the tunnelled connection to ITA uses Node's default trust store
 *     and normal verification. The proxy only tunnels (CONNECT); it never
 *     terminates ITA's TLS.
 *   - Redirects are refused (`redirect: "error"`), so a response can never steer
 *     the request to a destination outside the allowlist.
 *   - Errors carry an error code and the NAME of the offending env var only —
 *     never a PEM, key, URL credential, or raw library message.
 *
 * Configuration (per ITA environment, no unscoped fallback):
 *   ITA_EGRESS_PROXY_URL_<ENV>    https://<host>[:port] — must match the proxy
 *                                 certificate identity (SAN)
 *   ITA_EGRESS_PROXY_CA_<ENV>     SERVER_CA certificate (PEM or base64 of PEM)
 *   ITA_EGRESS_CLIENT_CERT_<ENV>  mTLS client certificate (PEM or base64 of PEM)
 *   ITA_EGRESS_CLIENT_KEY_<ENV>   mTLS client private key (PEM or base64 of PEM)
 * where <ENV> is BILLING_AUTHORITY_RUNTIME_ENVIRONMENT (SANDBOX | PRODUCTION).
 */

import { createHash, createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { fetch as undiciFetch, Pool, ProxyAgent, type Dispatcher } from "undici";
import type { BillingAuthorityEnvironment } from "@prisma/client";

/** The only inner destinations the ITA transport may reach (port 443 only). */
export const AUTHORITY_EGRESS_ALLOWED_HOSTS: readonly string[] = Object.freeze([
  "openapi.taxes.gov.il",
  "ita-api.taxes.gov.il",
]);

export const AUTHORITY_EGRESS_ERROR_CODES = {
  NOT_CONFIGURED: "ITA_EGRESS_NOT_CONFIGURED",
  CONFIG_INVALID: "ITA_EGRESS_CONFIG_INVALID",
  ENVIRONMENT_INVALID: "ITA_EGRESS_ENVIRONMENT_INVALID",
  DESTINATION_BLOCKED: "ITA_EGRESS_DESTINATION_BLOCKED",
} as const;

export type AuthorityEgressErrorCode =
  (typeof AUTHORITY_EGRESS_ERROR_CODES)[keyof typeof AUTHORITY_EGRESS_ERROR_CODES];

/**
 * Thrown before any network I/O. The message names the env var / rule only.
 * No `cause` is attached, so no library error (which could quote input) leaks.
 */
export class AuthorityEgressError extends Error {
  readonly code: AuthorityEgressErrorCode;

  constructor(code: AuthorityEgressErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AuthorityEgressError";
    this.code = code;
  }
}

export function isAuthorityEgressError(error: unknown): error is AuthorityEgressError {
  return error instanceof AuthorityEgressError;
}

const ENV_VAR_PREFIX = {
  proxyUrl: "ITA_EGRESS_PROXY_URL",
  proxyCa: "ITA_EGRESS_PROXY_CA",
  clientCert: "ITA_EGRESS_CLIENT_CERT",
  clientKey: "ITA_EGRESS_CLIENT_KEY",
} as const;

type EgressEnvKey = keyof typeof ENV_VAR_PREFIX;

export function authorityEgressEnvVarName(
  key: EgressEnvKey,
  environment: BillingAuthorityEnvironment
): string {
  return `${ENV_VAR_PREFIX[key]}_${environment}`;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

type ValidatedEgressConfig = {
  environment: BillingAuthorityEnvironment;
  proxyUrl: string;
  proxyHost: string;
  proxyCaPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  fingerprint: string;
};

const CLIENT_AUTH_EKU_OID = "1.3.6.1.5.5.7.3.2";
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

function invalid(varName: string, reason: string): AuthorityEgressError {
  return new AuthorityEgressError(
    AUTHORITY_EGRESS_ERROR_CODES.CONFIG_INVALID,
    `${varName} ${reason}`
  );
}

function readRequired(env: EnvSource, varName: string): string {
  const raw = env[varName];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    throw new AuthorityEgressError(
      AUTHORITY_EGRESS_ERROR_CODES.NOT_CONFIGURED,
      `${varName} is not set`
    );
  }
  return trimmed;
}

/** Accepts raw PEM (real or `\n`-escaped newlines) or base64 of a PEM. */
function decodePem(value: string, varName: string): string {
  let text = value;
  if (!text.startsWith("-----BEGIN")) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) {
      throw invalid(varName, "is neither PEM nor base64-encoded PEM");
    }
    text = Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8").trim();
    if (!text.startsWith("-----BEGIN")) {
      throw invalid(varName, "is neither PEM nor base64-encoded PEM");
    }
  }
  return text.replace(/\\n/g, "\n");
}

function pemBlocks(pem: string, label: string): string[] {
  return [...pem.matchAll(PEM_BLOCK)]
    .filter((m) => m[1] === label)
    .map((m) => m[0]);
}

function parseCertificate(pem: string, varName: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    throw invalid(varName, "is not a parseable X.509 certificate");
  }
}

function assertCurrentlyValid(cert: X509Certificate, varName: string, now: Date): void {
  const from = new Date(cert.validFrom);
  const to = new Date(cert.validTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw invalid(varName, "has an unreadable validity period");
  }
  if (now < from) throw invalid(varName, "is not yet valid");
  if (now > to) throw invalid(varName, "has expired");
}

function validateProxyUrl(raw: string, varName: string): { url: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(varName, "is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw invalid(varName, "must use https:// (TLS to the proxy is required)");
  }
  if (url.username || url.password) {
    throw invalid(varName, "must not embed credentials (proxy auth is mTLS only)");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw invalid(varName, "must be an origin only (no path, query, or fragment)");
  }
  if (!url.hostname) {
    throw invalid(varName, "has no host");
  }
  return { url: url.origin, host: url.hostname };
}

/**
 * Pure validation of the egress configuration (no I/O). Missing and malformed
 * values both throw — there is no partial or degraded configuration.
 */
export function resolveAuthorityEgressConfig(
  env: EnvSource,
  environment: BillingAuthorityEnvironment,
  now: Date = new Date()
): ValidatedEgressConfig {
  const names = {
    proxyUrl: authorityEgressEnvVarName("proxyUrl", environment),
    proxyCa: authorityEgressEnvVarName("proxyCa", environment),
    clientCert: authorityEgressEnvVarName("clientCert", environment),
    clientKey: authorityEgressEnvVarName("clientKey", environment),
  };

  const rawProxyUrl = readRequired(env, names.proxyUrl);
  const rawCa = readRequired(env, names.proxyCa);
  const rawCert = readRequired(env, names.clientCert);
  const rawKey = readRequired(env, names.clientKey);

  const proxy = validateProxyUrl(rawProxyUrl, names.proxyUrl);

  // SERVER_CA: exactly one CA certificate — pinned, replaces the public roots.
  const caPem = decodePem(rawCa, names.proxyCa);
  const caBlocks = pemBlocks(caPem, "CERTIFICATE");
  if (caBlocks.length !== 1) {
    throw invalid(names.proxyCa, "must contain exactly one CERTIFICATE block");
  }
  const ca = parseCertificate(caBlocks[0], names.proxyCa);
  if (!ca.ca) throw invalid(names.proxyCa, "is not a CA certificate");
  assertCurrentlyValid(ca, names.proxyCa, now);

  // Client certificate: leaf first, must be a non-CA client-auth certificate.
  const certPem = decodePem(rawCert, names.clientCert);
  const certBlocks = pemBlocks(certPem, "CERTIFICATE");
  if (certBlocks.length < 1) {
    throw invalid(names.clientCert, "contains no CERTIFICATE block");
  }
  const leaf = parseCertificate(certBlocks[0], names.clientCert);
  if (leaf.ca) throw invalid(names.clientCert, "must be a leaf (non-CA) certificate");
  assertCurrentlyValid(leaf, names.clientCert, now);
  const eku = leaf.keyUsage;
  if (Array.isArray(eku) && eku.length > 0 && !eku.includes(CLIENT_AUTH_EKU_OID)) {
    throw invalid(names.clientCert, "is not valid for TLS client authentication");
  }

  // Private key: unencrypted PEM private key that matches the client cert.
  const keyPem = decodePem(rawKey, names.clientKey);
  let clientKey: KeyObject;
  try {
    clientKey = createPrivateKey({ key: keyPem, format: "pem" });
  } catch {
    throw invalid(names.clientKey, "is not a parseable unencrypted private key");
  }
  let matches = false;
  try {
    matches = leaf.checkPrivateKey(clientKey);
  } catch {
    matches = false;
  }
  if (!matches) {
    throw invalid(names.clientKey, `does not match ${names.clientCert}`);
  }

  const fingerprint = createHash("sha256")
    .update([environment, proxy.url, caPem, certPem, keyPem].join("\u0000"))
    .digest("hex");

  return {
    environment,
    proxyUrl: proxy.url,
    proxyHost: proxy.host,
    proxyCaPem: caBlocks[0],
    clientCertPem: certPem,
    clientKeyPem: keyPem,
    fingerprint,
  };
}

/**
 * Validates an inner destination against the ITA allowlist. Accepts a string or
 * URL only (a `Request` object is refused so nothing can bypass the check).
 */
export function assertAuthorityEgressDestination(input: unknown): URL {
  let url: URL;
  try {
    if (typeof input === "string") url = new URL(input);
    else if (input instanceof URL) url = new URL(input.href);
    else throw new TypeError("unsupported input");
  } catch {
    throw new AuthorityEgressError(
      AUTHORITY_EGRESS_ERROR_CODES.DESTINATION_BLOCKED,
      "destination must be an absolute URL string"
    );
  }
  const allowed =
    url.protocol === "https:" &&
    (url.port === "" || url.port === "443") &&
    !url.username &&
    !url.password &&
    AUTHORITY_EGRESS_ALLOWED_HOSTS.includes(url.hostname);
  if (!allowed) {
    throw new AuthorityEgressError(
      AUTHORITY_EGRESS_ERROR_CODES.DESTINATION_BLOCKED,
      "destination is not an allowed ITA host on https port 443"
    );
  }
  return url;
}

/**
 * Same rule as resolveRuntimeAuthorityEnvironment(), read from the given env
 * source, but the error names the variable only (never echoes its value).
 */
function resolveEnvironment(env: EnvSource): BillingAuthorityEnvironment {
  const value = env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized === "SANDBOX" || normalized === "PRODUCTION") return normalized;
  throw new AuthorityEgressError(
    AUTHORITY_EGRESS_ERROR_CODES.ENVIRONMENT_INVALID,
    "BILLING_AUTHORITY_RUNTIME_ENVIRONMENT must be SANDBOX or PRODUCTION"
  );
}

/** Code of the error that replaces a "recoverable" tunnel socket failure. */
export const AUTHORITY_EGRESS_TUNNEL_CLOSED_CODE = "ITA_EGRESS_TUNNEL_CLOSED" as const;

type ConnectCallback = (err: Error | null, socket: unknown) => void;
type ConnectFn = (opts: unknown, callback: ConnectCallback) => void;

/**
 * One tunnel attempt per request. undici treats UND_ERR_SOCKET / UND_ERR_INFO
 * connect failures as recoverable and reconnects for as long as the request is
 * pending. When the gateway refuses us (e.g. it rejects the client certificate
 * after a TLS 1.3 handshake) that becomes a tight reconnect loop against the
 * ITA-approved gateway. Remapping only those codes to a non-recoverable error
 * makes the request fail on the first refusal. Every other error (TLS,
 * certificate, proxy status) already fails fast and passes through unchanged.
 */
function failFastTunnelConnect(connect: ConnectFn): ConnectFn {
  return (opts, callback) => {
    connect(opts, (err, socket) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && (code === "UND_ERR_SOCKET" || code === "UND_ERR_INFO")) {
        const tunnelError = new Error("ITA egress tunnel closed by the gateway", { cause: err });
        (tunnelError as Error & { code: string }).code = AUTHORITY_EGRESS_TUNNEL_CLOSED_CODE;
        callback(tunnelError, null);
        return;
      }
      callback(err, socket);
    });
  };
}

function buildProxyAgent(config: ValidatedEgressConfig): Dispatcher {
  return new ProxyAgent({
    uri: config.proxyUrl,
    // Per-origin pool whose tunnel connect fails fast (see failFastTunnelConnect).
    factory: (origin, options) => {
      const opts = options as Pool.Options & { connect: ConnectFn };
      return new Pool(origin, { ...opts, connect: failFastTunnelConnect(opts.connect) as Pool.Options["connect"] });
    },
    // TLS to the proxy: pinned SERVER_CA + mTLS client identity. Hostname / IP
    // SAN verification stays on (rejectUnauthorized is never overridden).
    proxyTls: {
      ca: [config.proxyCaPem],
      cert: config.clientCertPem,
      key: config.clientKeyPem,
      minVersion: "TLSv1.2",
    },
    // TLS to ITA inside the tunnel: default trust store, normal verification.
    requestTls: {
      minVersion: "TLSv1.2",
    },
  });
}

export type AuthorityEgressFetchDeps = {
  /** Env source (defaults to process.env, read on every call). */
  env?: EnvSource;
  /** The undici fetch used with the proxy dispatcher (tests only). */
  transportFetch?: typeof undiciFetch;
  now?: () => Date;
};

/**
 * Builds the ITA-scoped fetch. Order per call: destination allowlist →
 * environment → config validation → dispatcher → request. Any failure before
 * the last step throws an AuthorityEgressError and no socket is opened.
 */
export function createAuthorityEgressFetch(
  deps: AuthorityEgressFetchDeps = {}
): typeof fetch {
  const transportFetch = deps.transportFetch ?? undiciFetch;
  let cached: { fingerprint: string; dispatcher: Dispatcher } | null = null;

  const egressFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const destination = assertAuthorityEgressDestination(input);
    const env = deps.env ?? process.env;
    const environment = resolveEnvironment(env);
    const config = resolveAuthorityEgressConfig(
      env,
      environment,
      deps.now ? deps.now() : new Date()
    );

    if (!cached || cached.fingerprint !== config.fingerprint) {
      const previous = cached;
      cached = { fingerprint: config.fingerprint, dispatcher: buildProxyAgent(config) };
      if (previous) void previous.dispatcher.close().catch(() => undefined);
    }

    const response = await transportFetch(destination.href, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      redirect: "error",
      dispatcher: cached.dispatcher,
    });
    return response as unknown as Response;
  };

  return egressFetch as typeof fetch;
}

/** Production ITA transport — the default for every authority call-site. */
export const authorityEgressFetch: typeof fetch = createAuthorityEgressFetch();

export type AuthorityEgressDiagnostics = {
  environment: BillingAuthorityEnvironment | null;
  egressConfigured: boolean;
  errorCode: AuthorityEgressErrorCode | null;
  proxyHost: string | null;
  proxyCaPresent: boolean;
  clientCertPresent: boolean;
  privateKeyPresent: boolean;
};

/**
 * Sanitized configuration summary: presence flags, the non-secret proxy host,
 * and an error code. Never contents. Performs no network I/O.
 */
export function describeAuthorityEgressConfig(
  env: EnvSource = process.env,
  now: Date = new Date()
): AuthorityEgressDiagnostics {
  const present = (name: string) =>
    typeof env[name] === "string" && env[name]!.trim().length > 0;

  let environment: BillingAuthorityEnvironment | null = null;
  try {
    environment = resolveEnvironment(env);
  } catch (error) {
    return {
      environment: null,
      egressConfigured: false,
      errorCode: isAuthorityEgressError(error) ? error.code : AUTHORITY_EGRESS_ERROR_CODES.ENVIRONMENT_INVALID,
      proxyHost: null,
      proxyCaPresent: false,
      clientCertPresent: false,
      privateKeyPresent: false,
    };
  }

  const flags = {
    proxyCaPresent: present(authorityEgressEnvVarName("proxyCa", environment)),
    clientCertPresent: present(authorityEgressEnvVarName("clientCert", environment)),
    privateKeyPresent: present(authorityEgressEnvVarName("clientKey", environment)),
  };

  try {
    const config = resolveAuthorityEgressConfig(env, environment, now);
    return { environment, egressConfigured: true, errorCode: null, proxyHost: config.proxyHost, ...flags };
  } catch (error) {
    return {
      environment,
      egressConfigured: false,
      errorCode: isAuthorityEgressError(error) ? error.code : AUTHORITY_EGRESS_ERROR_CODES.CONFIG_INVALID,
      proxyHost: null,
      ...flags,
    };
  }
}
