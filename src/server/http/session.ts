import { randomBytes } from "node:crypto";

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

export function sessionCookieHeader(session: string): string {
  // Secure is omitted so the local http://localhost demo works; add it behind TLS.
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}

/** Existing session or a fresh one plus the Set-Cookie header to attach. */
export function ensureSession(request: Request): { session: string; setCookie: string | null } {
  const existing = readSession(request);
  if (existing) return { session: existing, setCookie: null };
  const session = newSession();
  return { session, setCookie: sessionCookieHeader(session) };
}
