import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  globalIgnores([".tools/**", ".next/**", "node_modules/**", "coverage/**", "storage/**"]),
  ...nextVitals,
]);
