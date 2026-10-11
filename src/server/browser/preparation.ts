import { chromium, type Browser } from "playwright";

export interface PreparationField { key: string; label: string; value: string }

const scaffold = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; form-action 'none'; base-uri 'none'">
<title>Recourse · Insurance preparation</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f5f3;color:#202725;font:16px Arial,sans-serif}
header{position:sticky;top:0;z-index:10;background:#202725;color:white;padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
header strong{font-size:24px}header span{font-size:14px;color:#d7dfd8}main{max-width:1050px;margin:22px auto;padding:0 24px}
.eyebrow{color:#657369;font-size:12px;text-transform:uppercase;letter-spacing:2px}h1{font-size:29px;margin:8px 0}p{color:#56655c;line-height:1.5}
.notice{padding:12px 16px;border:1px solid #c7d4c9;background:#eaf1e9;border-radius:8px;margin:16px 0}
.card{background:white;border:1px solid #d9dfda;border-radius:12px;padding:20px;margin:16px 0}
#fields{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px}label{display:block;font-size:13px;color:#53625a;margin-bottom:6px}
textarea{resize:none;font:15px Arial,sans-serif;color:#202725;border:1px solid #ccd4ce;border-radius:6px;padding:10px;width:100%;min-height:48px;background:#fafcf9}
textarea:focus{outline:2px solid #53785e}.wide{grid-column:1/-1}h2{font-size:18px;margin:0 0 12px}
#files{padding:0;list-style:none}#files li{border-top:1px solid #e5e9e5;padding:12px 0;display:flex;gap:14px;align-items:center}
#files img{width:150px;height:90px;object-fit:contain;background:#f3f5f3;border-radius:5px}.file-detail{color:#657369;font-size:12px;margin-top:5px}
button{background:#233a2c;color:white;border:0;border-radius:7px;font:600 16px Arial,sans-serif;padding:13px 22px;cursor:pointer}
#status{position:sticky;bottom:0;background:#f4f5f3;border-top:1px solid #d9dfda;padding:15px 24px;margin:20px -24px 0;font-weight:600}
#review{display:none}#review h2{color:#254f32}input[type=file]{font:14px Arial,sans-serif;max-width:100%}
</style></head><body><header><strong>Recourse</strong><span>Local preparation workspace</span></header><main>
<div class="eyebrow">Insurance packet</div><h1>Prepare your claim information</h1>
<div class="notice">Recourse preparation form · This is not the AAA website. Nothing is sent to an insurer.</div>
<section class="card"><h2>Reviewed case details</h2><div id="fields"></div></section>
<section class="card"><h2>Supporting documents</h2><label for="attachments">Attach the case evidence</label><input id="attachments" type="file" multiple><ul id="files"></ul></section>
<button id="review-button" type="button">Review packet</button>
<section id="review" class="card"><h2>Ready for review — not submitted</h2><p>Your entered details and selected files are prepared locally. Review them in Recourse before deciding how to contact your insurer.</p></section>
<div id="status" role="status">Opening preparation form…</div></main></body></html>`;

export async function fillPreparation(input: {
  fields: PreparationField[];
  artifacts: Array<{ name: string; mimeType: string; bytes: Buffer }>;
  signal: AbortSignal;
  onFrame(frame: Buffer, message: string): void;
}): Promise<void> {
  if (input.signal.aborted) throw new Error("PREPARATION_CANCELLED");
  if (input.fields.length > 40 || input.fields.some(field => !field.key || !field.label ||
    field.key.length > 120 || field.label.length > 200 || field.value.length > 10_000) ||
    new Set(input.fields.map(field => field.key)).size !== input.fields.length) throw new Error("INVALID_PREPARATION_FIELDS");
  if (input.artifacts.length > 20 || input.artifacts.some(file => !file.name || /[\\/\0]/.test(file.name) ||
    file.name.length > 255 || file.bytes.length > 20 * 1024 * 1024) ||
    input.artifacts.reduce((total, file) => total + file.bytes.length, 0) > 50 * 1024 * 1024) throw new Error("INVALID_PREPARATION_ARTIFACTS");
  let browser: Browser | undefined;
  const stop = () => { void browser?.close().catch(() => undefined); };
  const check = () => { if (input.signal.aborted) throw new Error("PREPARATION_CANCELLED"); };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    browser = await chromium.launch({ headless: true, timeout: 20_000,
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    check();
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: "block", acceptDownloads: false, permissions: [] });
    context.setDefaultTimeout(5_000);
    await context.route("**/*", route => route.abort("blockedbyclient"));
    await context.routeWebSocket("**/*", socket => socket.close());
    const page = await context.newPage();
    context.on("page", popup => { if (popup !== page) void popup.close(); });
    page.on("dialog", dialog => { void dialog.dismiss(); });
    await page.setContent(scaffold, { waitUntil: "domcontentloaded" });
    await page.evaluate(fields => {
      const container = document.getElementById("fields")!;
      fields.forEach((field, index) => {
        const row = document.createElement("div");
        if (field.value.length > 120) row.className = "wide";
        const label = document.createElement("label"); label.htmlFor = `field-${index}`; label.textContent = field.label;
        const editor = document.createElement("textarea"); editor.id = label.htmlFor; editor.name = field.key;
        editor.rows = field.value.length > 120 ? 3 : field.value.length > 65 ? 2 : 1;
        row.append(label, editor); container.append(row);
      });
      document.getElementById("review-button")!.addEventListener("click", () => {
        document.querySelectorAll<HTMLTextAreaElement>("textarea").forEach(field => { field.readOnly = true; });
        (document.getElementById("attachments") as HTMLInputElement).disabled = true;
        document.getElementById("review-button")!.style.display = "none";
        document.getElementById("review")!.style.display = "block";
        document.getElementById("review")!.scrollIntoView({ block: "center" });
      });
    }, input.fields);
    const frame = async (message: string) => {
      check();
      await page.locator("#status").evaluate((node, text) => { node.textContent = text; }, message);
      const image = await page.screenshot({ type: "jpeg", quality: 75 });
      check(); input.onFrame(image, message);
    };
    await frame("Preparing the reviewed case details");
    for (let index = 0; index < input.fields.length; index++) {
      check();
      const field = input.fields[index]!;
      await page.locator(`#field-${index}`).fill(field.value);
      await page.waitForTimeout(350);
      await frame(`Filled ${field.label}`);
    }
    check();
    if (input.artifacts.length) {
      await page.locator("#attachments").setInputFiles(input.artifacts.map(file => ({ name: file.name, mimeType: file.mimeType, buffer: file.bytes })));
      await page.evaluate(async () => {
        const files = (document.getElementById("attachments") as HTMLInputElement).files;
        for (const file of Array.from(files ?? [])) {
          const row = document.createElement("li");
          if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
            const image = document.createElement("img"); image.alt = `Attached evidence: ${file.name}`;
            image.src = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("ATTACHMENT_PREVIEW_FAILED")); reader.readAsDataURL(file);
            }); row.append(image);
          }
          const details = document.createElement("div"); details.textContent = file.name;
          const metadata = document.createElement("div"); metadata.className = "file-detail"; metadata.textContent = `${file.size.toLocaleString()} bytes · Attached locally`;
          details.append(metadata); row.append(details); document.getElementById("files")!.append(row);
        }
      });
      await page.locator("#attachments").scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
      await frame(`Attached ${input.artifacts.length} case document${input.artifacts.length === 1 ? "" : "s"} locally`);
    }
    check();
    await page.locator("#review-button").click();
    await page.waitForTimeout(350);
    await frame("Ready for review — not submitted");
  } catch (error) {
    if (input.signal.aborted) throw new Error("PREPARATION_CANCELLED");
    throw error;
  } finally {
    input.signal.removeEventListener("abort", stop);
    await browser?.close().catch(() => undefined);
  }
}
