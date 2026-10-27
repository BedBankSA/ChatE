export type DetectedKind =
  | "pdf"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "zip"
  | "docx"
  | "xlsx"
  | "ole"
  | "wav"
  | "mp3"
  | "mp4"
  | "text"
  | "unknown";

export function detectKind(bytes: Uint8Array): DetectedKind {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "gif";
  if (bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (bytes.length > 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "wav";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "mp3";
  if (bytes.length > 12 && ascii(bytes, 4, 8) === "ftyp") return "mp4";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (looksText(bytes)) return "text";
  return "unknown";
}

export function classifyZip(names: string[]): "docx" | "xlsx" | "zip" {
  if (names.some((name) => name.startsWith("word/"))) return "docx";
  if (names.some((name) => name.startsWith("xl/"))) return "xlsx";
  return "zip";
}

function starts(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function looksText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}
