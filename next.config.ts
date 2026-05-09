import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright is Node-native; do not bundle it into the serverless output.
  serverExternalPackages: ["playwright", "playwright-core"],
};

export default nextConfig;
