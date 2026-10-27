import type { NextConfig } from "next";
import { securityHeaders } from "./src/domain/security/headers";

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
    return [{ source: "/:path*", headers: securityHeaders(false, process.env.NODE_ENV !== "production") }];
  },
};

export default nextConfig;
