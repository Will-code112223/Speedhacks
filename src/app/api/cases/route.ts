import { getCaseService } from "@/server/cases/composition";
import { CURRENCY, E164, isValidAmountMinor } from "@/server/cases/facts";
import type { UploadInput } from "@/server/documents/storage";
import { badRequest } from "@/server/http/errors";
import { handle, json } from "@/server/http/respond";
import { ensureSession } from "@/server/http/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("Body must be multipart/form-data");
    }
    const summaryRaw = form.get("summary");
    if (summaryRaw !== null && typeof summaryRaw !== "string") throw badRequest("summary must be text", ["summary"]);
    const summary = (summaryRaw ?? "").slice(0, 5000);

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
    if (invalid.length > 0) throw badRequest(`Invalid fields: ${invalid.join(", ")}`, invalid);

    const { session, setCookie } = ensureSession(request);
    const created = await getCaseService().createCase(session, {
      summary,
      files,
      fields: { customerName, customerEmail, merchantName, supportPhone, amountMinor, currency },
    });
    return json({ case: created }, 201, setCookie ? { "set-cookie": setCookie } : undefined);
  });
}
