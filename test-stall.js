// 压力测试：全程不操作，看机器人+看门狗能否把一整局打完（不出现卡死）
const http = require('http'), crypto = require('crypto');
function conn() {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: 'localhost', port: 3000, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 } });
    req.on('upgrade', (r, s) => res(s)); req.on('error', rej); req.end();
  });
}
class W {
  constructor(s) { this.s = s; this.b = Buffer.alloc(0); this.cb = null;
    s.on('data', d => { this.b = Buffer.concat([this.b, d]); this.p(); }); s.on('error', () => {}); }
  p() { while (true) { if (this.b.length < 2) return; let l = this.b[1] & 127, o = 2;
    if (l === 126) { if (this.b.length < 4) return; l = this.b.readUInt16BE(2); o = 4; }
    if (this.b.length < o + l) return;
    const m = JSON.parse(this.b.slice(o, o + l)); this.b = this.b.slice(o + l);
    if (this.cb) this.cb(m); } }
  send(x) { const d = Buffer.from(JSON.stringify(x)); const h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | d.length;
    const m = crypto.randomBytes(4); m.copy(h, 2); this.s.write(Buffer.concat([h, Buffer.from(d.map((b, i) => b ^ m[i & 3]))])); }
  onMsg(cb) { this.cb = cb; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const c = new W(await conn());
  let last = Date.now(), lastPhase = '', roundEnd = false;
  c.onMsg(m => {
    if (m.t === 'state') { last = Date.now(); lastPhase = m.phase;
      if (m.phase === 'roundend') roundEnd = true;
      console.log('state', m.phase, 'turn=' + m.turn, 'wall=' + m.wall, m.prompt ? ('prompt=' + JSON.stringify(m.prompt.type)) : '');
      // 模拟挂机玩家：提示一律点"过"，轮到出牌就打缺门牌
      if (m.prompt) setTimeout(() => c.send({ a: 'claim', act: 'pass' }), 200);
      else if (m.myTurn && m.phase === 'play') {
        const h = m.hands[m.you];
        const t = h.find(x => (x / 10 | 0) === m.que[m.you]) !== undefined ? h.find(x => (x / 10 | 0) === m.que[m.you]) : h[0];
        setTimeout(() => c.send({ a: 'discard', tile: t }), 300);
      }
    }
    if (m.t === 'modal') console.log('modal:', m.title);
  });
  c.send({ a: 'create', rounds: 2, name: '挂机房主' });
  await sleep(300);
  c.send({ a: 'start' });
  await sleep(600);
  c.send({ a: 'que', q: 2 });
  // 挂机等 100 秒：看门狗应自动替玩家"过"，机器人把局打完或摸到玩家牌权时也自动过
  const t0 = Date.now();
  while (Date.now() - t0 < 100000) {
    await sleep(1000);
    // 挂机时也自动点"过"，模拟玩家只点过
  }
  console.log('=== 结束: 最后phase=' + lastPhase, 'roundend=' + roundEnd, '===');
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
