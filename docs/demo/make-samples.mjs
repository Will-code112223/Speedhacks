#!/usr/bin/env node
/**
 * Writes the two sample plan PDFs that the demo tour uploads during onboarding.
 *
 *   samples/northwind-mutual-home-policy.pdf     title "Northwind Mutual home policy"
 *   samples/northwind-mutual-renewal-notice.pdf  title "Northwind Mutual renewal notice"
 *
 * Each file is a hand-written PDF 1.4 document: one US Letter page set in the
 * standard Helvetica fonts (nothing embedded), the title in the Info dictionary,
 * and an exact cross-reference table. No dependencies. The bytes are
 * deterministic, so running it again never produces a git diff.
 *
 * Usage, from any folder:  node docs/demo/make-samples.mjs
 * sitereel.config.mjs also calls ensureSamples() before the upload step, so a
 * recording recreates the files if they are missing or stale.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLES_DIR = fileURLToPath(new URL('./samples/', import.meta.url));

const POLICY_NUMBER = 'NWM-HO-0441772';
const CLAIMS_LINE = '+1 (800) 555-0142';
const FOOTER = 'Sample document generated for a product demo. Northwind Mutual is a fictional insurer.';

/** Page content as blocks, top to bottom. Every string must be printable ASCII. */
export const SAMPLES = [
  {
    file: 'northwind-mutual-home-policy.pdf',
    title: 'Northwind Mutual home policy',
    subject: 'Homeowners policy declarations',
    created: 'D:20251015090000Z',
    blocks: [
      { title: 'Northwind Mutual home policy' },
      { subtitle: 'Homeowners policy - declarations page' },
      { rule: true },
      {
        rows: [
          ['Policy number', POLICY_NUMBER],
          ['Named insured', 'Jordan Lee'],
          ['Insured property', '1420 Alder Lane, Springfield'],
          ['Policy period', 'November 1, 2025 to November 1, 2026'],
        ],
      },
      { heading: 'Coverages and limits' },
      {
        rows: [
          ['Coverage A - Dwelling', '$350,000'],
          ['Coverage B - Other structures', '$35,000'],
          ['Coverage C - Personal property', '$175,000'],
          ['Coverage D - Loss of use', '$70,000'],
          ['Deductible, all perils', '$500'],
        ],
      },
      { heading: 'Water damage' },
      {
        text: [
          'Covered: sudden and accidental discharge of water or steam from within a',
          'plumbing, heating or air conditioning system or a household appliance,',
          'including the cost of tearing out and replacing the part of the building',
          'needed to reach and repair the system.',
          'Not covered: continuous or repeated seepage or leakage over 14 days or more.',
        ],
      },
      { heading: 'How to file a claim' },
      {
        text: [
          `Report a loss as soon as you can. Claims line: ${CLAIMS_LINE}, 24 hours a day.`,
          'Have your policy number, the date of loss and a short description ready.',
        ],
      },
    ],
  },
  {
    file: 'northwind-mutual-renewal-notice.pdf',
    title: 'Northwind Mutual renewal notice',
    subject: 'Homeowners policy renewal notice',
    created: 'D:20260915090000Z',
    blocks: [
      { title: 'Northwind Mutual renewal notice' },
      { subtitle: 'Your homeowners policy renews on November 1, 2026' },
      { rule: true },
      {
        rows: [
          ['Notice date', 'September 15, 2026'],
          ['Policy number', POLICY_NUMBER],
          ['Named insured', 'Jordan Lee'],
          ['Renewal period', 'November 1, 2026 to November 1, 2027'],
        ],
      },
      { heading: 'At renewal' },
      {
        rows: [
          ['Annual premium', '$1,436.00 (was $1,392.00)'],
          ['Coverage A - Dwelling', '$360,500 (inflation guard, +3%)'],
          ['Deductible, all perils', '$500, unchanged'],
          ['Water damage coverage', 'Unchanged'],
        ],
      },
      { heading: 'Nothing to do' },
      {
        text: [
          'Your policy renews automatically on the same terms. Keep this notice with',
          `your policy. Questions or a claim to report: ${CLAIMS_LINE}, 24 hours a day.`,
        ],
      },
    ],
  },
];

// Layout in PDF points on a 612 x 792 page; text runs from x 72 to x 540.
const LEFT = 72;
const RIGHT = 540;
const VALUE_X = 288;
const TOP = 716;

/** A PDF literal string. Restricting to ASCII keeps WinAnsiEncoding and byte offsets trivial. */
function pdfText(s) {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error(`Sample PDF text must be printable ASCII: ${JSON.stringify(s)}`);
  return `(${s.replace(/[\\()]/g, '\\$&')})`;
}

function contentStream(blocks) {
  const ops = [];
  let y = TOP;
  const text = (s, { x = LEFT, size = 11, bold = false, gray = 0 } = {}) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${gray} g ${x} ${y} Td ${pdfText(s)} Tj ET`);
  const rule = (at) => ops.push(`0.8 G 0.75 w ${LEFT} ${at} m ${RIGHT} ${at} l S`);

  for (const block of blocks) {
    if (block.title) {
      text(block.title, { size: 20, bold: true });
      y -= 22;
    } else if (block.subtitle) {
      text(block.subtitle, { gray: 0.4 });
      y -= 18;
    } else if (block.rule) {
      rule(y);
      y -= 24;
    } else if (block.heading) {
      y -= 10;
      text(block.heading, { size: 12, bold: true });
      y -= 20;
    } else if (block.rows) {
      for (const [key, value] of block.rows) {
        text(key, { gray: 0.4 });
        text(value, { x: VALUE_X });
        y -= 17;
      }
    } else if (block.text) {
      for (const line of block.text) {
        text(line);
        y -= 15;
      }
    }
  }
  rule(70);
  y = 54;
  text(FOOTER, { size: 8, gray: 0.45 });
  return ops.join('\n');
}

/** Serializes one sample as a complete single-page PDF 1.4 file. */
export function buildPdf(doc) {
  const stream = contentStream(doc.blocks);
  const info = [
    `/Title ${pdfText(doc.title)}`,
    `/Subject ${pdfText(doc.subject)}`,
    `/Author ${pdfText('Recourse demo samples')}`,
    `/Creator ${pdfText('docs/demo/make-samples.mjs')}`,
    `/CreationDate ${pdfText(doc.created)}`,
    `/ModDate ${pdfText(doc.created)}`,
  ].join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< ${info} >>`,
  ];

  // Every character is below U+0100, so string length equals byte length in latin1.
  // The second line is the binary marker comment recommended by ISO 32000-1, 7.5.2.
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  const id = createHash('md5').update(pdf, 'latin1').digest('hex');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R /ID [<${id}> <${id}>] >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Writes any sample that is missing or differs from the expected bytes; returns absolute paths. */
export function ensureSamples() {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  return SAMPLES.map((doc) => {
    const file = path.join(SAMPLES_DIR, doc.file);
    const bytes = buildPdf(doc);
    let current = null;
    try {
      current = fs.readFileSync(file);
    } catch {}
    if (!current || !current.equals(bytes)) fs.writeFileSync(file, bytes);
    return file;
  });
}

const runAsScript = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (runAsScript) {
  for (const file of ensureSamples()) {
    console.log(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} bytes`);
  }
}
