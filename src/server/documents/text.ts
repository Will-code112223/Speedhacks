/** Best-effort text for text-like evidence. PDFs/images return null here; live mode sends them to the LLM. */
export const TEXT_MIME_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const MAX_TEXT_CHARS = 100_000;

export function textFromDocument(mimeType: string, bytes: Uint8Array): string | null {
  if (!TEXT_MIME_TYPES.has(mimeType)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}
