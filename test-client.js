// 联机流程自动化测试：模拟房主创建房间、开始、定缺
const http = require('http');
const crypto = require('crypto');
const host = 'localhost', port = 3000;

function connect() {
  return new Promise((res, rej) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host, port, path: '/', headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 } });
    req.on('upgrade', (r, sock) => res(sock));
    req.on('error', rej);
    req.end();
  });
}
function mk(sock) {
  const q = [];
  let wait = null;
  sock.on('data', () => {}); // 占位，下面手动解析
  const pending = [];
  return {
    send(o) {
      const data = Buffer.from(JSON.stringify(o));
      const head = Buffer.alloc(2 + 4);
      head[0] = 0x81; head[1] = 0x80 | data.length;
      const mask = crypto.randomBytes(4); mask.copy(head, 2);
      const masked = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
      sock.write(Buffer.concat([head, masked]));
    },
    onMsg(cb) { this._cb = cb; this._drain(); },
    _buf: Buffer.alloc(0),
    _drain() { if (this._cb) while (pending.length) this._cb(pending.shift()); },
    pushParse() {},
  };
}
// 简化：直接用原始 socket + 帧解析
class WSock {
  constructor(sock) { this.sock = sock; this.buf = Buffer.alloc(0); this.cb = null; this.queue = [];
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('error', () => {}); }
  parse() {
    while (true) {
      if (this.buf.length < 2) return;
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const p = this.buf.slice(off, off + len); this.buf = this.buf.slice(off + len);
      const msg = JSON.parse(p.toString());
      if (this.cb) this.cb(msg); else this.queue.push(msg);
    }
  }
  send(o) {
    const data = Buffer.from(JSON.stringify(o));
    const head = Buffer.alloc(6); head[0] = 0x81; head[1] = 0x80 | data.length;
    const mask = crypto.randomBytes(4); mask.copy(head, 2);
    this.sock.write(Buffer.concat([head, Buffer.from(data.map((b, i) => b ^ mask[i & 3]))]));
  }
  onMsg(cb) { this.cb = cb; while (this.queue.length) cb(this.queue.shift()); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const sock = await connect();
  const c = new WSock(sock);
  let log = [];
  c.onMsg(m => { if (m.t === 'state') console.log('state phase=' + m.phase, 'prompt=' + JSON.stringify(m.prompt), 'myTurn=' + m.myTurn); else log.push(m.t + ':' + JSON.stringify(m).slice(0, 150)); });
  c.send({ a: 'create', rounds: 4, name: '测试房主' });
  await sleep(500);
  c.send({ a: 'start' });
  await sleep(800);
  console.log('=== 收到的消息 ==='); log.forEach(l => console.log(l));
  // 尝试定缺
  c.send({ a: 'que', q: 1 });
  await sleep(1000);
  console.log('=== 定缺后 ==='); log.slice(-6).forEach(l => console.log(l));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
