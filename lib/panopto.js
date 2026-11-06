// Panopto ders kayıtları: IEULearn'deki "Panopto" aracı LTI 1.3 ile panopto.ieu.edu.tr'ye girer.
// Akış: /lti/course-launch formu -> Panopto login -> IEULearn /lti/auth (id_token formu) -> Panopto oturumu (.ASPXAUTH).
// Her sitenin çerezi kendi kavanozunda: IEULearn oturumu Panopto'ya, Panopto'nunki IEULearn'e gitmez; başka siteye hiç gidilmez.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LEARN, Jar } = require('./learn');
const { decode } = require('./parse');

const PANOPTO = 'https://panopto.ieu.edu.tr';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// jars: { host: Jar }. Yönlendirmeleri site değiştirse de izler; listede olmayan siteye gitmez.
async function hop(jars, url, opt = {}) {
  for (let n = 0; n < 10; n++) {
    const jar = jars[new URL(url).host];
    if (!jar) throw new Error('beklenmeyen adrese yönlendirme: ' + new URL(url).host);
    const r = await fetch(url, { ...opt, redirect: 'manual', headers: { ...opt.headers, cookie: jar.header }, signal: AbortSignal.timeout(30000) });
    jar.take(r, url);
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { (jars.seen ||= []).push(url); url = new URL(loc, url).href; opt = {}; continue; }
    (jars.seen ||= []).push(url);
    return { r, url, text: await r.text() };
  }
  throw new Error('çok fazla yönlendirme: ' + url);
}

// Kendini gönderen LTI formu: { action, body } ya da null.
function autoForm(html) {
  const f = /<form\b[^>]*\baction="([^"]+)"[^>]*\bmethod="post"/i.exec(html);
  if (!f) return null;
  const body = new URLSearchParams();
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const n = /\bname="([^"]+)"/.exec(m[0]), v = /\bvalue="([^"]*)"/.exec(m[0]);
    if (n) body.set(decode(n[1]), decode(v?.[1] || ''));
  }
  return { action: decode(f[1]), body };
}

// Yönlendirilen adreslerden dersin Panopto klasörü (EmbeddedList.aspx?folderID=...).
const folderFrom = urls => urls.map(u => /folderID=(?:%22)?([0-9a-f-]{36})/i.exec(u)?.[1]).find(Boolean) || null;

// learnJar: loginLearn() oturumu. Döner: { jar: Panopto oturumu, folderId } (ders klasörü yoksa folderId null).
async function launch(learnJar, courseId) {
  const pj = new Jar(), jars = { [new URL(LEARN).host]: learnJar, [new URL(PANOPTO).host]: pj };
  let { url, text } = await hop(jars, `${LEARN}/lti/course-launch?course=${+courseId}&tool=3&as=learner`);
  for (let i = 0; i < 3; i++) { // yalnızca IEULearn'in verdiği LTI formları gönderilir (Panopto sayfalarındaki ASP.NET formları değil)
    const f = new URL(url).origin === LEARN && autoForm(text);
    if (!f) break;
    ({ url, text } = await hop(jars, new URL(f.action, url).href, { method: 'POST', body: f.body }));
  }
  if (!pj.c['.ASPXAUTH']) throw new Error('Panopto oturumu açılamadı (bu derste Panopto olmayabilir)');
  return { jar: pj, folderId: folderFrom(jars.seen) };
}

const api = (pj, p, body) => fetch(PANOPTO + '/Panopto' + p, {
  method: 'POST', headers: { cookie: pj.header, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
}).then(async r => { if (!r.ok) throw new Error(`Panopto ${p} ${r.status}`); return r.json(); });

const msDate = s => { const m = /\/Date\((\d+)/.exec(s || ''); return m ? new Date(+m[1]).toISOString() : null; };

// Klasördeki kayıtlar, eskiden yeniye: { id (DeliveryID), title, start, minutes, captions }
async function sessions(pj, folderId) {
  if (!UUID.test(folderId || '')) throw new Error('geçersiz Panopto klasörü');
  const q = { query: null, sortColumn: 1, sortAscending: true, maxResults: 250, page: 0, startDate: null, endDate: null, folderID: folderId, bookmarked: false, getFolderData: false, isSharedWithMe: false, isSubscriptionsPage: false, includeArchived: true, includeArchivedStateCount: false, sessionListOnlyArchived: false, includePlaylists: false };
  return parseSessions((await api(pj, '/Services/Data.svc/GetSessions', { queryParameters: q })).d);
}
const parseSessions = d => (d?.Results || []).filter(x => UUID.test(x.DeliveryID || '')).map(x => ({
  id: x.DeliveryID.toLowerCase(), title: String(x.SessionName || 'Ders kaydı').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120),
  start: msDate(x.StartTime), minutes: Math.round((x.Duration || 0) / 60), captions: !!x.HasCaptions,
}));

// Kaydın altyazısı (SRT) — yoksa boş metin.
async function captions(pj, id) {
  if (!UUID.test(id)) throw new Error('geçersiz Panopto kimliği');
  const r = await fetch(`${PANOPTO}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${id}&language=0`, { headers: { cookie: pj.header }, signal: AbortSignal.timeout(60000) });
  const t = r.ok ? await r.text() : '';
  return /-->/.test(t) ? t : '';
}

// Oynatılabilir akış adresi (HLS/MP4); ses yazıya çevrilirken ffmpeg bunu çerezle okur.
async function streamUrl(pj, id) {
  if (!UUID.test(id)) throw new Error('geçersiz Panopto kimliği');
  const r = await fetch(`${PANOPTO}/Panopto/Pages/Viewer/DeliveryInfo.aspx`, {
    method: 'POST', headers: { cookie: pj.header, 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30000),
    body: new URLSearchParams({ deliveryId: id, isEmbed: 'true', responseType: 'json' }),
  });
  const j = await r.json().catch(() => ({}));
  const d = j.Delivery || {}, all = [...(d.PodcastStreams || []), ...(d.Streams || [])];
  const u = all.map(s => s.StreamUrl).find(u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } });
  if (!u) throw new Error(j.ErrorMessage || 'Panopto kaydının akışı bulunamadı');
  return u;
}

const viewerUrl = (id, sec = 0) => `${PANOPTO}/Panopto/Pages/Viewer.aspx?id=${id}${sec ? `&start=${sec}` : ''}`;
const ffHeaders = pj => ['-headers', `Cookie: ${pj.header}\r\n`]; // ffmpeg akışı oturum çereziyle okur

// Kaydı zaman damgalı metne çevirir (YouTube'la aynı biçim): önce Panopto altyazısı, yoksa ses konuşma tanımayla yazıya çevrilir.
// asr: { base, key, model } (lib/transcribe.js)
async function fetchTranscript(pj, id, outFile, asr) {
  const { vttToText, audioToText } = require('./transcribe');
  const srt = await captions(pj, id);
  const text = srt && vttToText(srt);
  if (text?.trim()) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, text); return { lang: 'altyazı' }; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lecting-pn-'));
  try { await audioToText(await streamUrl(pj, id), ffHeaders(pj), tmp, outFile, asr); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { lang: 'ses' };
}

module.exports = { PANOPTO, UUID, launch, sessions, parseSessions, captions, streamUrl, viewerUrl, ffHeaders, fetchTranscript, autoForm, folderFrom };
