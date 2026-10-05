/**
 * The version line Settings shows. `package.json` alone has said 0.1.0 for the
 * product's whole life, so on its own it identifies nothing; the deployed
 * commit does. Vercel provides that commit as VERCEL_GIT_COMMIT_SHA at build
 * and run time — only its short form is shown (it is already public in the
 * deployment, and carries no secret). Locally there is no SHA and the line is
 * just the package version.
 */
import packageJson from "../package.json";

export type AppVersion = {
  version: string;
  /** Short deployed commit, or null outside a Vercel build. */
  build: string | null;
};

export function resolveAppVersion(env: Record<string, string | undefined> = process.env): AppVersion {
  const sha = (env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return {
    version: packageJson.version,
    build: /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null,
  };
}

export function formatAppVersion(v: AppVersion): string {
  return v.build ? `${v.version} (${v.build})` : v.version;
}
