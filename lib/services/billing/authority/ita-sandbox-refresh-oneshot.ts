/**
 * TEMPORARY, PREVIEW-ONLY, ONE-SHOT: one controlled SANDBOX token refresh for
 * lab business 9 / connection 2 (#36423501), through the Kamatera egress.
 *
 * Runs the existing refreshAuthorityConnectionToken() once, inside
 * runWithAuthorityRefreshAllowance() — the only scope in which the OAuth-only
 * egress block admits a grant_type=refresh_token request, and only once.
 * Approval and InvoiceDecision stay blocked; refresh from any other caller
 * stays blocked.
 *
 * SAFETY (every fuse before any network I/O and before any write)
 *   - Access limits: single-use ticket (SHA-256 pinned) + run window pinned at
 *     push. NOT a deployment-wide single-use guarantee: the single attempt rests
 *     on the controlled operator (one request, no retry).
 *   - Preview + egress branch, SANDBOX runtime, SANDBOX egress config with the
 *     fixed gateway origin, exact SANDBOX token path.
 *   - Lab target only: business 9, connection 2, SANDBOX, CONNECTED/VALIDATED,
 *     encrypted refresh token present.
 *   - Once per connection: refused if any TOKEN_REFRESHED / TOKEN_REFRESH_FAILED
 *     audit already exists for business 9 (survives instances and redeploys).
 *   - One start per instance; one transport call; DB reachability checked right
 *     before the exchange.
 *   - Output: outcome classes, HTTP status, error codes, timestamps and
 *     changed/unchanged flags only — never a token, ciphertext or secret.
 *
 * THROWAWAY: removed by a revert after the single run, in the coordinated
 * cleanup order (never before every deployment with token access is handled).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AUTHORITY_EGRESS_ALLOWED_HOSTS,
  authorityEgressFetch,
  isAuthorityEgressError,
  resolveAuthorityEgressConfig,
  runWithAuthorityRefreshAllowance,
} from "@/lib/services/billing/authority/billing-authority-egress";
import {
  buildAuthorityOAuthTokenUrl,
  resolveAuthorityEnvConfig,
} from "@/lib/services/billing/authority/billing-authority-env.service";
import {
  refreshAuthorityConnectionToken,
  type RefreshAuthorityConnectionTokenResult,
} from "@/lib/services/billing/authority/billing-authority-token-refresh.service";
import { prisma } from "@/lib/prisma";

export const REFRESH_ONESHOT_BRANCH = "feat/ita-authority-egress";
export const REFRESH_ONESHOT_GATEWAY_ORIGIN = "https://91.223.106.183";
export const REFRESH_ONESHOT_TOKEN_PATH = "/shaam/tsandbox/longtimetoken/oauth2/token";
export const REFRESH_ONESHOT_BUSINESS_ID = 9;
export const REFRESH_ONESHOT_CONNECTION_ID = 2;
/** SHA-256 of the operator's single-use ticket (hex). */
export const REFRESH_ONESHOT_TICKET_SHA256 = "e36eddbfd282e29034185f05aba3ccdaae4a4ba4bd163a132831174f2e04b174";
/** Run window, pinned at push time. Placeholders refuse every call. */
export const REFRESH_ONESHOT_NOT_BEFORE = "__NOT_BEFORE__";
export const REFRESH_ONESHOT_NOT_AFTER = "__NOT_AFTER__";
const REFRESH_TIMEOUT_MS = 15_000;

/** Final classification of the single attempt. */
export type RefreshOneshotOutcome =
  | "REFRESHED" // 2xx with access_token, persisted, state verified changed
  | "AUTH_REJECTED" // provider 4xx; service moved the connection to AUTHORIZATION_REQUIRED
  | "NOT_SENT" // failed before the request reached the provider
  | "UNCERTAIN_SENT" // may have reached the provider (timeout / reset / 5xx): stored refresh token may be stale
  | "UNCERTAIN_RESPONSE" // 2xx but unusable body: provider may have rotated tokens
  | "UNCERTAIN_PERSIST" // provider answered, persisting threw: new tokens are lost by design (never logged)
  | "REFUSED_BY_FUSE";

