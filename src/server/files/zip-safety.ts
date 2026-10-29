import { inspectZipEntry, type ZipLimits } from "@/domain/files/content";

/**
 * ZIP/DOCX decompression guard. A small .docx can expand to gigabytes when the
 * extractor trusts the archive, which is a cheap memory-exhaustion DoS. Limits
 * come from the documented MAX_ZIP_* environment variables; the defaults are
 * conservative and always finite.
 */
export const ZIP_LIMIT_DEFAULTS: ZipLimits = {
  maxEntries: 200,
  maxDepth: 4,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxMemberBytes: 25 * 1024 * 1024,
};

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function readZipLimits(env: Record<string, string | undefined> = process.env): ZipLimits {
  const maxUncompressedBytes = positiveInt(env.MAX_ZIP_UNCOMPRESSED_BYTES, ZIP_LIMIT_DEFAULTS.maxUncompressedBytes, 2_000_000_000);
  return {
    maxEntries: positiveInt(env.MAX_ZIP_ENTRIES, ZIP_LIMIT_DEFAULTS.maxEntries, 100_000),
    maxDepth: positiveInt(env.MAX_ZIP_DEPTH, ZIP_LIMIT_DEFAULTS.maxDepth, 64),
    maxUncompressedBytes,
    // A single member can never be allowed to exceed the whole archive budget.
    maxMemberBytes: Math.min(positiveInt(env.MAX_FILE_BYTES, ZIP_LIMIT_DEFAULTS.maxMemberBytes, 2_000_000_000), maxUncompressedBytes),
  };
}

export type ZipSafety = { ok: true } | { ok: false; reason: string };

/**
 * Loads only the archive directory (JSZip parses the central directory; no
 * member is decompressed here) and applies the shared entry/depth/size policy
 * before any extractor is allowed to expand the file.
 */
export async function inspectZipBytes(bytes: Uint8Array, limits: ZipLimits): Promise<ZipSafety> {
  let zip: { files: Record<string, { name: string; _data?: { uncompressedSize?: number; unixPermissions?: number } }> };
  try {
    const JSZip = (await import("jszip")).default;
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const entries = Object.values(zip.files);
  if (entries.length > limits.maxEntries) return { ok: false, reason: "count" };
  const state = { count: 0, bytes: 0 };
  for (const entry of entries) {
    const meta = {
      name: entry.name,
      uncompressedSize: typeof entry._data?.uncompressedSize === "number" ? entry._data.uncompressedSize : 0,
      unixMode: typeof entry._data?.unixPermissions === "number" ? entry._data.unixPermissions : undefined,
    };
    const verdict = inspectZipEntry(meta, limits, state);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    state.count += 1;
    state.bytes += meta.uncompressedSize;
  }
  return { ok: true };
}
