// Bundles the harness with the repo esbuild. Run from the repo root: node qa-evidence/home-v4/harness/build.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(REPO + "/package.json");
const esbuild = require("esbuild");

const stub = (f) => path.join(here, "stubs", f);
const map = {
  "next/link": stub("next-link.tsx"),
  "next/navigation": stub("next-navigation.tsx"),
  "next/dynamic": stub("next-dynamic.tsx"),
  "@/components/auth/refresh-coordinator": stub("refresh.tsx"),
};

await esbuild.build({
  entryPoints: [path.join(here, "entry.tsx")],
  bundle: true,
  outfile: path.join(here, "out", "app.js"),
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  tsconfig: REPO + "/tsconfig.json",
  nodePaths: [REPO + "/node_modules"],
  define: { "process.env.NODE_ENV": '"production"' },
  minify: false,
  logLevel: "warning",
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^(next\/(link|navigation|dynamic)|@\/components\/auth\/refresh-coordinator)$/ }, (a) => ({ path: map[a.path] }));
        // The shell CSS imports nothing; app CSS (Tailwind) is not needed — the screens carry their own styles.
        b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "empty" }));
        b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "css" }));
      },
    },
  ],
});
console.log("built");
