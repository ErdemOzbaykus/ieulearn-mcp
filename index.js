#!/usr/bin/env node
// IEULearn MCP sunucusu (stdio): yapay zeka İzmir Ekonomi Üniversitesi IEULearn'deki dersleri, ödevleri, sınav takvimini,
// ders içeriğini ve Panopto ders kayıtlarını (hocanın anlatımı, zaman damgalı metin olarak) okur.
// Okul hesabı ortam değişkeninden ya da .env'den okunur; araç yanıtlarına ve yapay zekaya hiç gitmez. Yalnızca okur, siteye bir şey göndermez.
const fs = require('fs');
const os = require('os');
const path = require('path');
const learn = require('./lib/learn');
const panopto = require('./lib/panopto');
const { decode, field, parseCourses, parsePlan, parseLinks, parseAssignments, parseIcs } = require('./lib/parse');

// Ayarlar: ortam değişkenleri, eksikleri IEULEARN_ENV_FILE (yoksa bu klasördeki .env) dosyasından. Değer düz ya da JSON-tırnaklı olabilir.
function env() {
  const o = {};
  try {
    for (const l of fs.readFileSync(process.env.IEULEARN_ENV_FILE || path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(l);
      if (m) { try { o[m[1]] = JSON.parse(m[2]); } catch { o[m[1]] = m[2]; } }
    }
  } catch { /* .env yok */ }
  return { ...o, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
}
const CACHE = () => env().IEULEARN_CACHE || path.join(os.homedir(), '.ieulearn-mcp'); // kayıt metinleri: <ders>/pn-<kimlik>.txt
const asr = e => ({ base: e.ASR_BASE_URL || 'https://evren-llmapi.ssyz.org.tr', key: e.ASR_API_KEY || e.EVREN_KEY, model: e.ASR_MODEL || 'qwen3-asr-1.7b' });

const MAX = 60000; // tek yanıtın karakter sınırı (bağlamı doldurmasın)

let session; // { jar, at } — 20 dk kullanılır, sonra yeniden giriş
async function jar() {
  if (session && Date.now() - session.at < 20 * 60e3) return session.jar;
  const e = env();
  if (!e.IEU_USER || !e.IEU_PASS) throw new Error('Okul hesabı yok: IEU_USER ve IEU_PASS ortam değişkenlerini ya da .env dosyasını ayarlayın (README).');
  session = { jar: await learn.loginLearn(e), at: Date.now() };
  return session.jar;
}
const pano = new Map(); // courseId -> { jar, folderId, at }
async function panoFor(courseId) {
  const c = pano.get(courseId);
  if (c && Date.now() - c.at < 20 * 60e3) return c;
  const v = { ...(await panopto.launch(await jar(), courseId)), at: Date.now() };
  pano.set(courseId, v);
  return v;
}

const get = async p => { const r = await learn.req(await jar(), learn.LEARN + p); if (!r.ok) throw new Error(`IEULearn ${r.status}: ${p}`); return r.text(); };

// HTML -> okunur düz metin (script/style atılır, bağlantılar "metin [adres]" olarak kalır).
function htmlText(html) {
  return decode(html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*\bhref="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `${t} [${h}]`)
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr|\/article|\/section)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Ders kodu (ör. "MCE350" ya da "MCE 350") ya da IEULearn ders numarası -> { course, name, courseId }
async function course(q) {
  const key = String(q || '').replace(/\s+/g, '').toUpperCase();
  const all = parseCourses((await jar()).home || '');
  const c = all.find(x => x.course === key || String(x.courseId) === key);
  if (!c) throw new Error(`Ders bulunamadı: ${q}. Dersler: ${all.map(x => x.course).join(', ')}`);
  return c;
}

const str = d => ({ type: 'string', description: d });
const TOOLS = [
  { name: 'list_courses', description: 'Öğrencinin bu dönemki IEULearn dersleri (ders kodu, adı, IEULearn numarası).', inputSchema: { type: 'object', properties: {} },
    run: async () => parseCourses((await jar()).home || '') },
  { name: 'list_assignments', description: 'Tüm derslerin ödevleri: başlık, ders, durum (pending/submitted/graded), son teslim (İstanbul saati) ve IEULearn bağlantısı.', inputSchema: { type: 'object', properties: {} },
    run: async () => parseAssignments(await (await learn.assignmentsFragment(await jar())).text(), learn.LEARN) },
  { name: 'list_exams', description: 'Sınav takvimi (analytics.ieu.edu.tr): ders, başlangıç/bitiş (UTC), salon.', inputSchema: { type: 'object', properties: {} },
    run: () => exams(env()) },
  { name: 'course_content', description: 'Dersin "Ders İçeriği" sayfası: haftalık konu planı metni ve ders dosyaları (PDF/PPTX) listesi.', inputSchema: { type: 'object', properties: { course: str('Ders kodu, ör. MCE350') }, required: ['course'] },
    run: async ({ course: q }) => {
      const c = await course(q), html = await get(`/student/courses/${c.courseId}/overview/unit-plan`);
      const files = [...parsePlan(html).map(f => ({ title: f.title, file: f.file_name, url: `${learn.LEARN}/student/courses/${c.courseId}/resources/${f.id}/download` })), ...parseLinks(html, learn.LEARN)];
      return { ...c, files, plan: htmlText(html).slice(0, MAX / 2) };
    } },
  { name: 'read_learn_page', description: 'IEULearn öğrenci sayfasını okunur metin olarak getirir (giriş yapılmış). Yalnızca /student ile başlayan yollar; ör. "/student/courses/16911", "/student?ann=6160".', inputSchema: { type: 'object', properties: { path: str('/student ile başlayan yol') }, required: ['path'] },
    run: async ({ path: p }) => {
      const u = new URL(String(p || ''), learn.LEARN); // tam adres de verilebilir; site dışına çıkamaz
      if (u.origin !== learn.LEARN || !/^\/student(\/|$)/.test(u.pathname)) throw new Error('Yalnızca https://learn.ieu.edu.tr/student... sayfaları okunur');
      return htmlText(await get(u.pathname + u.search)).slice(0, MAX);
    } },
  { name: 'panopto_videos', description: 'Dersin Panopto ders kayıtları (hocanın ders anlatımı videoları): kimlik, başlık, tarih, süre (dk), altyazı var mı, izleme adresi.', inputSchema: { type: 'object', properties: { course: str('Ders kodu, ör. MCE412') }, required: ['course'] },
    run: async ({ course: q }) => {
      const c = await course(q), { jar: pj, folderId } = await panoFor(c.courseId);
      if (!folderId) return [];
      return (await panopto.sessions(pj, folderId)).map(s => ({ ...s, url: panopto.viewerUrl(s.id), cached: fs.existsSync(path.join(CACHE(), c.course, `pn-${s.id}.txt`)) }));
    } },
  { name: 'panopto_transcript', description: 'Panopto ders kaydının zaman damgalı konuşma metni ("[12:34] ..."). Altyazı yoksa ses yazıya çevrilir: uzun kayıtta dakikalar sürebilir; sonuç önbelleğe yazılır, ikinci istek anında döner.', inputSchema: { type: 'object', properties: { course: str('Ders kodu'), id: str('panopto_videos\'tan kayıt kimliği'), offset: { type: 'integer', description: 'Uzun metinde başlangıç karakteri (varsayılan 0)' } }, required: ['course', 'id'] },
    run: async ({ course: q, id, offset = 0 }) => {
      id = String(id || '').toLowerCase();
      if (!panopto.UUID.test(id)) throw new Error('geçersiz kayıt kimliği');
      const c = await course(q), out = path.join(CACHE(), c.course, `pn-${id}.txt`);
      if (!fs.existsSync(out) || !fs.statSync(out).size) {
        const { jar: pj, folderId } = await panoFor(c.courseId);
        if (!folderId || !(await panopto.sessions(pj, folderId)).some(s => s.id === id)) throw new Error('Bu kayıt dersin Panopto klasöründe yok');
        await panopto.fetchTranscript(pj, id, out, asr(env()));
      }
      const text = fs.readFileSync(out, 'utf8'), from = Math.max(0, +offset || 0), part = text.slice(from, from + MAX);
      return part + (from + MAX < text.length ? `\n\n[devamı var: offset=${from + MAX}, toplam ${text.length} karakter]` : '');
    } },
];

// Sınav sitesi ayrı giriş ister (çoğunlukla aynı hesap; farklıysa EXAM_USER/EXAM_PASS).
const EXAM = 'https://analytics.ieu.edu.tr';
async function exams({ IEU_USER, IEU_PASS, EXAM_USER, EXAM_PASS }) {
  if (!(EXAM_USER || IEU_USER) || !(EXAM_PASS || IEU_PASS)) throw new Error('Okul hesabı yok (README).');
  const j = new learn.Jar();
  const page = await (await learn.req(j, EXAM + '/sinav_programi/Login/Login')).text();
  const fd = new FormData();
  fd.set('__RequestVerificationToken', field(page, '__RequestVerificationToken'));
  fd.set('returnUrl', '');
  fd.set('kullanici_adi', EXAM_USER || IEU_USER);
  fd.set('sifre', EXAM_PASS || IEU_PASS);
  const r = await (await learn.req(j, EXAM + '/sinav_programi', { method: 'POST', body: fd })).json();
  if (!r.success) throw new Error('Sınav sitesi girişi başarısız: ' + r.errorMessage);
  return parseIcs(await (await learn.req(j, EXAM + '/sinav_programi/Ogrenci/Takvim')).text());
}

// --- MCP (JSON-RPC 2.0, satır başına bir mesaj) ---
const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
async function handle(m) {
  const { id, method, params } = m;
  if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ieulearn', version: '0.1.0' } });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const t = TOOLS.find(x => x.name === params?.name);
    if (!t) return reply(id, null, { code: -32602, message: 'bilinmeyen araç: ' + params?.name });
    try {
      const r = await t.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] });
    } catch (e) { return reply(id, { content: [{ type: 'text', text: 'Hata: ' + e.message }], isError: true }); }
  }
  if (id !== undefined) reply(id, null, { code: -32601, message: 'desteklenmiyor: ' + method }); // bildirimlere (id yok) yanıt verilmez
}

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { reply(null, null, { code: -32700, message: 'geçersiz JSON' }); continue; }
      handle(m).catch(e => m.id !== undefined && reply(m.id, null, { code: -32603, message: e.message }));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = { TOOLS, htmlText, handle };