type ConnectionSnapshot = {
  id: number;
  businessId: number;
  environment: string;
  status: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  refreshTokenIv: string | null;
  refreshTokenTag: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  lastTokenRefreshAt: Date | null;
  lastErrorCode: string | null;
};

export type RefreshOneshotResult = {
  attemptId: string | null;
  outcome: RefreshOneshotOutcome;
  fuse: string | null;
  serviceOutcome: RefreshAuthorityConnectionTokenResult["outcome"] | null;
  serviceErrorCode: string | null;
  httpStatus: number | null;
  transportCalls: number;
  errorChain: { name: string | null; code: string | null }[];
  before: SafeState | null;
  after: SafeState | null;
  accessTokenChanged: boolean | null;
  refreshTokenRotated: boolean | null;
  latestAuditEventType: string | null;
  elapsedMs: number;
};

type SafeState = {
  status: string;
  accessTokenPresent: boolean;
  refreshTokenPresent: boolean;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  lastTokenRefreshAt: string | null;
  lastErrorCode: string | null;
};

type Env = Readonly<Record<string, string | undefined>>;

export type RefreshOneshotDeps = {
  env?: Env;
  ticket?: string | null;
  now?: () => number;
  /** Test seams only. */
  pinned?: { ticketSha256: string; notBefore: string; notAfter: string };
  gatewayOrigin?: string;
  buildTokenEndpoint?: () => string;
  loadConnection?: () => Promise<ConnectionSnapshot | null>;
  countRefreshAudits?: () => Promise<number>;
  latestAuditEventType?: () => Promise<string | null>;
  pingDb?: () => Promise<void>;
  refresh?: typeof refreshAuthorityConnectionToken;
  transport?: typeof fetch;
};

