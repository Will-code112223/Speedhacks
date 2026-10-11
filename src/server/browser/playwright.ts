import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from "playwright";
import type { BrowserPort, Observation, PlannedStep } from "./types";
import { BrowserPageChangedError } from "./types";
import { pinnedRequest, scopedUrl } from "./security";


export async function launchBrowser(input: { startUrl: string; hosts: string[]; headless: boolean; executablePath?: string;
  signal: AbortSignal; onLost: () => void; onBlocked: (host?: string) => void }): Promise<BrowserPort> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let closed = false;
  let allowWrites = false;
  let page: Page;
  let targets = new Map<string, ElementHandle<Element>>();
  let targetUrl = "";
  const close = async () => { closed = true; allowWrites = false; await browser?.close().catch(() => undefined); };
  input.signal.addEventListener("abort", () => { void close(); }, { once: true });
  try {
    if (input.signal.aborted) throw new Error("CANCELLED");
    browser = await chromium.launch({ headless: input.headless, executablePath: input.executablePath, timeout: 20_000,
      // Direct browser egress is a dead proxy. All allowed HTTPS is fulfilled by pinnedRequest.
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
      args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    if (input.signal.aborted) { await close(); throw new Error("CANCELLED"); }
    browser.on("disconnected", () => { if (!closed) input.onLost(); });
    context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: "block", acceptDownloads: false,
      permissions: [], ignoreHTTPSErrors: false });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(20_000);
    await context.routeWebSocket("**/*", socket => { socket.close(); input.onBlocked(); });
    await context.route("**/*", async route => {
      try {
        if (closed || input.signal.aborted) return await route.abort();
        const req = route.request();
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method()) && !allowWrites) throw new Error("MUTATION_NOT_APPROVED");
        const body = req.postDataBuffer();
        if (body && body.length > 12 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
        const response = await pinnedRequest({ url: req.url(), hosts: input.hosts, method: req.method(), headers: await req.allHeaders(), body, signal: input.signal });
        if (closed || input.signal.aborted) return await route.abort().catch(() => undefined);
        await route.fulfill(response);
      } catch { let host: string | undefined; try { host = new URL(route.request().url()).hostname; } catch {} input.onBlocked(host); await route.abort("blockedbyclient").catch(() => undefined); }
    });
    page = await context.newPage();
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) { for (const handle of targets.values()) void handle.dispose().catch(() => undefined); targets.clear(); targetUrl = ""; } });
    context.on("page", popup => { if (popup !== page) { input.onBlocked(); void popup.close(); } });
    page.on("dialog", dialog => { void dialog.dismiss(); });
    page.on("download", download => { void download.cancel(); input.onBlocked(); });
    await page.goto(scopedUrl(input.startUrl, input.hosts).href, { waitUntil: "domcontentloaded" });
    if (input.signal.aborted) { await close(); throw new Error("CANCELLED"); }
  } catch (error) { await close(); throw error; }

  const credentialsVisible = async () => {
    for (const frame of page.frames()) {
      if (await frame.evaluate(() => [...document.querySelectorAll<HTMLInputElement>("input")].some(e =>
        e.getBoundingClientRect().width > 0 && (e.type === "password" || /one-time-code|current-password|new-password/.test(e.autocomplete) ||
        /(?:otp|passcode|verification.?code|security.?code|mfa|2fa)/i.test(`${e.name} ${e.id} ${e.placeholder} ${e.getAttribute("aria-label") ?? ""}`))))) return true;
    }
    return false;
  };
  const observe = async (): Promise<Observation> => {
    allowWrites = false;
    scopedUrl(page.url(), input.hosts);
    if (await credentialsVisible()) return { id: randomUUID(), url: page.url(), title: "Authentication required", text: "Authentication required. Planning and capture paused.",
      elements: [], fingerprint: "credentials-visible", hasPassword: true, hasFrames: page.frames().length > 1 };
    if (targetUrl !== page.url()) { for (const handle of targets.values()) await handle.dispose().catch(() => undefined); targets.clear(); }
    const previous = [...targets.entries()];
    const allHandles = await page.locator("a[href],button,input,textarea,select,[role=button],[contenteditable=true]").elementHandles() as ElementHandle<Element>[];
    const handles = allHandles.slice(0, 500);
    for (const handle of allHandles.slice(500)) await handle.dispose();
    const data = await page.evaluate(({ nodes, old }) => {
      const observed = nodes.map((element, index) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > innerHeight || getComputedStyle(element).visibility === "hidden") return null;
        const field = element as HTMLInputElement;
        const label = (field.labels?.[0]?.textContent || element.getAttribute("aria-label") || (element as HTMLElement).innerText || field.placeholder || element.getAttribute("name") || element.tagName).replace(/\s+/g, " ").trim().slice(0, 180);
        return { index, previous: old.indexOf(element), tag: element.tagName.toLowerCase(), type: field.type ?? "", label,
          href: element instanceof HTMLAnchorElement ? element.href : null, disabled: Boolean(field.disabled),
          options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 100).map(o => o.value) : [],
          privateState: { value: field.value ?? "", html: element.outerHTML.slice(0, 8000), bounds: [rect.x, rect.y, rect.width, rect.height] },
        };
      }).filter(e => e !== null).slice(0, 100);
      const forms = [...document.forms].map(f => ({ action: f.action, method: f.method,
        fields: [...f.elements].map(e => { const field = e as HTMLInputElement; return { name: field.name, type: field.type, value: field.type === "password" ? "[redacted]" : field.value }; }) }));
      return { title: document.title.slice(0, 300), text: (document.body?.innerText ?? "").slice(0, 12_000), elements: observed,
        privateState: JSON.stringify({ forms }), hasFrames: document.querySelectorAll("iframe,frame").length > 0 };
    }, { nodes: handles, old: previous.map(([, handle]) => handle) });
    const next = new Map<string, ElementHandle<Element>>();
    const elements = data.elements.map(({ index, previous: oldIndex, privateState: _private, ...element }) => {
      const id = previous[oldIndex]?.[0] ?? randomUUID(); next.set(id, handles[index]!); return { id, ...element };
    });
    // IDs are keyed to actual ElementHandles in Node, not a page-writable global or selector.
    for (const handle of targets.values()) await handle.dispose().catch(() => undefined);
    const used = new Set(next.values()); for (const handle of handles) if (!used.has(handle)) await handle.dispose();
    targets = next; targetUrl = page.url();
    const fingerprint = createHash("sha256").update(JSON.stringify({ url: page.url(), title: data.title, text: data.text,
      elements: elements.map((e, i) => ({ ...e, state: data.elements[i]?.privateState })), forms: data.privateState })).digest("hex");
    return { id: randomUUID(), url: page.url(), title: data.title, text: data.text, elements, fingerprint, hasPassword: false, hasFrames: data.hasFrames };
  };
  return {
    observe,
    screenshot: async () => {
      if (await credentialsVisible()) throw new Error("CREDENTIAL_CAPTURE_PAUSED");
      return page.screenshot({ type: "jpeg", quality: 65, timeout: 5000, mask: page.frames().map(frame => frame.locator("input")) });
    },
    async execute(step: PlannedStep, artifact, expectedFingerprint) {
      if (input.signal.aborted || closed) throw new Error("BROWSER_CLOSED");
      if (step.kind === "inspect") return;
      if (step.kind === "scroll") { await page.mouse.wheel(0, step.value === "up" ? -600 : 600); return; }
      // Recheck after service-side screenshot and case reads, immediately before
      // opening the write window. Never act on a proposal whose page changed.
      if (!expectedFingerprint) throw new Error("ACTION_APPROVAL_REQUIRED");
      const current = await observe();
      if (current.hasPassword || current.fingerprint !== expectedFingerprint) throw new BrowserPageChangedError();
      if (input.signal.aborted || closed) throw new Error("BROWSER_CLOSED");
      allowWrites = true;
      try {
        if (step.kind === "navigate") await page.goto(scopedUrl(step.value, input.hosts).href, { waitUntil: "domcontentloaded" });
        else {
          const element = targets.get(step.elementId ?? "");
          if (!element) throw new Error("ELEMENT_GONE");
          {
            if (step.kind === "click") await element.click({ timeout: 10_000 });
            else if (step.kind === "fill") await element.fill(step.value ?? "", { timeout: 10_000 });
            else if (step.kind === "select") await element.selectOption(step.value ?? "", { timeout: 10_000 });
            else if (step.kind === "upload" && artifact) await element.setInputFiles({ name: artifact.name, mimeType: artifact.mimeType, buffer: artifact.bytes }, { timeout: 10_000 });
            else throw new Error("ACTION_UNSUPPORTED");
          }
        }
        // Let immediate form/network effects reach the page before producing the next observation.
        await page.waitForTimeout(500);
        scopedUrl(page.url(), input.hosts);
      } finally { allowWrites = false; }
    },
    async loginHandoff() {
      if (input.headless) throw new Error("HEADED_BROWSER_REQUIRED");
      allowWrites = true;
      await page.bringToFront();
    },
    close,
  };
}
