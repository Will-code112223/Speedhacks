import type { BrowserApi } from "./client";

export interface BrowserFrameState {
  frame: { url: string; receivedAt: string } | null;
  error: string | null;
}
interface FrameOptions {
  runId: string;
  api: Pick<BrowserApi, "frame">;
  onChange: (state: BrowserFrameState) => void;
  urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  now?: () => Date;
  poll?: boolean;
}

/** Start only while visible. One request at a time; failure removes the old frame. */
export function startBrowserFrames({ runId, api, onChange, urls = URL, now = () => new Date(), poll = true }: FrameOptions) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentUrl: string | null = null;
  function clear(error: string | null) {
    if (currentUrl) urls.revokeObjectURL(currentUrl);
    currentUrl = null;
    onChange({ frame: null, error });
  }
  async function load() {
    try {
      const blob = await api.frame(runId, abort.signal);
      if (abort.signal.aborted) return;
      const url = urls.createObjectURL(blob);
      const old = currentUrl;
      currentUrl = url;
      onChange({ frame: { url, receivedAt: now().toISOString() }, error: null });
      if (old) urls.revokeObjectURL(old);
    } catch (error) {
      if (!abort.signal.aborted) clear(error instanceof Error ? error.message : "Browser view unavailable.");
    } finally {
      if (!abort.signal.aborted && poll) timer = setTimeout(load, 1000);
    }
  }
  clear(null);
  void load();
  return {
    invalidate() { if (!abort.signal.aborted) clear("Browser image could not be displayed."); },
    stop() { abort.abort(); clearTimeout(timer); clear(null); },
  };
}
