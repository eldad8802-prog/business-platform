/**
 * SEC-F — durable security events.
 *
 * Every security-relevant decision the product makes (a login refused, a
 * refresh credential replayed, an admin MFA failure, an integration connected,
 * a tenant's data exported) is appended to `SecurityEvent`. The table is
 * append-only at the database; the runtime may INSERT and nothing else, and only
 * the platform-admin identity can read it.
 *
 * PII MINIMISATION IS A PROPERTY OF THIS MODULE, NOT OF ITS CALLERS
 *
 *   - the event type is a closed enum; the reason is a closed snake_case class
 *   - identities are ids (userId, businessId) — never an email address
 *   - the network identity is a KEYED hash of a truncated address (/24 IPv4,
 *     /48 IPv6); with no key configured nothing about the address is kept,
 *     because an unkeyed hash of an IPv4 address is reversible by enumeration
 *   - metadata keeps only scalar values under non-sensitive keys: any key that
 *     names a token, password, secret, cookie, authorization, email, phone or
 *     code is dropped, and any string that is not a short identifier-like token
 *     is dropped — so an email or a bearer token cannot ride in by accident
 *
 * BEST EFFORT, NEVER BLOCKING THE FLOW IT OBSERVES
 *
 * `recordSecurityEvent` never throws. A failed write increments a process
 * counter and emits the sanitised event as one structured console line
 * (`SECURITY_EVENT_WRITE_FAILED`), so the event survives in the log stream even
 * when the database refused it.
 */
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { tenantTx } from "@/lib/tenant/tenant-tx";

export const SECURITY_EVENT_TYPES = [
  "AUTH_LOGIN_SUCCESS",
  "AUTH_LOGIN_FAILURE",
  "AUTH_REGISTER",
  "AUTH_REFRESH_REUSE_DETECTED",
  "AUTH_REFRESH_CSRF_REFUSED",
  "AUTH_LOGOUT",
  "AUTH_LOGOUT_ALL",
  "AUTH_SESSION_REVOKED",
  "ADMIN_MFA_ENROLLED",
  "ADMIN_MFA_VERIFY_SUCCESS",
  "ADMIN_MFA_VERIFY_FAILURE",
  "ADMIN_ELEVATION_GRANTED",
  "INTEGRATION_CONNECTED",
  "INTEGRATION_DISCONNECTED",
  "ACCOUNT_DELETION_REQUESTED",
  "ACCOUNT_DELETION_STAGE",
  "ACCOUNT_DELETION_COMPLETED",
  "DATA_EXPORT",
  "DATA_IMPORT_EXECUTED",
  "COST_LIMIT_DENIED",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export type SecurityEventOutcome = "SUCCESS" | "FAILURE" | "DENIED" | "INFO";
export type SecurityActorKind = "USER" | "PLATFORM_ADMIN" | "SYSTEM" | "ANONYMOUS";

export type SecurityEventInput = {
  type: SecurityEventType;
  outcome: SecurityEventOutcome;
  /** Closed snake_case class, e.g. "invalid_credentials". Anything else is dropped. */
  reason?: string | null;
  businessId?: number | null;
  userId?: number | null;
  actor?: SecurityActorKind;
  /** The request, used only to derive the keyed network hash and the route path. */
  req?: Request | null;
  metadata?: Record<string, unknown> | null;
};

/** The row exactly as written. Exported so tests can assert its keys. */
export type SecurityEventRow = {
  eventType: SecurityEventType;
  outcome: SecurityEventOutcome;
  reasonClass: string | null;
  businessId: number | null;
  userId: number | null;
  actorKind: SecurityActorKind;
  ipHash: string | null;
  route: string | null;
  metadata: Record<string, string | number | boolean | null> | null;
  occurredAt: Date;
};

export type SecurityEventWriter = (row: SecurityEventRow) => Promise<void>;

const SENSITIVE_KEY = /token|password|passwd|secret|cookie|authori[sz]ation|bearer|e-?mail|phone|otp|code|credential|session|iban|card|tax|\bid(number)?\b|national/i;
const SAFE_STRING = /^[A-Za-z0-9_.:\-/]{0,64}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_META_KEYS = 16;

function positiveIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** Keep only scalar, identifier-like values under non-sensitive keys. */
export function sanitizeSecurityMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean | null> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(out).length >= MAX_META_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && SAFE_STRING.test(value) && !value.includes("@")) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** /24 for IPv4, /48 for IPv6: enough to correlate an attack, not to find a person. */
export function truncateIp(ip: string): string | null {
  const s = ip.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(s);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (s.includes(":")) {
    const groups = s.split("::")[0].split(":").filter(Boolean).slice(0, 3);
    return groups.length ? `${groups.join(":")}::/48` : null;
  }
  return null;
}

