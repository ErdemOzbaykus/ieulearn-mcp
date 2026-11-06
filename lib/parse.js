// Okul sitelerinden gelen metni ayrıştırır (ağ yok, test edilebilir).
const decode = s => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// <input name="X" value="..."> değerini döndürür (csrf belirteci vb.)
function field(html, name) {
  const tag = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
  const v = /value="([^"]*)"/.exec(tag || '');
  if (!v) throw new Error('giriş formunda alan yok: ' + name);
  return decode(v[1]);
}

// IEULearn öğrenci ana sayfası (/student): dönem dersleri (<article class="dash-course" ...>).
function parseCourses(html) {
  const out = [];
  for (const m of html.matchAll(/<article\b[^>]*\bclass="dash-course"[^>]*>/g)) {
    const tag = m[0];
    if (/data-course-status="(?!ongoing")/.test(tag)) continue;
    const id = +(/data-course-id="(\d+)"/.exec(tag) || [])[1];
    const t = /\d{4}-\d\s+([A-Z]+)\s*(\d+)\s+(.+?)(?:\s+(?:\d+\s*-\s*)?\d+)?$/.exec(decode((/data-course-title="([^"]*)"/.exec(tag) || [])[1] || '').trim());
    if (id && t) out.push({ course: t[1] + t[2], name: t[3].trim(), courseId: id });
  }
  return out;
}

// IEULearn "Ders İçeriği": dosyalar data-rv-payload JSON'unda.
const RANK = { pdf: 0, pptx: 1, ppt: 2, docx: 3, doc: 4 };
function parsePlan(html) {
  const seen = new Map();
  for (const m of html.matchAll(/data-rv-payload="([^"]*)"/g)) {
    let p; try { p = JSON.parse(decode(m[1])); } catch { continue; }
    if (!p.id || !p.file_name || /syllabus/i.test(p.title)) continue; // syllabus çalışma kaynağı değil
    const key = p.title.trim().toLowerCase(), cur = seen.get(key);
    if (!cur || (RANK[p.file_ext] ?? 9) < (RANK[cur.file_ext] ?? 9)) seen.set(key, p); // aynı başlıkta PDF'i tercih et
  }
  return [...seen.values()];
}

// Hocanın konu açıklamasına bağlantı olarak koyduğu dosyalar (/uploads/editor-files/...), ör. MCE412'nin haftalık PPTX'leri.
// Yalnızca IEULearn'deki adresler: oturum çerezi başka siteye gitmesin.
function parseLinks(html, origin) {
  const seen = new Map();
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]*\/uploads\/editor-files\/[^"]*\.(pdf|pptx?|docx?))"[^>]*>([^<]*)<\/a>/gi)) {
    let url;
    try { url = new URL(decode(m[1]), origin); } catch { continue; }
    if (url.origin !== origin || seen.has(url.href)) continue;
    const ext = m[2].toLowerCase(), name = decode(m[3]).replace(/[\\/]/g, '-').trim() || url.pathname.split('/').pop();
    const file = name.toLowerCase().endsWith('.' + ext) ? name : `${name}.${ext}`;
    seen.set(url.href, { url: url.href, file_name: file, title: file.slice(0, -ext.length - 1) });
  }
  return [...seen.values()];
}

const MONTHS = { Oca: 1, Şub: 2, Mar: 3, Nis: 4, May: 5, Haz: 6, Tem: 7, Ağu: 8, Eyl: 9, Eki: 10, Kas: 11, Ara: 12 };

// /student/assignments/overview-fragment kartları: durum (pending|submitted|graded), başlık, ders, "Son teslim 06 Kas 2026, 23:59".
function parseAssignments(html, origin) {
  return html.split('<article').slice(1).filter(b => /data-sa-id=/.test(b)).map(b => {
    const d = /Son teslim\s+(\d{1,2})\s+(\p{L}+)\s+(\d{4}),\s*(\d{1,2}):(\d{2})/u.exec(b);
    const mon = d && MONTHS[d[2].slice(0, 3)];
    const c = /\d{4}-\d\s+([A-Z]+)\s*(\d+)/.exec(b);
    const href = /class="st-assign-link"[^>]*\bhref="([^"]+)"/.exec(b)?.[1];
    let url = null; // kartın ödev sayfası; yalnızca IEULearn içinde kalan http(s) bağlantı
    try { const x = new URL(decode(href), origin); if (x.origin === origin) url = x.href; } catch { /* bağlantı yok */ }
    return {
      url,
      id: /data-sa-id="(\d+)"/.exec(b)[1],
      status: /data-sa-group="(\w+)"/.exec(b)?.[1] || 'pending',
      title: decode((/st-assign-title">\s*([^<]*?)\s*</.exec(b) || [])[1] || ''),
      course: c ? c[1] + c[2] : '',
      due: mon ? `${d[3]}-${String(mon).padStart(2, '0')}-${d[1].padStart(2, '0')}T${d[4].padStart(2, '0')}:${d[5]}:00+03:00` : null, // İstanbul saati
    };
  });
}

// Sınav takvimi (.ics): SUMMARY "Sınav: MCE 350 ..." -> course "MCE350", zamanlar UTC.
function parseIcs(txt) {
  const flat = txt.replace(/\r?\n[ \t]/g, ''); // katlanmış satırları aç
  return flat.split('BEGIN:VEVENT').slice(1).map(b => {
    const g = k => (new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm').exec(b) || [])[1]?.trim();
    const iso = s => s && s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z');
    const m = /Sınav:\s*([A-Z]+)\s*(\d+)/.exec(g('SUMMARY') || '');
    return m && { course: m[1] + m[2], start: iso(g('DTSTART')), end: iso(g('DTEND')), room: g('LOCATION') || '' };
  }).filter(Boolean);
}

module.exports = { decode, field, parseCourses, parsePlan, parseLinks, parseAssignments, parseIcs };
