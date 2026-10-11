/**
 * Server-renders the composer's attach control and pending-file chips, and
 * checks the client-side screening that mirrors the server's upload limits.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Composer, { ATTACH_ACCEPT, MAX_ATTACH_BYTES, MAX_ATTACH_FILES, screenFiles, type ComposerProps } from "../Composer";

const base: ComposerProps = {
  value: "",
  onChange: () => {},
  onSend: async () => true,
  busy: false,
  busyLabel: "Reading your request",
  placeholder: "Which insurer or company, what happened, and when?",
  hint: null,
};

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

describe("Composer attach control", () => {
  it("renders a labelled attach button and a hidden multi-file input with the accepted types", () => {
    const html = renderToStaticMarkup(<Composer {...base} onAttach={async () => true} />);
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toContain('data-testid="composer-attach"');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple=""[^>]*accept="application\/pdf,image\/png,image\/jpeg"/);
    expect(ATTACH_ACCEPT).toBe("application/pdf,image/png,image/jpeg");
    expect(html).toContain("PDF, PNG or JPG, up to 10 MB each");
  });

  it("hides the attach control when attaching is not possible", () => {
    const html = renderToStaticMarkup(<Composer {...base} />);
    expect(html).not.toContain("Attach files");
    expect(html).not.toContain('type="file"');
  });

  it("shows each pending file as a chip with a remove control", () => {
    const pending = [file("kitchen.png", "image/png"), file("estimate.pdf", "application/pdf")];
    const html = renderToStaticMarkup(<Composer {...base} onAttach={async () => true} pendingFiles={pending} onRemovePending={() => {}} />);
    expect(html.match(/data-testid="composer-chip"/g)).toHaveLength(2);
    expect(html).toContain("kitchen.png");
    expect(html).toContain('aria-label="Remove kitchen.png"');
    expect(html).toContain('aria-label="Remove estimate.pdf"');
  });

  it("keeps the send button and keyboard hint", () => {
    const html = renderToStaticMarkup(<Composer {...base} onAttach={async () => true} />);
    expect(html).toContain('aria-label="Send message"');
    expect(html).toContain("<kbd>Enter</kbd> to send");
  });
});

describe("screenFiles", () => {
  it("accepts at most five files and says why the rest were left out", () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`photo-${i}.jpg`, "image/jpeg"));
    const { accepted, error } = screenFiles(six, 0);
    expect(MAX_ATTACH_FILES).toBe(5);
    expect(accepted).toHaveLength(5);
    expect(error).toBe("You can attach up to 5 files at a time.");
  });

  it("counts files already held", () => {
    const { accepted, error } = screenFiles([file("a.pdf", "application/pdf"), file("b.pdf", "application/pdf")], 4);
    expect(accepted.map((f) => f.name)).toEqual(["a.pdf"]);
    expect(error).toMatch(/up to 5 files/);
  });

  it("rejects files over 10 MB and unsupported types", () => {
    expect(MAX_ATTACH_BYTES).toBe(10 * 1024 * 1024);
    const big = file("scan.pdf", "application/pdf", MAX_ATTACH_BYTES + 1);
    const doc = file("notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const heic = file("IMG_0001.HEIC", "image/heic");
    const ok = file("IMG_0002.JPG", "");
    const { accepted, error } = screenFiles([big, doc, heic, ok], 0);
    expect(accepted.map((f) => f.name)).toEqual(["IMG_0002.JPG"]);
    expect(error).toContain("scan.pdf is larger than 10 MB.");
    expect(error).toContain("notes.docx is not a PDF, PNG or JPG file.");
    expect(error).toContain("IMG_0001.HEIC is not a PDF, PNG or JPG file.");
  });
});
