// Ses -> zaman damgalı metin ("[12:34] ..."). Altyazı (SRT/VTT) varsa düz metne çevrilir; yoksa ses
// OpenAI uyumlu bir konuşma tanıma uç noktasına (varsayılan EVREN, qwen3-asr) ya da yerel whisper.cpp'ye gider.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';
const WHISPER = () => process.env.WHISPER || 'whisper-cli';
const MODEL = () => process.env.WHISPER_MODEL || ''; // ör. ggml-large-v3-turbo-q5_0.bin; boşsa whisper kullanılmaz
const hasWhisper = () => !!MODEL() && fs.existsSync(MODEL());
const PART = 30; // sn; uç nokta her parça için tek metin döndürür, damga parça başından gelir

const stamp = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0'); };
const secs = t => { const [h, m, s] = t.split(':'); return +h * 3600 + +m * 60 + +s; }; // "00:01:02.500"

// VTT -> "[mm:ss] metin" paragrafları. Otomatik altyazıdaki kayan (tekrarlanan) satırlar atılır;
// yaklaşık 20 sn'lik parçalar tek damgayla birleşir.
function vttToText(vtt, gap = 20) {
  const out = [];
  let last = '', from = -1e9, cur = null;
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = /^(?:(\d+):)?(\d+):(\d+)[.,]\d+/.exec(lines[i].trim());
    if (!m) continue;
    const start = secs(`${m[1] || 0}:${m[2]}:${m[3]}`);
    for (let l of lines.slice(i + 1)) {
      l = l.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      if (!l || l === last) continue;
      last = l;
      if (!cur || start - from >= gap) { cur = { t: start, text: [] }; out.push(cur); from = start; }
      cur.text.push(l);
    }
  }
  return out.map(c => `[${stamp(c.t)}] ${c.text.join(' ')}`).join('\n') + (out.length ? '\n' : '');
}

const tool = async (bin, args, timeout, what) => {
  try { await run(bin, args, { timeout, maxBuffer: 1 << 26 }); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `${bin} kurulu değil` : `${what} başarısız: ` + String(e.stderr || e.message).trim().slice(-300));
  }
};

// asr: { base, key, model } — key yoksa yalnızca whisper.
async function asrPart(asr, wav) {
  const f = new FormData();
  f.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), path.basename(wav));
  f.append('model', asr.model);
  for (let n = 1; ; n++) {
    const r = await fetch(asr.base.replace(/\/+$/, '') + '/v1/audio/transcriptions', { method: 'POST', body: f, headers: { authorization: `Bearer ${asr.key}` }, signal: AbortSignal.timeout(120000) });
    if (r.ok) return String((await r.json()).text || '').trim();
    if ((r.status === 429 || r.status >= 500) && n < 4) { await new Promise(s => setTimeout(s, (+r.headers.get('retry-after') || 15 * n) * 1000)); continue; }
    throw new Error(`konuşma tanıma ${r.status}`);
  }
}

async function viaWhisper(tmp, wav) {
  fs.rmSync(path.join(tmp, 'w.srt'), { force: true });
  await tool(WHISPER(), ['-m', MODEL(), '-f', wav, '-l', 'auto', '-osrt', '-of', path.join(tmp, 'w'), '-np'], 3 * 3600e3, 'konuşma tanıma');
  return fs.existsSync(path.join(tmp, 'w.srt')) ? vttToText(fs.readFileSync(path.join(tmp, 'w.srt'), 'utf8')) : '';
}

// shortcut: parçalar sessizliğe değil süreye göre kesilir, sınırdaki kelime bölünebilir; sorun olursa ffmpeg silencedetect ile kes.
async function viaAsr(tmp, asr) {
  await tool(FFMPEG(), ['-v', 'error', '-y', '-i', path.join(tmp, 'a.wav'), '-f', 'segment', '-segment_time', String(PART), '-c', 'copy', path.join(tmp, 'p%05d.wav')], 15 * 60e3, 'ses bölme');
  const parts = fs.readdirSync(tmp).filter(f => /^p\d{5}\.wav$/.test(f)).sort();
  let out = '', bad = 0;
  for (const [i, f] of parts.entries()) {
    let t;
    try { t = await asrPart(asr, path.join(tmp, f)); } catch (e) { // tek tük yanıtsız parça yerelde çevrilir
      if (++bad > 2 || !hasWhisper()) throw e;
      t = (await viaWhisper(tmp, path.join(tmp, f))).replace(/^\[[\d:]+\] /gm, '');
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (t) out += `[${stamp(i * PART)}] ${t}\n`;
  }
  return out;
}

// input: dosya ya da adres; pre: ffmpeg'in -i'den önceki seçenekleri (ör. çerez başlığı). Metni outFile'a yazar.
async function audioToText(input, pre, tmp, outFile, asr) {
  if (!asr?.key && !hasWhisper()) throw new Error('Kayıtta altyazı yok ve konuşma tanıma ayarlı değil: ASR_API_KEY ya da WHISPER_MODEL verin (README).');
  await tool(FFMPEG(), ['-v', 'error', '-y', ...pre, '-i', input, '-vn', '-ar', '16000', '-ac', '1', path.join(tmp, 'a.wav')], 30 * 60e3, 'ses dönüştürme');
  let text = '';
  if (asr?.key) { try { text = await viaAsr(tmp, asr); } catch (e) { if (!hasWhisper()) throw e; } }
  if (!text.trim() && hasWhisper()) text = await viaWhisper(tmp, path.join(tmp, 'a.wav'));
  if (!text.trim()) throw new Error('kayıtta anlaşılır konuşma bulunamadı');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
}

module.exports = { vttToText, audioToText, stamp };
