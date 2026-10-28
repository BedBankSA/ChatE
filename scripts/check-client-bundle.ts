// Fails when a server-only secret name or value appears in the built client
// bundle. Run after `npm run build`; it reads `.next/static` only, so it never
// inspects server chunks.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
  "OTP_HTTP_AUTHORIZATION",
  "OTP_PEPPER",
  "GOOGLE_CLIENT_SECRET",
  "ADMIN_GOOGLE_SUBS",
  "ADMIN_EMAILS",
] as const;

const STATIC_DIR = path.join(process.cwd(), ".next", "static");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...walk(full));
    else if (item.isFile() && /\.(?:js|mjs|cjs)$/.test(item.name)) files.push(full);
  }
  return files;
}

function secretValues(): string[] {
  return SECRET_NAMES.map((name) => process.env[name]?.trim() ?? "")
    .filter((value) => value.length >= 8);
}

function main(): void {
  if (!existsSync(STATIC_DIR) || !statSync(STATIC_DIR).isDirectory()) {
    console.error(`لا يوجد ${path.relative(process.cwd(), STATIC_DIR)}. شغّل npm run build أولًا.`);
    process.exit(1);
  }
  const files = walk(STATIC_DIR);
  const values = secretValues();
  const findings: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of SECRET_NAMES) {
      if (text.includes(name)) findings.push(`${path.relative(process.cwd(), file)}: ${name}`);
    }
    for (const value of values) {
      if (text.includes(value)) findings.push(`${path.relative(process.cwd(), file)}: secret value`);
    }
  }
  if (findings.length > 0) {
    console.error("تسرب اسم سر أو قيمة سر إلى حزمة المتصفح:");
    for (const finding of findings) console.error(` - ${finding}`);
    process.exit(1);
  }
  console.log(`client bundle clean: ${files.length} files, no server secret names or values`);
}

main();
