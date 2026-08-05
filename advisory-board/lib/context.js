// Context attachments: turn an uploaded Markdown or PDF file into plain text
// the whole board can read. Everything becomes text, so all three providers
// receive the identical briefing - a board where members saw different source
// material would not be deliberating on the same question.
//
// Markdown/plain text is decoded directly. PDFs are transcribed by a cheap
// housekeeping model (claude-haiku-4-5) via Anthropic's document support: it
// handles real-world encodings and scanned pages that a hand-rolled parser
// would silently turn into garbage - and silently wrong context is worse than
// a rejected upload.

const https = require('node:https');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB upload ceiling
const MAX_CHARS = 200000; // ~50k tokens; beyond this the board pays a lot per seat
const TRANSCRIBE_MODEL = 'claude-haiku-4-5';
const TRANSCRIBE_MAX_TOKENS = 16000;

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function transcribePdf(buffer, apiKey) {
  const body = JSON.stringify({
    model: TRANSCRIBE_MODEL,
    max_tokens: TRANSCRIBE_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
          {
            type: 'text',
            text: 'Transcribe this document to plain text, verbatim and complete. Keep headings, lists and table rows readable in Markdown. Do not summarise, comment, or add anything of your own - output only the transcription.',
          },
        ],
      },
    ],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Could not read the PDF (HTTP ${res.statusCode} from the transcription model).`));
          }
          let parsed;
          try { parsed = JSON.parse(data); } catch { return reject(new Error('Could not read the PDF (bad response from the transcription model).')); }
          const text = (parsed.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
          resolve({ text, truncated: parsed.stop_reason === 'max_tokens' });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error('Reading the PDF took too long.')), 5 * 60 * 1000);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.on('close', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

// Returns { name, text, chars, kind, notes[] }; throws with a user-facing
// message when the file cannot become usable context.
async function extractContext(buffer, filename, keys) {
  if (!buffer || !buffer.length) throw new Error('The file was empty.');
  if (buffer.length > MAX_BYTES) throw new Error(`That file is ${(buffer.length / 1048576).toFixed(1)} MB; the limit is 10 MB.`);
  const ext = extOf(filename);
  const notes = [];
  let text;
  let kind;

  if (ext === 'pdf') {
    if (!keys || !keys.anthropic) throw new Error('PDF attachments need the Anthropic key, which is not configured.');
    const out = await transcribePdf(buffer, keys.anthropic);
    text = out.text;
    kind = 'pdf';
    if (out.truncated) notes.push('The PDF was long; only the first part could be read.');
    if (!text || text.trim().length < 20) {
      throw new Error('No readable text came out of that PDF. If it is a scan of poor quality, attach a Markdown file instead.');
    }
  } else if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'text' || ext === '') {
    text = buffer.toString('utf8');
    kind = ext === 'txt' || ext === 'text' ? 'text' : 'markdown';
    // A binary file renamed .md arrives as NULs / replacement characters.
    const bad = (text.match(/[\u0000\uFFFD]/g) || []).length;
    if (bad > 0 && bad > text.length / 1000) {
      throw new Error('That file does not look like text. Attach a Markdown (.md) or PDF file.');
    }
  } else {
    throw new Error(`.${ext} files are not supported - attach a Markdown (.md) or PDF file.`);
  }

  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('That file had no text in it.');
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    notes.push(`Only the first ${MAX_CHARS.toLocaleString('en-US')} characters are used.`);
  }
  return { name: String(filename || 'context').slice(0, 120), text, chars: text.length, kind, notes };
}

module.exports = { extractContext, MAX_BYTES, MAX_CHARS };
