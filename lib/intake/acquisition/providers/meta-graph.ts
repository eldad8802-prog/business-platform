/**
 * M6 — the Graph calls the Meta CONNECT flow makes, on the owner's behalf, with the user token the
 * owner's own Facebook Login for Business produced (never stored):
 *   listManagedPages   GET /me/accounts — Pages the owner manages, with each Page's token and tasks
 *   subscribePage      POST /{page-id}/subscribed_apps?subscribed_fields=leadgen (Page token)
 *   unsubscribePage    DELETE /{page-id}/subscribed_apps (best-effort, on disconnect)
 * Only a Page on which the owner can ADVERTISE (Meta's requirement for reading leads) is offered.
 * appsecret_proof accompanies every call when META_LEAD_ADS_APP_SECRET is set.
 */
import { createHmac } from "node:crypto";
import { metaAppId, metaAppSecret, metaGraphVersion } from "../meta-config";
type GraphCall = (method: "GET" | "POST" | "DELETE", path: string, token: string) => Promise<{ status: number; json: unknown }>;

const realCall: GraphCall = async (method, path, token) => {
  const secret = metaAppSecret();
  const version = metaGraphVersion();
  const sep = path.includes("?") ? "&" : "?";
  const proof = secret ? `${sep}appsecret_proof=${createHmac("sha256", secret).update(token).digest("hex")}` : "";
  const r = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}${path}${proof}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};
let call: GraphCall = realCall;

export function setMetaGraphCallForTests(fn: GraphCall | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  call = fn ?? realCall;
}

export type ManagedPage = { id: string; name: string; canAdvertise: boolean; accessToken: string };

export class MetaGraphError extends Error {
  constructor(readonly code: "token_invalid" | "permission_missing" | "provider_error") {
    super(code);
  }
}

function fail(status: number, json: unknown): never {
  const code = (json as { error?: { code?: number } } | null)?.error?.code;
  if (code === 190 || status === 401) throw new MetaGraphError("token_invalid");
  if (code === 10 || code === 200 || status === 403) throw new MetaGraphError("permission_missing");
  throw new MetaGraphError("provider_error");
}

export async function listManagedPages(userToken: string): Promise<ManagedPage[]> {
  const res = await call("GET", "/me/accounts?fields=id,name,access_token,tasks&limit=100", userToken);
  if (res.status !== 200) fail(res.status, res.json);
  const data = (res.json as { data?: unknown })?.data;
  return (Array.isArray(data) ? data : [])
    .map((p) => p as { id?: unknown; name?: unknown; access_token?: unknown; tasks?: unknown })
    .filter((p) => typeof p.id === "string" && /^[0-9]{1,32}$/.test(p.id) && typeof p.access_token === "string")
    .map((p) => ({
      id: p.id as string,
      name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
      canAdvertise: Array.isArray(p.tasks) && p.tasks.includes("ADVERTISE"),
      accessToken: p.access_token as string,
    }));
}

/**
 * The one-time code from the owner's Facebook Login for Business → their user token (JS SDK code
 * flow: no redirect_uri; the app secret stays server-side and is never logged).
 */
export async function exchangeLoginCode(code: string): Promise<string> {
  const id = metaAppId();
  const secret = metaAppSecret();
  if (!id || !secret) throw new MetaGraphError("provider_error");
  if (typeof code !== "string" || !code || code.length > 2048) throw new MetaGraphError("token_invalid");
  const url = new URL(`https://graph.facebook.com/${encodeURIComponent(metaGraphVersion())}/oauth/access_token`);
  url.searchParams.set("client_id", id);
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("code", code);
  const res = await exchange(url.toString());
  const token = (res.json as { access_token?: unknown } | null)?.access_token;
  if (res.status !== 200 || typeof token !== "string" || !token) fail(res.status, res.json);
  return token;
}

type Exchange = (url: string) => Promise<{ status: number; json: unknown }>;
const realExchange: Exchange = async (url) => {
  const r = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  let json: unknown = null;
  try { json = await r.json(); } catch { json = null; }
  return { status: r.status, json };
};
let exchange: Exchange = realExchange;
export function setMetaCodeExchangeForTests(fn: Exchange | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("test hook disabled in production");
  exchange = fn ?? realExchange;
}

export async function subscribePage(pageId: string, pageToken: string): Promise<void> {
  const res = await call("POST", `/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=leadgen`, pageToken);
  if (res.status !== 200 || (res.json as { success?: unknown } | null)?.success !== true) fail(res.status, res.json);
}

export async function unsubscribePage(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const res = await call("DELETE", `/${encodeURIComponent(pageId)}/subscribed_apps`, pageToken);
    return res.status === 200;
  } catch {
    return false;
  }
}
