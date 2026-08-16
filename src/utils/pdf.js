/**
 * Minimal, dependency-free PDF generator for text documents (tickets,
 * invoices, attendee/report exports).
 *
 * Produces a valid single- or multi-page PDF where every line is plain text.
 * Text is encoded as Latin-1; characters outside that range are replaced with
 * "?" so the byte stream always stays valid.
 */

const LATIN1 = /^[\x00-\xFF]*$/;

const toLatin1 = (value) => {
  const s = String(value ?? '');
  return LATIN1.test(s) ? s : s.replace(/[^\x00-\xFF]/g, '?');
};

// Escape PDF literal-string characters.
const escapeText = (value) =>
  toLatin1(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// Hard-wrap long lines at maxChars so nothing falls off the page.
const wrap = (text, maxChars) => {
  const s = String(text ?? '');
  if (s.length <= maxChars) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  return out;
};

/**
 * Build a PDF Buffer from a title and an array of text lines.
 * @param {{ title?: string, lines?: string[] }} opts
 * @returns {Buffer}
 */
export const textPdf = ({ title = '', lines = [] }) => {
  const PAGE_W = 595; // A4 portrait, points
  const PAGE_H = 842;
  const MARGIN = 56;
  const TITLE_SIZE = 18;
  const BODY_SIZE = 11;
  const LINE_H = 16;
  const MAX_CHARS = 92;

  const allLines = [];
  if (title) allLines.push({ text: title, size: TITLE_SIZE });
  for (const line of lines) {
    for (const wrapped of wrap(line, MAX_CHARS)) {
      allLines.push({ text: wrapped, size: BODY_SIZE });
    }
  }

  const headerHeight = title ? TITLE_SIZE + 28 : 0;
  const linesPerPage = Math.max(1, Math.floor((PAGE_H - MARGIN * 2 - headerHeight) / LINE_H));
  const pageCount = Math.max(1, Math.ceil(allLines.length / linesPerPage));

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push(allLines.slice(i * linesPerPage, (i + 1) * linesPerPage));
  }

  const streamFor = (pageLines) => {
    const parts = [];
    let y = PAGE_H - MARGIN;
    for (const { text, size } of pageLines) {
      const font = size === TITLE_SIZE ? 'F1' : 'F2';
      parts.push(`BT /${font} ${size} Tf ${MARGIN} ${y} Td (${escapeText(text)}) Tj ET`);
      y -= size === TITLE_SIZE ? TITLE_SIZE + 24 : LINE_H;
    }
    return parts.join('\n');
  };

  // Object numbering:
  //   1  catalog, 2  pages, 3..3+pageCount-1  page objects,
  //   then content streams, then the two font objects.
  const pageId = (i) => 3 + i;
  const contentId = (i) => 3 + pageCount + i;
  const boldFontId = 3 + 2 * pageCount;
  const regularFontId = 3 + 2 * pageCount + 1;

  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (str) => {
    const buf = Buffer.from(str, 'latin1');
    chunks.push(buf);
    length += buf.length;
  };
  const addObject = (body) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n');
  addObject('<< /Type /Catalog /Pages 2 0 R >>');
  addObject(
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pageCount} >>`,
  );
  for (let i = 0; i < pageCount; i++) {
    addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]` +
        ` /Contents ${contentId(i)} 0 R` +
        ` /Resources << /Font << /F1 ${boldFontId} 0 R /F2 ${regularFontId} 0 R >> >> >>`,
    );
  }
  for (let i = 0; i < pageCount; i++) {
    const stream = streamFor(pages[i]);
    addObject(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  }
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const xrefStart = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
};

export default textPdf;
