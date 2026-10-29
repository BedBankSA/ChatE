import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { ZIP_LIMIT_DEFAULTS, inspectZipBytes, readZipLimits } from "@/server/files/zip-safety";

function bytesOf(zip: JSZip): Promise<Uint8Array> {
  return zip.generateAsync({ type: "uint8array" });
}

describe("ZIP decompression guard", () => {
  it("accepts a normal DOCX-shaped archive", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file("word/document.xml", "<w:document>" + "نص ".repeat(100) + "</w:document>");
    expect(await inspectZipBytes(await bytesOf(zip), ZIP_LIMIT_DEFAULTS)).toEqual({ ok: true });
  });

  it("rejects too many entries before any decompression", async () => {
    const zip = new JSZip();
    for (let index = 0; index < 6; index += 1) zip.file(`f${index}.txt`, "x");
    const limits = { ...ZIP_LIMIT_DEFAULTS, maxEntries: 3 };
    expect(await inspectZipBytes(await bytesOf(zip), limits)).toEqual({ ok: false, reason: "count" });
  });

  it("rejects a path-traversal member", async () => {
    const zip = new JSZip();
    zip.file("../evil.txt", "x");
    expect(await inspectZipBytes(await bytesOf(zip), ZIP_LIMIT_DEFAULTS)).toEqual({
      ok: false,
      reason: "path_traversal",
    });
  });

  it("rejects an oversized single member and an oversized total budget", async () => {
    const zip = new JSZip();
    zip.file("big.txt", "a".repeat(2048));
    zip.file("small.txt", "b");
    const memberLimited = { ...ZIP_LIMIT_DEFAULTS, maxMemberBytes: 1024, maxUncompressedBytes: 10_000 };
    expect(await inspectZipBytes(await bytesOf(zip), memberLimited)).toEqual({ ok: false, reason: "member_size" });
    const totalLimited = { ...ZIP_LIMIT_DEFAULTS, maxMemberBytes: 10_000, maxUncompressedBytes: 2048 };
    expect(await inspectZipBytes(await bytesOf(zip), totalLimited)).toEqual({ ok: false, reason: "total_size" });
  });

  it("reads finite limits from the environment and ignores junk values", () => {
    expect(readZipLimits({})).toEqual(ZIP_LIMIT_DEFAULTS);
    expect(readZipLimits({ MAX_ZIP_ENTRIES: "5", MAX_ZIP_DEPTH: "2", MAX_ZIP_UNCOMPRESSED_BYTES: "1000" })).toMatchObject({
      maxEntries: 5,
      maxDepth: 2,
      maxUncompressedBytes: 1000,
    });
    expect(readZipLimits({ MAX_ZIP_ENTRIES: "-1", MAX_ZIP_DEPTH: "abc" })).toEqual(ZIP_LIMIT_DEFAULTS);
  });

  it("reports unreadable bytes instead of throwing", async () => {
    expect(await inspectZipBytes(Uint8Array.from([1, 2, 3]), ZIP_LIMIT_DEFAULTS)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});
