const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Jar, req } = require('../lib/learn');

const serve = h => new Promise(r => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r(s)); });

test('req: başka siteye yönlendirmede çerez gitmez, oradan gelen çerez alınmaz', async () => {
  let seen;
  const b = await serve((q, s) => { seen = q.headers.cookie; s.writeHead(200, { 'set-cookie': 'evil=1' }); s.end('ok'); });
  const a = await serve((q, s) => {
    if (q.url === '/go') { s.writeHead(302, { location: `http://127.0.0.1:${b.address().port}/x` }); return s.end(); }
    s.writeHead(200, { 'set-cookie': 'sid=abc; HttpOnly' }); s.end('home');
  });
  try {
    const jar = new Jar(), A = `http://127.0.0.1:${a.address().port}`;
    await (await req(jar, A + '/')).text();
    assert.equal(jar.header, 'sid=abc');
    assert.equal(await (await req(jar, A + '/go')).text(), 'ok'); // yönlendirme yine izlenir
    assert.equal(seen, undefined);
    assert.equal(jar.header, 'sid=abc');
  } finally { a.close(); b.close(); }
});

test('req allow: yönlendirme adımı izin dışıysa istek yapılmaz', async () => {
  let hit = false;
  const b = await serve((q, s) => { hit = true; s.end('gizli'); });
  const a = await serve((q, s) => { s.writeHead(302, { location: `http://127.0.0.1:${b.address().port}/x` }); s.end(); });
  try {
    const A = `http://127.0.0.1:${a.address().port}`;
    await assert.rejects(req(new Jar(), A + '/go', {}, x => x.origin === A), /izin verilmeyen/);
    assert.equal(hit, false);
  } finally { a.close(); b.close(); }
});
