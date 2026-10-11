import { describe, expect, it } from "vitest";
import { composeSummary, inferDestination, isValidDestination, messageUrl } from "../summary";
import type { SummaryDelivery } from "../types";
import { failureOf, iso, sampleCall, sampleCase, startedCall, T0 } from "./support";

const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(T0));

describe("composeSummary", () => {
  it("writes an approved refund with amount, where it goes, reference, payment and call length", () => {
    const transcript = "Support: I've issued the refund of $49.99 to the original card, reference RO-77102.";
    const call = sampleCall({ state: "completed", transcript, updatedAt: iso(T0 + 30_000) });
    const caseData = sampleCase({
      status: "approved",
      merchant: { name: "Ridgeline Outfitters", supportPhone: "+14155550177" },
      calls: [call],
      outcome: {
        decision: "approved",
        referenceNumber: "RO-77102",
        nextAction: "Refund expected within 5 to 7 business days. Confirm when it lands.",
        paymentStatus: "unverified",
        supportingQuote: null,
      },
    });

    expect(composeSummary(caseData, call, { channel: "email", to: " jordan@example.com " })).toEqual({
      channel: "email",
      to: "jordan@example.com",
      subject: "Recourse: Ridgeline Outfitters - Approved $49.99",
      summary: [
        "Support decision: Approved",
        "Refund of $49.99 to the original card, reference RO-77102",
        "Payment: unverified",
        "Next step: Refund expected within 5 to 7 business days. Confirm when it lands.",
        `Call with Ridgeline Outfitters lasted 0:30 on ${day}`,
      ],
      transcript,
      sentAt: null,
    });
  });

  it("writes a requested claim by reference, with no subject for a text message and no invented amount", () => {
    const call = sampleCall({ state: "completed", transcript: null, updatedAt: iso(T0 + 65_000) });
    const caseData = sampleCase({
      status: "awaiting_response",
      merchant: { name: "Northwind Mutual", supportPhone: "+18005550199" },
      amountMinor: 120_000,
      calls: [call],
      outcome: {
        decision: "requested",
        referenceNumber: "NWM-2026-48213",
        nextAction: null,
        paymentStatus: "confirmed",
        supportingQuote: null,
      },
    });

    const delivery = composeSummary(caseData, call, { channel: "sms", to: "+1 415 555 0123" });
    expect(delivery.subject).toBeNull();
    expect(delivery.summary).toEqual([
      "Support decision: Requested",
      "Reference NWM-2026-48213",
      "Payment: confirmed",
      `Call with Northwind Mutual lasted 1:05 on ${day}`,
    ]);
    expect(delivery.transcript).toBe("Transcript not available yet.");
  });
});

describe("inferDestination", () => {
  it.each([
    ["jordan@example.com", { channel: "email", to: "jordan@example.com" }],
    ["  jordan.avery@mail.example.org ", { channel: "email", to: "jordan.avery@mail.example.org" }],
    ["+1 (415) 555-0123", { channel: "sms", to: "+1 (415) 555-0123" }],
    ["415.555.0123", { channel: "sms", to: "415.555.0123" }],
    ["447700900123456", { channel: "sms", to: "447700900123456" }],
  ])("reads %j", (text, expected) => {
    expect(inferDestination(text)).toEqual(expected);
  });

  it.each(["", "   ", "jordan@example", "jordan at example.com", "555 0123", "4155550123456789", "call me"])(
    "rejects %j",
    (text) => {
      expect(inferDestination(text)).toBeNull();
    },
  );

  it("checks a destination against its channel", () => {
    expect(isValidDestination({ channel: "email", to: "jordan@example.com" })).toBe(true);
    expect(isValidDestination({ channel: "sms", to: "jordan@example.com" })).toBe(false);
    expect(isValidDestination({ channel: "email", to: "4155550123" })).toBe(false);
  });
});

