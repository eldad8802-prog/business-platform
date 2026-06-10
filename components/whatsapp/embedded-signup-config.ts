/**
 * Public client config for WhatsApp Embedded Signup (Ticket 3).
 *
 * These are NOT secrets — the Meta App ID and the Login configuration id are
 * exposed to the browser by design (they are passed to `FB.login`). They are
 * read from `NEXT_PUBLIC_*` env so they are available client-side.
 *
 * The App Secret, webhook verify token, and token encryption key are NEVER
 * here — they stay server-only.
 */
export type EmbeddedSignupConfig = {
  appId: string;
  configId: string;
  graphVersion: string;
};

/** Fallback Graph version when the env is not set. Confirm against the Meta dashboard. */
const DEFAULT_GRAPH_VERSION = "v23.0";

/**
 * Returns the config, or `null` when the required public env vars are not set
 * (e.g. a staging build without Ticket 0 completed). Callers treat `null` as
 * "not ready to launch" and surface a soft error instead of crashing.
 */
export function getEmbeddedSignupConfig(): EmbeddedSignupConfig | null {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  const graphVersion =
    process.env.NEXT_PUBLIC_WHATSAPP_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;

  if (!appId || !configId) {
    return null;
  }

  return { appId, configId, graphVersion };
}
