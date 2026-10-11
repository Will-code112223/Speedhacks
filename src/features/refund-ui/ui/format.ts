/**
 * Formatting and parsing helpers shared by every view. One fixed locale keeps
 * what we display and what we parse back in agreement.
 */

const LOCALE = "en-US";

// ---------------------------------------------------------------------------
// Money (integer minor units in the contract)
// ---------------------------------------------------------------------------

export function currencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Formats integer minor units, for example 120000 USD as "$1,200.00". */
export function formatMoney(amountMinor: number | null, currency: string): string | null {
  if (amountMinor === null || !Number.isFinite(amountMinor)) return null;
  const digits = currencyFractionDigits(currency);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency}`;
  }
}

/** The editable text for an amount, without the currency symbol: "1,200.00". */
export function amountInputValue(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return "";
  const digits = currencyFractionDigits(currency);
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

export type ParsedAmount = { ok: true; minor: number | null } | { ok: false; error: string };

/**
 * Parses what a person types into integer minor units. Accepts "1200",
 * "1,200", "$1,200.50". Empty input is a missing value, not zero.
 */
export function parseAmountToMinor(input: string, currency: string): ParsedAmount {
  const cleaned = input.replace(/[\s,]/g, "").replace(/^[^\d.-]+/, "");
  if (cleaned === "") return { ok: true, minor: null };
  if (cleaned.startsWith("-")) return { ok: false, error: "Enter an amount above zero." };
  const digits = currencyFractionDigits(currency);
  const pattern = digits > 0 ? new RegExp(`^\\d+(\\.\\d{0,${digits}})?$`) : /^\d+$/;
  if (!pattern.test(cleaned)) {
    return {
      ok: false,
      error: digits > 0 ? `Enter an amount like 1,200.00, with at most ${digits} decimals.` : "Enter a whole amount like 1200.",
    };
  }
  const [whole = "0", fraction = ""] = cleaned.split(".");
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  // The server caps amounts at 10^12 minor units.
  if (!Number.isSafeInteger(minor) || minor > 1_000_000_000_000) return { ok: false, error: "That amount is too large." };
  if (minor <= 0) return { ok: false, error: "Enter an amount above zero." };
  return { ok: true, minor };
}

// ---------------------------------------------------------------------------
// Phone numbers (the contract requires E.164 for the support number)
// ---------------------------------------------------------------------------

/**
 * Normalizes a typed phone number to E.164. Ten digits are read as a North
 * American number. Returns null when the input cannot be a full number.
 */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (/[^\d\s()+.\-]/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export const PHONE_HINT = "Include the area code, for example +1 800 555 0199.";

/** "+18005550199" as "+1 800 555 0199"; other numbers are left as stored. */
export function formatPhone(phone: string | null): string | null {
  if (!phone) return null;
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+1 ${match[1]} ${match[2]} ${match[3]}` : phone;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** 75 as "1:15", 3725 as "1:02:05". Negative input clamps to zero. */
export function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Seconds between two instants, or from `startIso` until `nowMs`. */
export function secondsBetween(startIso: string | null, endIso: string | null, nowMs: number): number {
  if (!startIso) return 0;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return 0;
  const end = endIso ? Date.parse(endIso) : nowMs;
  return Math.max(0, Math.floor(((Number.isNaN(end) ? nowMs : end) - start) / 1000));
}

const clockFormat = new Intl.DateTimeFormat(LOCALE, { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : clockFormat.format(date);
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateTimeFormat.format(date);
}

// ---------------------------------------------------------------------------
// Words from the contract
// ---------------------------------------------------------------------------

/**
 * Contract status words are shown as written, only made readable:
 * "dispatch_unknown" becomes "Dispatch unknown". Never reworded.
 */
export function statusWord(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileKindLabel(name: string, mimeType: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (mimeType === "application/pdf" || ext === "pdf") return "PDF";
  if (mimeType === "image/png" || ext === "png") return "PNG";
  if (mimeType === "image/jpeg" || ext === "jpg" || ext === "jpeg") return "JPG";
  if (mimeType === "image/heic" || mimeType === "image/heif" || ext === "heic" || ext === "heif") return "HEIC";
  if (mimeType === "text/plain" || ext === "txt") return "Text";
  return ext ? ext.toUpperCase() : "File";
}