describe("messageUrl", () => {
  const base: SummaryDelivery = {
    channel: "email",
    to: "jordan+refunds@example.com",
    subject: "Recourse: Ridgeline Outfitters - Approved $49.99",
    summary: ["Support decision: Approved", "Payment: unverified"],
    transcript: "Agent: Hello & thanks?",
    sentAt: null,
  };

  it("builds a mailto URL with an encoded subject and a body of lines, a blank line and the transcript", () => {
    const url = messageUrl(base);
    expect(url).toBe(
      "mailto:jordan%2Brefunds@example.com" +
        "?subject=Recourse%3A%20Ridgeline%20Outfitters%20-%20Approved%20%2449.99" +
        "&body=Support%20decision%3A%20Approved%0D%0APayment%3A%20unverified%0D%0A%0D%0AAgent%3A%20Hello%20%26%20thanks%3F",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("subject")).toBe(base.subject);
    expect(parsed.searchParams.get("body")).toBe("Support decision: Approved\r\nPayment: unverified\r\n\r\nAgent: Hello & thanks?");
  });

  it("builds an sms URL from the digits with the body after ?&body=", () => {
    const url = messageUrl({ ...base, channel: "sms", to: "+1 (415) 555-0123", subject: null });
    expect(url).toBe(
      "sms:%2B14155550123?&body=Support%20decision%3A%20Approved%0APayment%3A%20unverified%0A%0AAgent%3A%20Hello%20%26%20thanks%3F",
    );
  });
});

describe("fixture sendSummary", () => {
  it("refuses before the call completes, then sends once per destination and logs it as simulated", async () => {
    const { api, caseId, callId, caseAt } = await startedCall("duplicate_charge");

    await caseAt(10);
    expect(await failureOf(api.sendSummary(caseId, { channel: "sms", to: "+1 415 555 0123" }))).toMatchObject({
      status: 409,
      code: "CALL_NOT_COMPLETE",
      message: "The call has not finished yet.",
    });

    await caseAt(30);
    expect(await failureOf(api.sendSummary(caseId, { channel: "sms", to: "jordan@example.com" }))).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      fields: ["to"],
    });
    expect(await failureOf(api.sendSummary("00000000-0000-4000-8000-000000000000", { channel: "sms", to: "4155550123" })))
      .toMatchObject({ status: 404, code: "NOT_FOUND" });

    await caseAt(31);
    const sent = await api.sendSummary(caseId, { channel: "sms", to: "+1 415 555 0123" });
    const c = await api.getCase(caseId);
    expect(sent).toEqual({
      ...composeSummary(c, c.calls[0]!, { channel: "sms", to: "+1 415 555 0123" }),
      sentAt: iso(T0 + 31_000),
    });
    expect(sent.summary[1]).toBe("Refund of $49.99 to the original card, reference RO-77102");
    expect(c.calls[0]?.id).toBe(callId);
    const logged = c.timeline.filter((t) => t.type === "summary_sent");
    expect(logged.map((t) => t.message)).toEqual([
      "Transcript and summary sent by text message to +1 415 555 0123 (simulated).",
    ]);
    expect(logged[0]?.at).toBe(iso(T0 + 31_000));

    // A repeat to the same destination returns the same delivery and sends nothing new.
    await caseAt(40);
    expect(await api.sendSummary(caseId, { channel: "sms", to: "+1 415 555 0123" })).toEqual(sent);
    expect((await api.getCase(caseId)).timeline.filter((t) => t.type === "summary_sent")).toHaveLength(1);

    const emailed = await api.sendSummary(caseId, { channel: "email", to: "jordan@example.com" });
    expect(emailed).toMatchObject({ channel: "email", subject: "Recourse: Ridgeline Outfitters billing - Approved $49.99", sentAt: iso(T0 + 40_000) });
    expect((await api.getCase(caseId)).timeline.filter((t) => t.type === "summary_sent").at(-1)?.message).toBe(
      "Transcript and summary sent by email to jordan@example.com (simulated).",
    );
  });
});
