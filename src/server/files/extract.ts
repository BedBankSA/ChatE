import { decodeText, type DetectedKind } from "@/domain/files/content";

/**
 * Extraction results are persisted once, at upload time, in documents/chunks
 * with processing_version = "v1". Comparison creation only re-reads those rows:
 * every model in one comparison receives exactly the same evidence text.
 */
export const PROCESSING_VERSION = "v1";
export const MAX_STORED_TEXT_CHARS = 400_000;
const TRUNCATION_MARKER = "\n…[اقتُطع النص]";

export type ExtractionPart = {
  label: string;
  status: "read" | "skipped" | "failed";
  reason?: string;
};

export type ExtractionFailure = { label: string; reason: string };

export type ExtractionResult = {
  status: "completed" | "failed";
  text: string;
  textExtracted: boolean;
  failedParts: ExtractionFailure[];
  parts: ExtractionPart[];
  errorCode: string | null;
  pages: number | null;
};

const EMPTY: Omit<ExtractionResult, "status" | "parts" | "errorCode" | "failedParts"> = {
  text: "",
  textExtracted: false,
  pages: null,
};

/**
 * Text extraction per detected type:
 * - PDF -> unpdf text layer (no OCR: scanned pages produce no text and are
 *   reported as a failed part, they are never silently claimed as read)
 * - DOCX -> mammoth raw text
 * - JSON/CSV/TSV/Markdown/plain text -> decodeText (UTF-8 or UTF-16LE)
 * - images -> completed with no text (the model gets the image natively)
 * - everything else -> failed with an explicit unsupported/failure part
 */
export async function extractTextForFile(input: {
  bytes: Uint8Array;
  detectedType: DetectedKind;
  name: string;
  maxChars?: number;
}): Promise<ExtractionResult> {
  const maxChars = input.maxChars ?? MAX_STORED_TEXT_CHARS;
  switch (input.detectedType) {
    case "pdf":
      return extractPdf(input.bytes, maxChars);
    case "docx":
      return extractDocx(input.bytes, maxChars);
    case "json":
    case "csv":
    case "tsv":
    case "markdown":
    case "text":
      return extractPlainText(input.bytes, maxChars);
    case "png":
    case "jpeg":
    case "gif":
    case "webp":
      return {
        status: "completed",
        ...EMPTY,
        parts: [{ label: "image", status: "skipped", reason: "image_no_text" }],
        failedParts: [],
        errorCode: null,
      };
    default:
      return unsupported(input.detectedType);
  }
}

function extractPlainText(bytes: Uint8Array, maxChars: number): ExtractionResult {
  const decoded = decodeText(bytes);
  if (decoded.encoding === "failed") {
    return {
      status: "failed",
      ...EMPTY,
      parts: [{ label: "text", status: "failed", reason: "decode_failed" }],
      failedParts: [{ label: "text", reason: "decode_failed" }],
      errorCode: "DECODE",
    };
  }
  const text = truncateText(decoded.text, maxChars);
  return {
    status: "completed",
    text,
    textExtracted: text.trim().length > 0,
    parts: [{ label: decoded.encoding, status: "read" }],
    failedParts: [],
    errorCode: null,
    pages: null,
  };
}

async function extractPdf(bytes: Uint8Array, maxChars: number): Promise<ExtractionResult> {
  try {
    const { extractText } = await import("unpdf");
    const parsed = await extractText(new Uint8Array(bytes), { mergePages: true });
    const text = truncateText(parsed.text, maxChars);
    return {
      status: "completed",
      text,
      textExtracted: text.trim().length > 0,
      parts: text.trim().length > 0
        ? [{ label: "pdf", status: "read" }]
        : [{ label: "pdf", status: "failed", reason: "no_text_layer" }],
      failedParts: text.trim().length > 0 ? [] : [{ label: "pdf", reason: "no_text_layer" }],
      errorCode: null,
      pages: parsed.totalPages,
    };
  } catch {
    return {
      status: "failed",
      ...EMPTY,
      parts: [{ label: "pdf", status: "failed", reason: "extract_failed" }],
      failedParts: [{ label: "pdf", reason: "extract_failed" }],
      errorCode: "EXTRACT_FAILED",
    };
  }
}

async function extractDocx(bytes: Uint8Array, maxChars: number): Promise<ExtractionResult> {
  try {
    const mammoth = (await import("mammoth")).default;
    const parsed = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    const text = truncateText(parsed.value, maxChars);
    return {
      status: "completed",
      text,
      textExtracted: text.trim().length > 0,
      parts: [{ label: "docx", status: "read" }],
      failedParts: [],
      errorCode: null,
      pages: null,
    };
  } catch {
    return {
      status: "failed",
      ...EMPTY,
      parts: [{ label: "docx", status: "failed", reason: "extract_failed" }],
      failedParts: [{ label: "docx", reason: "extract_failed" }],
      errorCode: "EXTRACT_FAILED",
    };
  }
}

function unsupported(detectedType: string): ExtractionResult {
  return {
    status: "failed",
    ...EMPTY,
    parts: [{ label: detectedType, status: "failed", reason: "unsupported_type" }],
    failedParts: [{ label: detectedType, reason: "unsupported_type" }],
    errorCode: "UNSUPPORTED_TYPE",
  };
}

export function truncateText(text: string, maxChars = MAX_STORED_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}
