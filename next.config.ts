import type { NextConfig } from "next";
import { securityHeaders } from "./src/domain/security/headers";

// HSTS must be emitted in production even when APP_URL is not https-prefixed;
// otherwise the first request stays downgradeable.
const https =
  process.env.NODE_ENV === "production" || (process.env.APP_URL ?? "").startsWith("https://");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "exceljs",
    "mammoth",
    "word-extractor",
    "unpdf",
    "jszip",
    "xlsx",
  ],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(https, process.env.NODE_ENV !== "production") }];
  },
};

export default nextConfig;
