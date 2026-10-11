import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3", "playwright", "playwright-core"],
  // Private, runtime-owned records and credentials are provisioned separately.
  // Native SQLite tracing must not package a developer's existing case database.
  outputFileTracingExcludes: { "/*": ["./data/**/*", "./.env", "./.env.*"] },
};

export default nextConfig;
