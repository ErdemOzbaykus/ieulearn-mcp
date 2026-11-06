const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const P = require('../lib/panopto');
const { vttToText } = require('../lib/transcribe');
const { htmlText, TOOLS } = require('../index');

const ID = '5988b11c-18c9-4f36-bce1-b4ce00d5b292';

test('vttToText: SRT -> zaman damgalı paragraflar, tekrar satırı atılır', () => {
  const srt = '1\n00:00:01,000 --> 00:00:03,000\nMerhaba\n\n2\n00:00:03,000 --> 00:00:05,000\nMerhaba\n\n3\n00:01:05,500 --> 00:01:07,000\nOhm <i>yasası</i>\n';
  assert.equal(vttToText(srt), '[0:01] Merhaba\n[1:05] Ohm yasası\n');
});

test('autoForm: LTI formunun adresi ve gizli alanları (HTML kaçışları çözülür)', () => {
  const f = P.autoForm('<form id="ltiAutoForm" action="https://panopto.ieu.edu.tr/x/login?a=1&amp;b=2" method="post"><input type="hidden" name="iss" value="https://learn.ieu.edu.tr"><input type="hidden" name="id_token" value="a&quot;b"></form>');
  assert.equal(f.action, 'https://panopto.ieu.edu.tr/x/login?a=1&b=2');
  assert.equal(f.body.get('iss'), 'https://learn.ieu.edu.tr');
  assert.equal(f.body.get('id_token'), 'a"b');
  assert.equal(P.autoForm('<p>form yok</p>'), null);
});

test('folderFrom: yönlendirmedeki ders klasörü; parseSessions: yalnızca geçerli kayıtlar', () => {
  assert.equal(P.folderFrom(['https://p/a', `https://p/EmbeddedList.aspx?embedded=1&folderID=${ID}`]), ID);
  assert.equal(P.folderFrom([`https://p/List.aspx#folderID=%22${ID}%22`]), ID);
  assert.equal(P.folderFrom(['https://p/a']), null);
  const s = P.parseSessions({ Results: [
    { DeliveryID: ID.toUpperCase(), SessionName: 'Hafta\n3', StartTime: '/Date(1724583014866)/', Duration: 2700.4, HasCaptions: true },
    { DeliveryID: '../etc', SessionName: 'kötü' },
  ] });
  assert.deepEqual(s, [{ id: ID, title: 'Hafta 3', start: '2024-08-25T10:50:14.866Z', minutes: 45, captions: true }]);
});

test('htmlText ve read_learn_page site dışına çıkmaz', async () => {
  assert.equal(htmlText('<script>x()</script><p>Merhaba&nbsp;<a href="/student/a">bağ</a></p><p>iki</p>'), 'Merhaba bağ [/student/a]\niki');
  const page = TOOLS.find(t => t.name === 'read_learn_page');
  for (const p of ['https://evil.example/student', '/login', '/studentx', '//evil.example/student']) {
    await assert.rejects(page.run({ path: p }), /Yalnızca/);
  }
});

test('MCP sunucusu: initialize ve tools/list (ağ yok)', async () => {
  const p = spawn(process.execPath, [path.join(__dirname, '../index.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  p.stdin.end();
  await new Promise(r => p.on('close', r));
  const [init, list, extra] = out.trim().split('\n').map(JSON.parse);
  assert.equal(init.result.serverInfo.name, 'ieulearn');
  assert.deepEqual(list.result.tools.map(t => t.name), ['list_courses', 'list_assignments', 'list_exams', 'course_content', 'read_learn_page', 'panopto_videos', 'panopto_transcript']);
  assert.equal(extra, undefined); // bildirime yanıt yok
});
