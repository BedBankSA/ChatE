export type ZipLimits = {
  maxEntries: number;
  maxDepth: number;
  maxUncompressedBytes: number;
  maxMemberBytes: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 200,
  maxDepth: 4,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxMemberBytes: 25 * 1024 * 1024,
};

export function inspectZipEntry(input: {
  name: string;
  uncompressedBytes: number;
  symlink: boolean;
  limits: ZipLimits;
}): { ok: true; safeName: string } | { ok: false; reason: string } {
  const name = input.name.replaceAll("\\", "/");
  if (!name || name.startsWith("/") || name.includes("\0")) return { ok: false, reason: "path" };
  if (name.split("/").some((part) => part === "..")) return { ok: false, reason: "zip_slip" };
  if (input.symlink) return { ok: false, reason: "symlink" };
  const depth = name.split("/").filter(Boolean).length;
  if (depth > input.limits.maxDepth) return { ok: false, reason: "depth" };
  if (input.uncompressedBytes > input.limits.maxMemberBytes) return { ok: false, reason: "oversize" };
  return { ok: true, safeName: name };
}

export function assertZipBudget(entryCount: number, totalBytes: number, limits: ZipLimits): { ok: true } | { ok: false; reason: string } {
  if (entryCount > limits.maxEntries) return { ok: false, reason: "count" };
  if (totalBytes > limits.maxUncompressedBytes) return { ok: false, reason: "oversize" };
  return { ok: true };
}
