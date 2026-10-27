export type TextBlock =
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string };

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPE[char] ?? char);
}

export function toTextBlocks(markdown: string): TextBlock[] {
  const source = markdown.replace(/\r\n/g, "\n");
  const blocks: TextBlock[] = [];
  const fence = /```([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of source.matchAll(fence)) {
    const index = match.index ?? 0;
    pushParagraphs(blocks, source.slice(cursor, index));
    blocks.push({ type: "code", text: match[1] ?? "" });
    cursor = index + match[0].length;
  }
  pushParagraphs(blocks, source.slice(cursor));
  return blocks;
}

function pushParagraphs(blocks: TextBlock[], chunk: string): void {
  const parts = chunk.split(/\n{2,}/);
  for (const part of parts) {
    const text = part.trim();
    if (text) blocks.push({ type: "paragraph", text });
  }
}
