import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

// WP1 A-16 / gap G-7 — accessibility linting.
// Note: `eslint-config-next` already REGISTERS the jsx-a11y plugin and enables a subset of
// its rules. We therefore do NOT re-register the plugin (that errors with "Cannot redefine
// plugin"); we only extend coverage to the FULL jsx-a11y recommended set, all as **warn**.
// Phase 1 (current): warn-only (non-blocking) so legacy/existing code is not build-blocked
// (grandfathering, WP9 §10). `eslint` does not fail on warnings (no --max-warnings 0), so new
// and changed code surfaces a11y warnings in review. Promotion of specific rules to "error"
// is a future decision, only after the warning volume drops materially.
// Downgrade every ACTIVE recommended jsx-a11y rule to "warn"; preserve rules the
// recommended config leaves OFF (e.g. the deprecated `label-has-for`) as off — do NOT
// turn them on. (W1 fix: the initial W0 mapping forced off-rules to warn, causing
// false positives.)
const isOff = (sev) => {
  const s = Array.isArray(sev) ? sev[0] : sev;
  return s === "off" || s === 0;
};
const jsxA11yWarn = {
  files: ["**/*.tsx", "**/*.jsx"],
  rules: Object.fromEntries(
    Object.entries(jsxA11y.configs.recommended.rules).map(([rule, sev]) => [
      rule,
      isOff(sev) ? "off" : "warn",
    ]),
  ),
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  jsxA11yWarn,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
