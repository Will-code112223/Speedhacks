import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "@/server/persistence/db";

/**
 * Exercises the Next.js route handlers directly with Request objects:
 * multipart parsing, session cookie issuance and ownership, JSON errors.
 */
let dataDir: string;
let routes: {
  cases: typeof import("@/app/api/cases/route");
  byId: typeof import("@/app/api/cases/[id]/route");
  authorize: typeof import("@/app/api/cases/[id]/authorize/route");
  calls: typeof import("@/app/api/cases/[id]/calls/route");
  packet: typeof import("@/app/api/cases/[id]/packet/route");
  webhook: typeof import("@/app/api/webhooks/dial/route");
};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "refund-routes-"));
  process.env.REFUND_MODE = "simulated";
  process.env.DATA_DIR = dataDir;
  process.env.SIMULATED_QUEUED_MS = "0";
  process.env.SIMULATED_IN_PROGRESS_MS = "0";
  process.env.RECONCILE_MIN_INTERVAL_MS = "0";
  closeDatabase();
  (globalThis as { __refundService?: unknown }).__refundService = undefined;
  routes = {
    cases: await import("@/app/api/cases/route"),
    byId: await import("@/app/api/cases/[id]/route"),
    authorize: await import("@/app/api/cases/[id]/authorize/route"),
    calls: await import("@/app/api/cases/[id]/calls/route"),
    packet: await import("@/app/api/cases/[id]/packet/route"),
    webhook: await import("@/app/api/webhooks/dial/route"),
  };
});
afterAll(() => {
  closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const BASE = "http://localhost/api/cases";

describe("HTTP routes", () => {
  it("runs the whole simulated flow end to end over the route handlers", async () => {
    const form = new FormData();
    form.set("summary", "Charged twice for $49.99");
    form.set("customerName", "Sam Rivera");
    form.set("merchantName", "Acme Streaming");
    form.set("supportPhone", "+14155551000");
    form.append("files", new File([new TextEncoder().encode("Total: $49.99")], "receipt.txt", { type: "text/plain" }));
    const created = await routes.cases.POST(new Request(BASE, { method: "POST", body: form }));
    expect(created.status).toBe(201);
    const cookie = created.headers.get("set-cookie");
    expect(cookie).toMatch(/^refund_session=[a-f0-9]{48}; Path=\/; HttpOnly; SameSite=Lax/);
    const session = cookie!.split(";")[0]!;
    const { case: c } = (await created.json()) as { case: { id: string; revision: number; status: string; missingFields: string[] } };
    expect(c.status).toBe("ready_for_approval");

    // Unauthenticated / other session → 404
    expect((await routes.byId.GET(new Request(`${BASE}/${c.id}`), ctx(c.id))).status).toBe(404);
    expect(
      (await routes.byId.GET(new Request(`${BASE}/${c.id}`, { headers: { cookie: `refund_session=${"f".repeat(48)}` } }), ctx(c.id))).status,
    ).toBe(404);

    const auth = await routes.authorize.POST(
      new Request(`${BASE}/${c.id}/authorize`, {
        method: "POST",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
      ctx(c.id),
    );
    expect(auth.status).toBe(200);
    const authorizationId = ((await auth.json()) as { case: { authorization: { id: string } } }).case.authorization.id;

    const bad = await routes.calls.POST(
      new Request(`${BASE}/${c.id}/calls`, { method: "POST", headers: { cookie: session }, body: "not json" }),
      ctx(c.id),
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");

    const requestId = "22222222-2222-4222-8222-222222222222";
    const dispatched = await routes.calls.POST(
      new Request(`${BASE}/${c.id}/calls`, {
        method: "POST",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ authorizationId, requestId }),
      }),
      ctx(c.id),
    );
    expect(dispatched.status).toBe(202);
    const { call } = (await dispatched.json()) as { call: { id: string; state: string } };
    expect(call.state).toBe("queued");

    // Timings are 0 here, so the next GET reconciles to completed.
    const polled = await routes.byId.GET(new Request(`${BASE}/${c.id}`, { headers: { cookie: session } }), ctx(c.id));
    expect(polled.status).toBe(200);
    const final = ((await polled.json()) as { case: { status: string; calls: { state: string }[]; outcome: { decision: string } } }).case;
    expect(final.calls[0]?.state).toBe("completed");
    expect(final.outcome.decision).toBe("approved");
    expect(final.status).toBe("approved");

    const packet = await routes.packet.GET(new Request(`${BASE}/${c.id}/packet`, { headers: { cookie: session } }), ctx(c.id));
    expect(packet.status).toBe(200);
    expect(packet.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await packet.text()).toContain("REFUND REQUEST PACKET");

    const stale = await routes.byId.PATCH(
      new Request(`${BASE}/${c.id}`, {
        method: "PATCH",
        headers: { cookie: session, "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 99, changes: { amountMinor: 1 } }),
      }),
      ctx(c.id),
    );
    expect(stale.status).toBe(409);
  });

  it("webhook route cancels an oversized streamed body at 1 MiB without Content-Length (413)", async () => {
    const total = 3 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024);
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/webhooks/dial", {
      method: "POST",
      body: stream,
      headers: { "x-dial-signature": "t=1,v1=00" },
      // @ts-expect-error duplex is required by Node for streamed request bodies
      duplex: "half",
    });
    const res = await routes.webhook.POST(request);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(total);
    expect(pulled).toBeLessThanOrEqual(1024 * 1024 + 2 * chunk.byteLength);
  });

  it("webhook route returns 401 for an unsigned body and 204 for a ping", async () => {
    const unsigned = await routes.webhook.POST(new Request("http://localhost/api/webhooks/dial", { method: "POST", body: "{}" }));
    expect(unsigned.status).toBe(401);
    const { buildSimulatedWebhook } = await import("@/server/cases/simulated-voice");
    const { body, headers } = buildSimulatedWebhook("simulated-webhook-secret", "sim_1_approved_deadbeef", { type: "webhook.ping" });
    const ping = await routes.webhook.POST(new Request("http://localhost/api/webhooks/dial", { method: "POST", body: new Blob([body]), headers }));
    expect(ping.status).toBe(204);
  });
});
