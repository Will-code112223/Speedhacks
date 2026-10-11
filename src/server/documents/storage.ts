import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiHttpError } from "@/server/http/errors";

/** Allowed evidence types. Uploads are stored under DATA_DIR/uploads/<caseId>/ with generated names. */
export const ALLOWED_MIME_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

export interface UploadInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface StoredUpload {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  sha256: string;
}

export function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isAllowedMime(mime: string): boolean {
  return Object.hasOwn(ALLOWED_MIME_TYPES, mime);
}

/** Binary types must start with their signature; a text payload labeled as PDF/PNG is rejected. */
function matchesSignature(mime: string, bytes: Uint8Array): boolean {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  switch (mime) {
    case "application/pdf":
      return startsWith([0x25, 0x50, 0x44, 0x46]); // %PDF
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp":
      return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8); // RIFF....WEBP
    default:
      return true; // text types: decoded as UTF-8, never executed
  }
}

export function validateUploads(files: UploadInput[], limits: { maxFiles: number; maxBytes: number }): void {
  if (files.length > limits.maxFiles) {
    throw new ApiHttpError(400, "BAD_REQUEST", `At most ${limits.maxFiles} files per case`, ["files"]);
  }
  for (const f of files) {
    const mime = normalizeMime(f.mimeType);
    if (!isAllowedMime(mime)) {
      throw new ApiHttpError(400, "BAD_REQUEST", `Unsupported file type "${f.mimeType}" for ${f.name}`, ["files"]);
    }
    if (!matchesSignature(mime, f.bytes)) {
      throw new ApiHttpError(400, "BAD_REQUEST", `File content does not match type "${mime}" for ${f.name}`, ["files"]);
    }
    if (f.bytes.byteLength === 0) {
      throw new ApiHttpError(400, "BAD_REQUEST", `Empty file: ${f.name}`, ["files"]);
    }
    if (f.bytes.byteLength > limits.maxBytes) {
      throw new ApiHttpError(400, "BAD_REQUEST", `File too large (>${limits.maxBytes} bytes): ${f.name}`, ["files"]);
    }
  }
}

export class UploadStore {
  constructor(private readonly dataDir: string) {}

  /** Writes the bytes under a generated filename; the original name is kept only in the database. */
  store(caseId: string, file: UploadInput): StoredUpload {
    const mime = normalizeMime(file.mimeType);
    const ext = isAllowedMime(mime) ? ALLOWED_MIME_TYPES[mime] : "";
    const id = randomUUID();
    const dir = path.join(this.dataDir, "uploads", caseId);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${id}${ext}`);
    fs.writeFileSync(storedPath, file.bytes, { mode: 0o600 });
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    return {
      id,
      name: sanitizeName(file.name),
      mimeType: mime,
      sizeBytes: file.bytes.byteLength,
      storedPath,
      sha256,
    };
  }

  read(storedPath: string): Uint8Array {
    return new Uint8Array(fs.readFileSync(storedPath));
  }
}

function sanitizeName(name: string): string {
  const base = path.basename(name || "evidence").replace(/[^\w.\- ()]/g, "_");
  return base.length > 0 ? base.slice(0, 120) : "evidence";
}