let used = false;
export function resetRefreshOneshotForTests(): void {
  used = false;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
function sanitizeErrorChain(error: unknown) {
  const chain: { name: string | null; code: string | null }[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const e = current as { name?: unknown; code?: unknown; cause?: unknown };
    chain.push({
      name: typeof e.name === "string" && SAFE_TOKEN.test(e.name) ? e.name : null,
      code: typeof e.code === "string" && SAFE_TOKEN.test(e.code) ? e.code : null,
    });
    current = e.cause;
  }
  return chain;
}

/**
 * Codes that PROVE the request never reached the provider: egress refusals,
 * connect-phase failures, and certificate-verification failures (handshake
 * only). Anything else — generic TLS/SSL errors, resets, aborts — may occur
 * after the request was written and is classified as uncertain.
 */
const PRE_SEND = /^(ITA_EGRESS_[A-Z_]+|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|ERR_TLS_CERT_ALTNAME_INVALID|CERT_[A-Z_]+|UNABLE_TO_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;

function wasProvablyNotSent(error: unknown, chain: { name: string | null; code: string | null }[]): boolean {
  if (isAuthorityEgressError(error)) return true;
  if (chain.some((l) => l.name === "AbortError" || l.name === "TimeoutError")) return false;
  return chain.some((l) => l.code !== null && PRE_SEND.test(l.code));
}

function ticketMatches(ticket: string | null | undefined, expectedHex: string): boolean {
  if (typeof ticket !== "string" || !/^[0-9a-f]{64}$/.test(ticket) || !/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actual = createHash("sha256").update(ticket).digest();
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
function safeState(c: ConnectionSnapshot): SafeState {
  return {
    status: c.status,
    accessTokenPresent: !!c.accessTokenEncrypted,
    refreshTokenPresent: !!c.refreshTokenEncrypted,
    accessTokenExpiresAt: iso(c.accessTokenExpiresAt),
    refreshTokenExpiresAt: iso(c.refreshTokenExpiresAt),
    lastTokenRefreshAt: iso(c.lastTokenRefreshAt),
    lastErrorCode: c.lastErrorCode,
  };
}

const defaultLoadConnection = () =>
  prisma.billingAuthorityConnection.findUnique({
    where: { businessId_environment: { businessId: REFRESH_ONESHOT_BUSINESS_ID, environment: "SANDBOX" } },
    select: {
      id: true, businessId: true, environment: true, status: true,
      accessTokenEncrypted: true, refreshTokenEncrypted: true, refreshTokenIv: true, refreshTokenTag: true,
      accessTokenExpiresAt: true, refreshTokenExpiresAt: true, lastTokenRefreshAt: true, lastErrorCode: true,
    },
  });
const REFRESH_AUDITS = ["BILLING_AUTHORITY_TOKEN_REFRESHED", "BILLING_AUTHORITY_TOKEN_REFRESH_FAILED"];
const defaultCountRefreshAudits = () =>
  prisma.billingAuditEvent.count({ where: { businessId: REFRESH_ONESHOT_BUSINESS_ID, eventType: { in: REFRESH_AUDITS } } });
const defaultLatestAudit = async () =>
  (await prisma.billingAuditEvent.findFirst({ where: { businessId: REFRESH_ONESHOT_BUSINESS_ID }, orderBy: { id: "desc" }, select: { eventType: true } }))?.eventType ?? null;
const defaultPingDb = async () => {
  await prisma.$queryRawUnsafe("SELECT 1");
};

export async function runSandboxRefreshOneshot(deps: RefreshOneshotDeps = {}): Promise<RefreshOneshotResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const pinned = deps.pinned ?? { ticketSha256: REFRESH_ONESHOT_TICKET_SHA256, notBefore: REFRESH_ONESHOT_NOT_BEFORE, notAfter: REFRESH_ONESHOT_NOT_AFTER };
  const base: RefreshOneshotResult = {
    attemptId: null, outcome: "REFUSED_BY_FUSE", fuse: null, serviceOutcome: null, serviceErrorCode: null,
    httpStatus: null, transportCalls: 0, errorChain: [], before: null, after: null,
    accessTokenChanged: null, refreshTokenRotated: null, latestAuditEventType: null, elapsedMs: 0,
  };
  const refuse = (fuse: string): RefreshOneshotResult => ({ ...base, fuse, elapsedMs: now() - startedAt });

  // ── configuration fuses (no I/O) ──
  if (used) return refuse("ALREADY_RAN_ON_INSTANCE");
  const notBefore = Date.parse(pinned.notBefore);
  const notAfter = Date.parse(pinned.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) return refuse("WINDOW_NOT_SET");
  if (now() < notBefore || now() > notAfter) return refuse("OUTSIDE_WINDOW");
  if (!ticketMatches(deps.ticket, pinned.ticketSha256)) return refuse("TICKET_INVALID");
  if (env.VERCEL_ENV !== "preview") return refuse("NOT_PREVIEW");
  if (env.VERCEL_GIT_COMMIT_REF !== REFRESH_ONESHOT_BRANCH) return refuse("WRONG_BRANCH");
  if (env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT?.trim().toUpperCase() !== "SANDBOX") return refuse("NOT_SANDBOX");
  try {
    if (resolveAuthorityEgressConfig(env, "SANDBOX").proxyUrl !== (deps.gatewayOrigin ?? REFRESH_ONESHOT_GATEWAY_ORIGIN)) return refuse("GATEWAY_MISMATCH");
  } catch (error) {
    return refuse(`EGRESS_CONFIG:${isAuthorityEgressError(error) ? error.code : "INVALID"}`);
  }
  try {
    const endpoint = new URL((deps.buildTokenEndpoint ?? (() => buildAuthorityOAuthTokenUrl(resolveAuthorityEnvConfig("SANDBOX"))))());
    const ok = endpoint.protocol === "https:" && endpoint.port === "" && !endpoint.search && !endpoint.username &&
      AUTHORITY_EGRESS_ALLOWED_HOSTS.includes(endpoint.hostname) && endpoint.pathname === REFRESH_ONESHOT_TOKEN_PATH;
    if (!ok) return refuse("TOKEN_ENDPOINT_UNEXPECTED");
  } catch {
    return refuse("TOKEN_ENDPOINT_UNRESOLVED");
  }

  // ── data fuses (reads only) ──
  const loadConnection = deps.loadConnection ?? (defaultLoadConnection as () => Promise<ConnectionSnapshot | null>);
  const before = await loadConnection();
  if (!before) return refuse("CONNECTION_NOT_FOUND");
  if (before.id !== REFRESH_ONESHOT_CONNECTION_ID || before.businessId !== REFRESH_ONESHOT_BUSINESS_ID || before.environment !== "SANDBOX") return refuse("CONNECTION_MISMATCH");
  if (before.status !== "CONNECTED" && before.status !== "VALIDATED") return refuse(`CONNECTION_STATUS:${before.status}`);
  if (!before.refreshTokenEncrypted || !before.refreshTokenIv || !before.refreshTokenTag) return refuse("NO_REFRESH_TOKEN");
  if ((await (deps.countRefreshAudits ?? defaultCountRefreshAudits)()) > 0) return refuse("ALREADY_REFRESHED_ONCE");
  await (deps.pingDb ?? defaultPingDb)();

  // ── the single attempt ──
  used = true;
  const attemptId = `${new Date(now()).toISOString().replace(/[-:.]/g, "").toLowerCase()}-${randomBytes(3).toString("hex")}`;
  const transport = deps.transport ?? authorityEgressFetch;
  let transportCalls = 0;
  let httpStatus: number | null = null;
  let errorChain: { name: string | null; code: string | null }[] = [];
  let thrown: unknown = null;
  const fetchOnce: typeof fetch = async (input, init) => {
    transportCalls += 1;
    if (transportCalls > 1) throw new Error("refresh oneshot: second transport call refused");
    try {
      const response = await transport(input, init);
      httpStatus = response.status;
      return response;
    } catch (error) {
      thrown = error;
      errorChain = sanitizeErrorChain(error);
      throw error;
    }
  };

  let service: RefreshAuthorityConnectionTokenResult | null = null;
  let persistThrew = false;
  try {
    service = await runWithAuthorityRefreshAllowance(() =>
      (deps.refresh ?? refreshAuthorityConnectionToken)({
        businessId: REFRESH_ONESHOT_BUSINESS_ID,
        environment: "SANDBOX",
        actorUserId: null,
        fetchImpl: fetchOnce,
        refreshTimeoutMs: REFRESH_TIMEOUT_MS,
      })
    );
  } catch {
    persistThrew = true;
  }

  const afterRow = await loadConnection().catch(() => null);
  const latestAuditEventType = await (deps.latestAuditEventType ?? defaultLatestAudit)().catch(() => null);
  const accessTokenChanged = afterRow ? afterRow.accessTokenEncrypted !== before.accessTokenEncrypted : null;
  const refreshTokenRotated = afterRow
    ? afterRow.refreshTokenEncrypted !== before.refreshTokenEncrypted || afterRow.refreshTokenIv !== before.refreshTokenIv
    : null;

  let outcome: RefreshOneshotOutcome;
  if (persistThrew) {
    outcome = httpStatus !== null && httpStatus >= 200 && httpStatus < 300 ? "UNCERTAIN_PERSIST" : "UNCERTAIN_SENT";
  } else if (service!.outcome === "REFRESHED") {
    outcome = accessTokenChanged ? "REFRESHED" : "UNCERTAIN_PERSIST";
  } else if (service!.outcome === "AUTH_FAILURE") {
    outcome = "AUTH_REJECTED";
  } else if (service!.outcome === "NETWORK_FAILURE") {
    outcome = transportCalls === 0 || (thrown !== null && wasProvablyNotSent(thrown, errorChain)) ? "NOT_SENT" : "UNCERTAIN_SENT";
  } else {
    // CONFIGURATION_FAILURE: before the transport → NOT_SENT; after a 2xx → unusable response.
    outcome = transportCalls === 0 ? "NOT_SENT" : httpStatus !== null && httpStatus >= 200 && httpStatus < 300 ? "UNCERTAIN_RESPONSE" : "UNCERTAIN_SENT";
  }

  return {
    attemptId,
    outcome,
    fuse: null,
    serviceOutcome: service?.outcome ?? null,
    serviceErrorCode: service?.errorCode ?? null,
    httpStatus,
    transportCalls,
    errorChain,
    before: safeState(before),
    after: afterRow ? safeState(afterRow as ConnectionSnapshot) : null,
    accessTokenChanged,
    refreshTokenRotated,
    latestAuditEventType,
    elapsedMs: now() - startedAt,
  };
}
