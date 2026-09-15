// 测试：房主开局后，第二个玩家中途加入顶替机器人 + 完整打几轮
const http = require('http'), crypto = require('crypto');
function conn() {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: 'localhost', port: 3000, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 } });
    req.on('upgrade', (r, s) => res(s)); req.on('error', rej); req.end();
  });
}
class W {
  constructor(s) { this.s = s; this.b = Buffer.alloc(0); this.cb = null; this.q = [];
    s.on('data', d => { this.b = Buffer.concat([this.b, d]); this.p(); }); s.on('error', () => {}); }
  p() { while (true) { if (this.b.length < 2) return; let l = this.b[1] & 127, o = 2;
    if (l === 126) { if (this.b.length < 4) return; l = this.b.readUInt16BE(2); o = 4; }
    if (this.b.length < o + l) return;
    const m = JSON.parse(this.b.slice(o, o + l)); this.b = this.b.slice(o + l);
    if (this.cb) this.cb(m); else this.q.push(m); } }
  send(x) { const d = Buffer.from(JSON.stringify(x)); const h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | d.length;
    const m = crypto.randomBytes(4); m.copy(h, 2); this.s.write(Buffer.concat([h, Buffer.from(d.map((b, i) => b ^ m[i & 3]))])); }
  onMsg(cb) { this.cb = cb; while (this.q.length) cb(this.q.shift()); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const host = new W(await conn());
  let code = '', state = null;
  host.onMsg(m => {
    if (m.t === 'room') code = m.code;
    if (m.t === 'state') { state = m; console.log('[房主] phase=' + m.phase, 'turn=' + m.turn, 'prompt=' + JSON.stringify(m.prompt), 'names=' + m.names.join(',')); }
  });
  host.send({ a: 'create', rounds: 4, name: '房主' });
  await sleep(300);
  host.send({ a: 'start' });
  await sleep(500);
  // 房主定缺
  host.send({ a: 'que', q: 0 });
  await sleep(1000);
  // 朋友中途加入
  const guest = new W(await conn());
  guest.onMsg(m => { if (m.t === 'state') console.log('[朋友] 加入成功 you=' + m.you, 'phase=' + m.phase, 'handLen=' + (Array.isArray(m.hands[m.you]) ? m.hands[m.you].length : '?')); else if (m.t === 'room') console.log('[朋友] room you=' + m.you); else if (m.t === 'err') console.log('[朋友] 错误: ' + m.text); });
  guest.send({ a: 'join', code, name: '小明' });
  await sleep(1000);
  // 房主出牌（如果有牌可出）
  if (state && state.phase === 'play' && state.myTurn && Array.isArray(state.hands[state.you])) {
    const nonQue = state.hands[state.you].find(t => (t / 10 | 0) !== state.que[state.you]);
    const tile = nonQue !== undefined ? nonQue : state.hands[state.you][0];
    console.log('[房主] 出牌 ' + tile);
    host.send({ a: 'discard', tile });
    await sleep(2000);
    console.log('--- 出牌后房主最新状态 ---');
  }
  await sleep(1500);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
