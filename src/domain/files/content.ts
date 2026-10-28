export type DetectedKind =
  | "pdf"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "docx"
  | "xlsx"
  | "zip"
  | "ole"
  | "json"
  | "csv"
  | "tsv"
  | "markdown"
  | "text"
  | "audio"
  | "video"
  | "unknown";

export function detectContent(bytes: Uint8Array, claimedName: string): DetectedKind {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (isWebp(bytes)) return "webp";
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return "ole";
  if (isZip(bytes)) return "zip";
  if (isAudio(bytes)) return "audio";
  if (isVideo(bytes)) return "video";
  if (!looksBinary(bytes)) return textKind(bytes, claimedName);
  return "unknown";
}

export function classifyOfficeZip(entryNames: string[]): "docx" | "xlsx" | "zip" {
  const names = entryNames.map((name) => name.replace(/\\/g, "/"));
  if (names.some((name) => name.startsWith("word/"))) return "docx";
  if (names.some((name) => name.startsWith("xl/"))) return "xlsx";
  return "zip";
}

function textKind(bytes: Uint8Array, claimedName: string): DetectedKind {
  const text = decodeText(bytes).text.trim();
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  const lower = claimedName.toLowerCase();
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "text";
}

export function decodeText(bytes: Uint8Array): { encoding: "utf-8" | "utf-16le" | "failed"; text: string } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", text: Buffer.from(bytes).toString("utf16le") };
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start));
    return { encoding: "utf-8", text };
  } catch {
    return { encoding: "failed", text: "" };
  }
}

export function parseJsonDocument(original: string): { ok: true; value: unknown; original: string } | { ok: false; original: string; message: string } {
  try {
    return { ok: true, value: JSON.parse(original) as unknown, original };
  } catch (error) {
    return { ok: false, original, message: error instanceof Error ? error.message : "JSON" };
  }
}

function starts(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function isZip(bytes: Uint8Array): boolean {
  return starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length > 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function isAudio(bytes: Uint8Array): boolean {
  if (starts(bytes, [0x49, 0x44, 0x33])) return true;
  if (starts(bytes, [0x4f, 0x67, 0x67, 0x53])) return true;
  return bytes.length > 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes[8] === 0x57 && bytes[9] === 0x41;
}

function isVideo(bytes: Uint8Array): boolean {
  return bytes.length > 11 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, 800);
  let odd = 0;
  for (const value of sample) {
    if (value === 0) return true;
    if (value < 9) odd += 1;
  }
  return odd > 8;
}

export type ZipLimits = {
  maxEntries: number;
  maxDepth: number;
  maxUncompressedBytes: number;
  maxMemberBytes: number;
};

export type ZipEntry = {
  name: string;
  uncompressedSize: number;
  unixMode?: number;
};

export function inspectZipEntry(entry: ZipEntry, limits: ZipLimits, state: { count: number; bytes: number }): { ok: true; safeName: string } | { ok: false; reason: string } {
  const name = entry.name.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").includes("..")) {
    return { ok: false, reason: "path_traversal" };
  }
  if ((entry.unixMode ?? 0) & 0o170000) {
    const type = (entry.unixMode ?? 0) & 0o170000;
    if (type === 0o120000) return { ok: false, reason: "symlink" };
  }
  const depth = name.split("/").filter(Boolean).length;
  if (depth > limits.maxDepth) return { ok: false, reason: "depth" };
  if (state.count + 1 > limits.maxEntries) return { ok: false, reason: "count" };
  if (entry.uncompressedSize > limits.maxMemberBytes) return { ok: false, reason: "member_size" };
  if (state.bytes + entry.uncompressedSize > limits.maxUncompressedBytes) return { ok: false, reason: "total_size" };
  return { ok: true, safeName: name };
}

export function reportPages(
  pages: { page: number; text: string }[],
  ocr: (page: number) => { ok: boolean; text?: string },
): { page: number; status: "read" | "ocr" | "failed"; text?: string; reason?: string }[] {
  return pages.map((page) => {
    if (page.text.trim()) return { page: page.page, status: "read", text: page.text };
    const result = ocr(page.page);
    if (!result.ok) return { page: page.page, status: "failed", reason: "ocr_failed" };
    return { page: page.page, status: "ocr", text: result.text ?? "" };
  });
}

export function officeRoute(detected: DetectedKind): "legacy-doc-worker" | "zip-sniff" | DetectedKind {
  if (detected === "ole") return "legacy-doc-worker";
  if (detected === "zip") return "zip-sniff";
  return detected;
}
