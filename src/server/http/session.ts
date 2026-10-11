import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loadConfig } from "@/server/config";
import { ApiHttpError } from "@/server/http/errors";

/**
 * Local-demo access control: a random, httpOnly session cookie binds cases to
 * the browser that created them. Routes look cases up by (id, owner) and
 * answer 404 for anything the session does not own.
 */
export const SESSION_COOKIE = "refund_session";
const SESSION_PATTERN = /^[a-f0-9]{48}$/;

export function readSession(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === SESSION_COOKIE) {
      const value = rest.join("=").trim();
      return SESSION_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

export function newSession(): string {
  return randomBytes(24).toString("hex");
}

/** Secure only in production, so the local http://localhost demo keeps working. */
function secureAttr(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

export function sessionCookieHeader(session: string): string {
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${secureAttr()}`;
}

/** Existing session or a fresh one plus the Set-Cookie header to attach. */
export function ensureSession(request: Request): { session: string; setCookie: string | null } {
  const existing = readSession(request);
  if (existing) return { session: existing, setCookie: null };
  const session = newSession();
  return { session, setCookie: sessionCookieHeader(session) };
}

// ---------------------------------------------------------------------------
// Optional shared access code (APP_ACCESS_CODE). A hosted deployment sets it so
// that nobody who merely reaches the server can create cases or place calls.
// ---------------------------------------------------------------------------
export const ACCESS_COOKIE = "recourse_access";

/** Cookie value: hex SHA-256 of the configured code. The code itself never leaves the server. */
export function accessToken(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === name) return rest.join("=").trim();
  }
  return null;
}

function equalHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The configured code, or null when the gate is off. Read per request so tests and restarts see changes. */
export function configuredAccessCode(env: Record<string, string | undefined> = process.env): string | null {
  return loadConfig(env).accessCode;
}

/**
 * Called first in every gated route handler. No-op when APP_ACCESS_CODE is unset;
 * otherwise a missing or wrong recourse_access cookie is a 401 ACCESS_REQUIRED.
 */
export function requireAccess(request: Request, code: string | null = configuredAccessCode()): void {
  if (code === null) return;
  const presented = readCookie(request, ACCESS_COOKIE);
  if (presented && equalHex(presented, accessToken(code))) return;
  throw new ApiHttpError(401, "ACCESS_REQUIRED", "Enter the access code to use this server");
}

/** True when `candidate` matches the configured code (compared by hash, constant time). */
export function accessCodeMatches(candidate: string, code: string): boolean {
  return equalHex(accessToken(candidate), accessToken(code));
}

export function accessCookieHeader(code: string): string {
  return `${ACCESS_COOKIE}=${accessToken(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secureAttr()}`;
}
