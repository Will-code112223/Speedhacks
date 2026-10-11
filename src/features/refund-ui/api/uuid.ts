/** Matches the UUIDs the server accepts for requestId and authorizationId. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 version 4 UUID. `crypto.randomUUID` only exists on secure origins,
 * so a demo opened over a LAN IP falls back to `crypto.getRandomValues`.
 */
export function randomUuid(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues !== "function") {
    throw new Error("No secure random source is available to create an id.");
  }
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}

/** Formats 32 hex digits as 8-4-4-4-12. */
export function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