export function hashNetworkIdentity(ip: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.SECURITY_EVENT_IP_KEY?.trim();
  if (!ip || !key || key.length < 32) return null;
  const truncated = truncateIp(ip);
  if (!truncated) return null;
  return createHmac("sha256", key).update(`dubiz.secevent.ip.v1\n${truncated}`).digest("hex").slice(0, 32);
}

function clientIp(req: Request | null | undefined): string | null {
  if (!req) return null;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.headers.get("x-real-ip")?.trim() || null;
}

function routeOf(req: Request | null | undefined): string | null {
  if (!req) return null;
  try {
    // Path only — never the query string, which is where tokens travel.
    return new URL(req.url).pathname.replace(/\/\d+(?=\/|$)/g, "/:id").slice(0, 128);
  } catch {
    return null;
  }
}

export function buildSecurityEventRow(input: SecurityEventInput, now: Date = new Date()): SecurityEventRow {
  const reason = input.reason && REASON.test(input.reason) ? input.reason : null;
  return {
    eventType: input.type,
    outcome: input.outcome,
    reasonClass: reason,
    businessId: positiveIntOrNull(input.businessId),
    userId: positiveIntOrNull(input.userId),
    actorKind: input.actor ?? (positiveIntOrNull(input.userId) ? "USER" : "ANONYMOUS"),
    ipHash: hashNetworkIdentity(clientIp(input.req)),
    route: routeOf(input.req),
    metadata: sanitizeSecurityMetadata(input.metadata),
    occurredAt: now,
  };
}

/**
 * The database writer. INSERT without RETURNING (`createMany`): the runtime
 * holds INSERT and deliberately no SELECT on this table.
 *
 * A business-attributed event is written through the canonical tenant
 * transaction, whose GUC names the only business the insert rule lets it name.
 * A pre-authentication event (a refused login for an unknown address, a
 * cross-site refresh) has no tenant by definition; the insert rule admits it
 * only with businessId NULL — the one bare-client write, allow-listed in the
 * tenant-scoped access guard with that reason.
 */
export const prismaSecurityEventWriter: SecurityEventWriter = async (row) => {
  const data = {
    ...row,
    metadata: row.metadata ?? undefined,
  };
  if (row.businessId === null) {
    await prisma.securityEvent.createMany({ data: [data] });
    return;
  }
  await tenantTx(row.businessId, (tx) => tx.securityEvent.createMany({ data: [data] }));
};

let writeFailures = 0;
let writer: SecurityEventWriter = prismaSecurityEventWriter;

export function getSecurityEventWriteFailures(): number {
  return writeFailures;
}

/** Test seam. Returns the previous writer. */
export function setSecurityEventWriterForTests(next: SecurityEventWriter): SecurityEventWriter {
  const prev = writer;
  writer = next;
  return prev;
}

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  let row: SecurityEventRow;
  try {
    row = buildSecurityEventRow(input);
  } catch {
    writeFailures++;
    return;
  }
  try {
    await writer(row);
  } catch (error) {
    writeFailures++;
    console.error(
      JSON.stringify({
        event: "SECURITY_EVENT_WRITE_FAILED",
        failures: writeFailures,
        error: error instanceof Error ? error.name : "UnknownError",
        securityEvent: { ...row, occurredAt: row.occurredAt.toISOString() },
      })
    );
  }
}
