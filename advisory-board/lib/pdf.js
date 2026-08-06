// Minimal PDF writer (no dependencies) for the board's decision documents.
// Renders the report Markdown into a paginated A4 document using the three
// standard PDF base-14 fonts, so nothing has to be embedded and the file works
// in every reader.
//
// Supported Markdown: # / ## / ### headings, **bold** runs, - and 1. lists,
// > quotes, --- rules, and pipe tables (laid out in Courier). Anything else is
// treated as a paragraph - the point is a faithful, readable document, not a
// full Markdown engine.

// Helvetica / Helvetica-Bold advance widths (1/1000 em) for the printable
// ASCII range - real metrics, so wrapping matches what the reader draws.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// Unicode we actually emit -> CP1252 (WinAnsiEncoding) byte; anything else
// outside Latin-1 degrades to a plain ASCII stand-in rather than mojibake.
const CP1252 = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, '‰': 137, '‹': 139, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '™': 153, '›': 155 };
const ASCII_FALLBACK = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '×': 'x', '✓': 'v', '✗': 'x', '‘': "'", '’': "'", '“': '"', '”': '"', '—': '-', '–': '-', '…': '...', '•': '-' };

function toBytes(str) {
  const out = [];
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) { out.push(code); continue; }
    if (CP1252[ch] !== undefined) { out.push(CP1252[ch]); continue; }
    if (code >= 160 && code <= 255) { out.push(code); continue; }
    const alt = ASCII_FALLBACK[ch];
    if (alt) { for (const c of alt) out.push(c.charCodeAt(0)); continue; }
    if (code > 126) out.push(63); // '?'
  }
  return out;
}

// PDF string literal: bytes, with the three special characters escaped.
function pdfString(str) {
  const bytes = toBytes(str);
  let s = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (ch === '(' || ch === ')' || ch === '\\') s += '\\' + ch;
    else s += ch;
  }
  return s;
}

function widthOf(text, size, bold, mono) {
  if (mono) return toBytes(text).length * 0.6 * size;
  const table = bold ? W_BOLD : W_REG;
  let units = 0;
  for (const b of toBytes(text)) {
    units += b >= 32 && b <= 126 ? table[b - 32] : 556; // Latin-1 extras ~ average
  }
  return (units / 1000) * size;
}

// ---- page geometry ----
const PAGE_W = 595.28, PAGE_H = 841.89;
const MARGIN_X = 56, MARGIN_TOP = 64, MARGIN_BOTTOM = 58;
const BODY_SIZE = 10.5, BODY_LEAD = 15.5;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

class Doc {
  constructor(footerLabel) {
    this.pages = [];
    this.ops = [];
    this.y = PAGE_H - MARGIN_TOP;
    this.footerLabel = footerLabel || '';
  }
  newPage() {
    if (this.ops.length) this.pages.push(this.ops);
    this.ops = [];
    this.y = PAGE_H - MARGIN_TOP;
  }
  need(h) {
    if (this.y - h < MARGIN_BOTTOM) this.newPage();
  }
  // runs: [{ text, bold, mono, size, color }]
  drawRuns(runs, x, y) {
    let cx = x;
    for (const r of runs) {
      if (!r.text) continue;
      const font = r.mono ? '/F3' : r.bold ? '/F2' : '/F1';
      const col = r.color || [0.11, 0.11, 0.12];
      this.ops.push(
        `BT ${col[0]} ${col[1]} ${col[2]} rg ${font} ${r.size} Tf 1 0 0 1 ${cx.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(r.text)}) Tj ET`
      );
      cx += widthOf(r.text, r.size, r.bold, r.mono);
    }
  }
  rule(color) {
    this.need(14);
    const c = color || [0.87, 0.87, 0.89];
    this.y -= 8;
    this.ops.push(`${c[0]} ${c[1]} ${c[2]} RG 0.8 w ${MARGIN_X} ${this.y.toFixed(2)} m ${(PAGE_W - MARGIN_X).toFixed(2)} ${this.y.toFixed(2)} l S`);
    this.y -= 8;
  }
  // Wrap a run list to the given width, emitting lines.
  paragraph(runs, opts = {}) {
    const size = opts.size || BODY_SIZE;
    const lead = opts.lead || BODY_LEAD;
    const indent = opts.indent || 0;
    const hanging = opts.hanging || '';
    const color = opts.color;
    const maxW = CONTENT_W - indent;
    // tokenize into words carrying their style
    const words = [];
    for (const r of runs) {
      const parts = String(r.text).split(/(\s+)/);
      for (const p of parts) {
        if (p === '') continue;
        words.push({ text: p, bold: !!r.bold, mono: !!r.mono, space: /^\s+$/.test(p) });
      }
    }
    let line = [], lineW = 0, first = true;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      if (!line.length && !first) return;
      this.need(lead);
      const x = MARGIN_X + indent;
      if (first && hanging) {
        this.drawRuns([{ text: hanging, bold: false, mono: false, size, color }], MARGIN_X + indent - widthOf(hanging + ' ', size, false, false), this.y);
      }
      this.drawRuns(line.map((w) => ({ text: w.text, bold: w.bold, mono: w.mono, size, color })), x, this.y);
      this.y -= lead;
      line = []; lineW = 0; first = false;
    };
    for (const w of words) {
      const ww = widthOf(w.text, size, w.bold, w.mono);
      if (lineW + ww > maxW && line.length) flush();
      if (!line.length && w.space) continue;
      line.push(w); lineW += ww;
    }
    flush();
  }
  finish() {
    if (this.ops.length) this.pages.push(this.ops);
    if (!this.pages.length) this.pages.push([]);
    // page footers
    this.pages.forEach((ops, i) => {
      const label = `${this.footerLabel}${this.footerLabel ? '   ·   ' : ''}Page ${i + 1} of ${this.pages.length}`;
      const w = widthOf(label, 8.5, false, false);
      ops.push(`BT 0.55 0.55 0.58 rg /F1 8.5 Tf 1 0 0 1 ${(PAGE_W - MARGIN_X - w).toFixed(2)} ${(MARGIN_BOTTOM - 26).toFixed(2)} Tm (${pdfString(label)}) Tj ET`);
    });
    return this.pages;
  }
}

