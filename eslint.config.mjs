import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  globalIgnores([
    ".next/**",
    ".tools/**",
    ".agents/**",
    ".codex/**",
    ".cursor/**",
    "coverage/**",
    "data/**",
    "storage/**",
    "node_modules/**",
    // Local dependency backups/junctions (gitignored) must not fail `npm run lint`.
    "node_modules.*/**",
  ]),
  ...nextVitals,
]);
