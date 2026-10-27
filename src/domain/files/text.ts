export type SourceRef = {
  fileId: string;
  name: string;
  page?: number;
  sheet?: string;
  row?: number;
  cell?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
};

export function decodeText(bytes: Uint8Array): { ok: true; text: string; encoding: string } | { ok: false; reason: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: true, text: new TextDecoder("utf-8").decode(bytes.slice(3)), encoding: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { ok: true, text: new TextDecoder("utf-16le").decode(bytes.slice(2)), encoding: "utf-16le" };
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { ok: false, reason: "encoding" };
  }
}

export function readJson(text: string): { ok: true; value: unknown; original: string } | { ok: false; error: string; original: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, original: text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "parse", original: text };
  }
}

export function readDelimited(text: string, delimiter: "," | "\t"): { encodingNote: string; rows: string[][] } {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0).map((line) => splitRow(line, delimiter));
  return { encodingNote: "utf-8", rows };
}

export function chunkText(text: string, source: SourceRef, size = 1200, overlap = 150): { text: string; source: SourceRef }[] {
  if (!text) return [];
  const chunks: { text: string; source: SourceRef }[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + size);
    chunks.push({ text: text.slice(start, end), source: { ...source, lineStart: start, lineEnd: end } });
    if (end === text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

function splitRow(line: string, delimiter: string): string[] {
  return line.split(delimiter);
}

export function reportPdfPages(
  pages: { page: number; text: string }[],
  ocr: (page: number) => { ok: true; text: string } | { ok: false; reason: string },
): { pages: { page: number; text: string; status: "text" | "ocr" | "failed"; reason?: string }[] } {
  return {
    pages: pages.map((page) => {
      if (page.text.trim()) return { page: page.page, text: page.text, status: "text" as const };
      const result = ocr(page.page);
      if (result.ok && result.text.trim()) return { page: page.page, text: result.text, status: "ocr" as const };
      return { page: page.page, text: "", status: "failed" as const, reason: result.ok ? "empty_ocr" : result.reason };
    }),
  };
}

export type IndexIdentity = {
  userId: string;
  modelId: string;
  dimensions: number;
  processingVersion: string;
};

export function assertSameIndex(stored: IndexIdentity, query: IndexIdentity): { ok: true } | { ok: false; code: "cross_user" | "index_mismatch" } {
  if (stored.userId !== query.userId) return { ok: false, code: "cross_user" };
  if (stored.modelId !== query.modelId || stored.dimensions !== query.dimensions || stored.processingVersion !== query.processingVersion) {
    return { ok: false, code: "index_mismatch" };
  }
  return { ok: true };
}

export function orderByRerank<T extends { id: string }>(candidates: readonly T[], scores: { id: string; score: number }[]): T[] {
  const rank = new Map(scores.map((item) => [item.id, item.score]));
  return [...candidates].sort((a, b) => (rank.get(b.id) ?? Number.NEGATIVE_INFINITY) - (rank.get(a.id) ?? Number.NEGATIVE_INFINITY));
}