// ---- inline markdown ----
function inlineRuns(text) {
  const runs = [];
  // **bold** and `code` (code is rendered bold-ish plain to stay readable)
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true });
    else runs.push({ text: m[2], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs.length ? runs : [{ text: '', bold: false }];
}

function splitTableRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

// ---- the renderer ----
function markdownToPdf(markdown, meta = {}) {
  const doc = new Doc(meta.footer || '');
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');

  // Cover block
  if (meta.title) {
    doc.paragraph([{ text: meta.title, bold: true }], { size: 22, lead: 27 });
    doc.y -= 2;
  }
  if (meta.subtitle) {
    doc.paragraph([{ text: meta.subtitle, bold: false }], { size: 10.5, lead: 15, color: [0.43, 0.43, 0.45] });
  }
  if (meta.title) doc.rule([0.12, 0.51, 0.30]);

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { doc.y -= 6; i++; continue; }

    // The report's own H1 is replaced by the cover title.
    if (/^#\s+/.test(line)) { i++; continue; }

    if (/^##\s+/.test(line)) {
      doc.need(34);
      doc.y -= 10;
      doc.paragraph(inlineRuns(line.replace(/^##\s+/, '')), { size: 14.5, lead: 20 });
      doc.y -= 3;
      i++; continue;
    }
    if (/^###\s+/.test(line)) {
      doc.need(26);
      doc.y -= 6;
      doc.paragraph(inlineRuns(line.replace(/^###\s+/, '')), { size: 11.5, lead: 17 });
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { doc.rule(); i++; continue; }

    // pipe table: header row, separator, body rows
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const header = splitTableRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) { rows.push(splitTableRow(lines[j].trim())); j++; }
      const cols = header.length;
      const size = 8.6;
      const charW = 0.6 * size;
      const totalChars = Math.floor(CONTENT_W / charW);
      const widths = header.map((h, c) => {
        let w = h.length;
        for (const r of rows) w = Math.max(w, (r[c] || '').replace(/\*\*/g, '').length);
        return w;
      });
      const sum = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
      const scale = sum > totalChars ? totalChars / sum : 1;
      const cw = widths.map((w) => Math.max(4, Math.floor(w * scale)));
      const renderRow = (cells, bold) => {
        doc.need(13);
        let x = MARGIN_X;
        cells.forEach((cell, c) => {
          const clean = String(cell || '').replace(/\*\*/g, '');
          const text = clean.length > cw[c] ? clean.slice(0, Math.max(1, cw[c] - 1)) + '…' : clean;
          doc.drawRuns([{ text, bold, mono: true, size }], x, doc.y);
          x += (cw[c] + 2) * charW;
        });
        doc.y -= 13;
      };
      doc.y -= 4;
      renderRow(header, true);
      doc.ops.push(`0.87 0.87 0.89 RG 0.7 w ${MARGIN_X} ${(doc.y + 9).toFixed(2)} m ${(PAGE_W - MARGIN_X).toFixed(2)} ${(doc.y + 9).toFixed(2)} l S`);
      for (const r of rows) renderRow(r, /\*\*/.test(r.join('')));
      doc.y -= 6;
      i = j; continue;
    }

    // bullets and numbered items
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const body = bullet ? bullet[1] : numbered[2];
      const marker = bullet ? '•' : numbered[1] + '.';
      doc.paragraph(inlineRuns(body), { indent: 18, hanging: marker });
      i++; continue;
    }

    if (/^>\s?/.test(line)) {
      doc.paragraph(inlineRuns(line.replace(/^>\s?/, '')), { indent: 14, color: [0.43, 0.43, 0.45] });
      i++; continue;
    }

    // paragraph: join following non-blank, non-structural lines
    let text = line;
    let j = i + 1;
    while (
      j < lines.length && lines[j].trim() &&
      !/^(#{1,6}\s|[-*]\s|\d+\.\s|>|\||-{3,})/.test(lines[j].trim())
    ) { text += ' ' + lines[j].trim(); j++; }
    doc.paragraph(inlineRuns(text));
    i = j;
  }

  return assemble(doc.finish());
}

// ---- PDF object assembly ----
function assemble(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; }; // 1-based ids

  const catalogId = add(null); // placeholder, filled after we know Pages id
  const pagesId = add(null);
  const fontReg = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const fontMono = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R /F3 ${fontMono} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, idx) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${idx + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= objects.length; k++) {
    out += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { markdownToPdf };
