/**
 * D2 / PRIVILEGED-WRITE-2 — constants shared by the provisioning step and the
 * battery. Synthetic CI-only credentials; never used outside the ephemeral lab.
 */

export const TARGET = process.env.BATTERY_TARGET === "neon" ? "neon" : "pg";

/** Tenant runtime role. Preview uses the persistent P4-B runtime role. */
export const RT_ROLE = TARGET === "neon" ? "app_runtime_preview_p4b" : "pw2_runtime";
export const RT_PW = "pw2_ci_synthetic_runtime_pw";

/** Admin read login role. Preview uses the persistent W2-GATE admin role. */
export const ADMIN_ROLE = TARGET === "neon" ? "app_admin_preview" : "pw2_admin";
export const ADMIN_PW = "pw2_ci_synthetic_admin_pw";

/** Control-plane login role — the new PW-2 credential. */
export const CTL_ROLE = TARGET === "neon" ? "app_ctlplane_preview" : "pw2_ctlplane";
export const CTL_PW = "pw2_ci_synthetic_ctlplane_pw";

/** Marker prefix for every synthetic fixture this wave creates. */
export const MARK = "pw2-";

/** The code catalog (lib/services/feature-access/platform-feature-catalog.ts). */
export const FEATURE_KEYS = [
  "documents",
  "billing",
  "inbox",
  "inventory",
  "content",
  "pricing",
  "revenue",
  "gmail_import",
  "whatsapp",
  "starter_bot",
  "reports",
];

/** Endpoints this wave must never touch, plus the one Preview endpoint it may. */
const DENY_ENDPOINTS = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];
const PREVIEW_ENDPOINT = "ep-wispy-dawn-amr74bwz";

export function assertEndpointSafety(url, label) {
  for (const bad of DENY_ENDPOINTS) {
    if (url.includes(bad)) {
      throw new Error(`DENY: ${label} points at a forbidden endpoint (${bad})`);
    }
  }
  if (TARGET === "neon" && !url.includes(PREVIEW_ENDPOINT)) {
    throw new Error(`DENY: ${label} is not the approved Preview endpoint`);
  }
  if (TARGET === "pg" && !/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`DENY: ${label} is not a local lab endpoint for BATTERY_TARGET=pg`);
  }
}

/**
 * `$`-aware statement splitter: DO $$ ... $$ blocks stay atomic, and trailing
 * comment-only fragments are dropped.
 */
export function splitSql(sql) {
  const out = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.replace(/--.*$/, "");
    if ((stripped.match(/\$\$/g) || []).length % 2 === 1) inDollar = !inDollar;
    buf += line + "\n";
    if (!inDollar && /;\s*$/.test(stripped)) {
      const stmt = buf.replace(/^\s*--.*$/gm, "").trim();
      if (stmt) out.push(stmt.replace(/;\s*$/, ""));
      buf = "";
    }
  }
  const tail = buf.replace(/^\s*--.*$/gm, "").trim();
  if (tail) out.push(tail);
  return out;
}
