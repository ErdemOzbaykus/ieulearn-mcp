// IEULearn oturumu: e-posta/şifre ile giriş, çerezler kendi kavanozunda.
const { field } = require('./parse');

const LEARN = 'https://learn.ieu.edu.tr';

// Çerez kavanozu: giriş oturumu ve csrf belirteci aynı oturuma bağlı. ua: oturum başka tarayıcıya taşınacaksa onun kimliği.
// Kavanoz ilk kullanıldığı siteye bağlanır: başka siteye çerez gönderilmez, oradan gelen çerez alınmaz.
class Jar {
  constructor(ua) { this.c = {}; this.ua = ua; }
  mine(url) { const o = new URL(url).origin; this.origin ||= o; return this.origin === o; }
  take(res, url) { if (url && !this.mine(url)) return; for (const l of res.headers.getSetCookie()) { const kv = l.split(';')[0], i = kv.indexOf('='); this.c[kv.slice(0, i).trim()] = kv.slice(i + 1); } }
  get header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join('; '); }
}
// allow(URL): her adımda (yönlendirmeler dahil) gidilecek adresi denetler; false ise istek yapılmaz.
async function req(jar, url, opt = {}, allow) {
  for (let n = 0; n < 8; n++) {
    if (allow && !allow(new URL(url))) throw new Error('izin verilmeyen adrese yönlendirme: ' + new URL(url).origin);
    const own = jar.mine(url); // site dışına yönlendirmede (ör. dosya sunucusu) çerez gitmez
    const r = await fetch(url, { ...opt, redirect: 'manual', headers: { ...opt.headers, ...(own && { cookie: jar.header }), ...(jar.ua && { 'user-agent': jar.ua }) } });
    jar.take(r, url);
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; opt = { headers: opt.headers }; continue; } // yönlendirme: GET
    return r;
  }
  throw new Error('çok fazla yönlendirme: ' + url);
}

async function loginLearn({ IEU_USER, IEU_PASS }, ua) {
  const jar = new Jar(ua);
  const page = await (await req(jar, LEARN + '/login')).text();
  const body = new URLSearchParams({ csrf_token: field(page, 'csrf_token'), email: IEU_USER, password: IEU_PASS, remember: '1' });
  await req(jar, LEARN + '/login', { method: 'POST', body, headers: { origin: LEARN, referer: LEARN + '/login' } });
  jar.home = await (await req(jar, LEARN + '/student')).text();
  if (!/Derslerim/.test(jar.home)) throw new Error('IEULearn girişi başarısız (EkoID veya şifre yanlış olabilir)');
  return jar;
}

const assignmentsFragment = jar => req(jar, LEARN + '/student/assignments/overview-fragment', { headers: { 'x-requested-with': 'XMLHttpRequest' } });

module.exports = { LEARN, Jar, req, loginLearn, assignmentsFragment };
