import { describe, expect, it } from "vitest";
import type { PlanRecord } from "../../plans/store";
import { attachmentsFor, MAX_CASE_FILES } from "../attachments";

function plan(overrides: Partial<PlanRecord>): PlanRecord {
  const fileName = overrides.fileName ?? "policy.pdf";
  const fileType = overrides.fileType ?? "application/pdf";
  return {
    id: crypto.randomUUID(),
    name: "",
    insurer: "",
    policyNumber: "",
    supportPhone: "",
    fileName,
    fileType,
    fileSize: 3,
    fileLastModified: 0,
    addedAt: new Date(0).toISOString(),
    file: new Blob(["pdf"], { type: fileType }),
    ...overrides,
  };
}

describe("attachmentsFor", () => {
  const csaa = plan({ insurer: "CSAA Insurance Group", supportPhone: "(949) 520-0007", fileName: "aaa-auto-policy.pdf" });
  const harbor = plan({ insurer: "Harbor Health", fileName: "harbor.pdf" });

  it("sends nothing for a message that is not about insurance", () => {
    expect(attachmentsFor("Refund a duplicate $49.99 charge from Ridgeline", [csaa, harbor], "fixture")).toMatchObject({
      files: [],
      names: [],
      notice: null,
    });
  });

  it("sends only the plan a message names and takes its insurer and phone", () => {
    const result = attachmentsFor("CSAA has not called me back about the dent", [csaa, harbor], "fixture");
    expect(result.names).toEqual(["aaa-auto-policy.pdf"]);
    expect(result.prefill).toEqual({ merchantName: "CSAA Insurance Group", supportPhone: "+19495200007" });
    expect(result.files[0]?.name).toBe("aaa-auto-policy.pdf");
  });

  it("sends every plan for a general insurance message, without prefilling", () => {
    const result = attachmentsFor("File an insurance claim for the dent", [csaa, harbor], "fixture");
    expect(result.names).toEqual(["aaa-auto-policy.pdf", "harbor.pdf"]);
    expect(result.prefill).toEqual({});
  });

  it.each(["I was rear-ended yesterday", "A collision on Market Street", "Help after my car accident"])(
    "counts a car accident as insurance: %j",
    (message) => {
      expect(attachmentsFor(message, [csaa], "fixture").names).toEqual(["aaa-auto-policy.pdf"]);
    },
  );

  it("leaves HEIC photos out against the server and says so", () => {
    const photo = plan({ insurer: "CSAA", fileName: "card.heic", fileType: "image/heic" });
    const result = attachmentsFor("claim for CSAA", [photo], "http");
    expect(result.files).toEqual([]);
    expect(result.notice).toContain("card.heic");
    expect(attachmentsFor("claim for CSAA", [photo], "fixture").names).toEqual(["card.heic"]);
  });

  it("caps a case at the server's file limit", () => {
    const many = Array.from({ length: MAX_CASE_FILES + 2 }, (_, index) => plan({ fileName: `plan-${index}.pdf` }));
    const result = attachmentsFor("insurance claim", many, "fixture");
    expect(result.files).toHaveLength(MAX_CASE_FILES);
    expect(result.notice).toContain(`at most ${MAX_CASE_FILES} files`);
  });
});
