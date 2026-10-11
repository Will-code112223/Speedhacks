import { getCaseService } from "@/server/cases/composition";
import { CURRENCY, E164, isIsoDate, isValidAmountMinor } from "@/server/cases/facts";
import type { UploadInput } from "@/server/documents/storage";
import { CALL_PLAN_LIMITS } from "@/contracts/voice";
import { ApiHttpError, badRequest } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { ensureSession, requireAccess } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The call plan carries the summary as `reason`; a longer one could never be approved. */
const SUMMARY_MAX_CHARS = CALL_PLAN_LIMITS.reasonChars;
/** 5 files x 10 MB plus 1 MB for the summary, fields and multipart framing. */
const MAX_UPLOAD_BODY_BYTES = 5 * 10 * 1024 * 1024 + 1024 * 1024;

function optionalText(form: FormData, key: string, max = 200): string | null {
  const v = form.get(key);
  if (v === null) return null;
  if (typeof v !== "string") throw badRequest(`${key} must be text`, [key]);
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/** POST /api/cases — multipart/form-data: summary + repeated "files" + optional fact fields. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    requireAccess(request);
    // Reject an oversized body before buffering it: 5 files x 10 MB plus 1 MB for the form.
    const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BODY_BYTES) {
      throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", `Upload exceeds ${MAX_UPLOAD_BODY_BYTES} bytes`, ["files"]);
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("Body must be multipart/form-data");
    }
    const summaryRaw = form.get("summary");
    if (summaryRaw !== null && typeof summaryRaw !== "string") throw badRequest("summary must be text", ["summary"]);
    const summary = summaryRaw ?? "";
    if (summary.trim().length > SUMMARY_MAX_CHARS) {
      throw new ApiHttpError(422, "SUMMARY_TOO_LONG", `summary must be at most ${SUMMARY_MAX_CHARS} characters`, ["summary"]);
    }

    const files: UploadInput[] = [];
    for (const entry of form.getAll("files")) {
      if (typeof entry === "string") throw badRequest("files must be file parts", ["files"]);
      files.push({ name: entry.name, mimeType: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) });
    }

    const invalid: string[] = [];
    const customerName = optionalText(form, "customerName");
    const customerEmail = optionalText(form, "customerEmail");
    const merchantName = optionalText(form, "merchantName");
    const supportPhone = optionalText(form, "supportPhone", 64);
    if (supportPhone !== null && !E164.test(supportPhone)) invalid.push("supportPhone");
    if (customerEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) invalid.push("customerEmail");
    const currency = optionalText(form, "currency", 16)?.toUpperCase() ?? null;
    if (currency !== null && !CURRENCY.test(currency)) invalid.push("currency");
    const amountRaw = optionalText(form, "amountMinor", 32);
    let amountMinor: number | null = null;
    if (amountRaw !== null) {
      amountMinor = /^\d{1,15}$/.test(amountRaw) ? Number.parseInt(amountRaw, 10) : Number.NaN;
      if (!isValidAmountMinor(amountMinor)) invalid.push("amountMinor");
    }
    // V1.2 insurance facts (optional): policyNumber, incidentDate (YYYY-MM-DD), lossDescription, claimType.
    const policyNumber = optionalText(form, "policyNumber", 64);
    const incidentDate = optionalText(form, "incidentDate", 10);
    if (incidentDate !== null && !isIsoDate(incidentDate)) invalid.push("incidentDate");
    const lossDescription = optionalText(form, "lossDescription", 2000);
    const claimType = optionalText(form, "claimType", 120);
    if (invalid.length > 0) throw badRequest(`Invalid fields: ${invalid.join(", ")}`, invalid);

    const { session, setCookie } = ensureSession(request);
    const created = await getCaseService().createCase(session, {
      summary,
      files,
      fields: { customerName, customerEmail, merchantName, supportPhone, amountMinor, currency, policyNumber, incidentDate, lossDescription, claimType },
    });
    return json({ case: created }, 201, setCookie ? { "set-cookie": setCookie } : undefined);
  });
}
