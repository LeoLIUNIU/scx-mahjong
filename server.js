// 恶搞四川麻将 · 联机版服务器（零依赖，只需 Node.js）
// 用法：node server.js  然后浏览器打开 http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const LAN_IP = (() => { // 找本机局域网 IPv4 地址
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list)
      if (n.family === 'IPv4' && !n.internal) return n.address;
  return '127.0.0.1';
})();

const SUITS = ['万', '条', '筒'];
const BOTNAMES = ['机器人老王', '机器人李婶', '机器人张三'];
const BASE = 2; // 底分
const rooms = new Map();
let seq = 100;

const server = http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else { res.writeHead(404); res.end('404'); }
});
// ---------- 极简 WebSocket 实现（仅文本帧，零依赖） ----------
function mkConn(sock, onMsg, onClose) {
  let buf = Buffer.alloc(0), open = false;
  const send = str => {
    if (sock.destroyed) return;
    const data = Buffer.from(str), len = data.length;
    let head;
    if (len < 126) { head = Buffer.from([0x81, len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    sock.write(Buffer.concat([head, data]));
  };
  const close = () => { if (!sock.destroyed) sock.end(); onClose(); };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (true) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 0x80;
      let mask = null;
      if (masked) { if (buf.length < off + 4) break; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) break;
      let payload = buf.slice(off, off + len);
      if (mask) payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
      buf = buf.slice(off + len);
      if (opcode === 1) onMsg(payload.toString('utf8'));
      else if (opcode === 8) return close();
      else if (opcode === 9) send(''); // ping→pong(空文本足够本游戏用)
    }
  });
  sock.on('close', onClose); sock.on('error', () => { sock.destroy(); onClose(); });
  return { send, sock, isClosed: () => sock.destroyed };
}
function jsend(c, o) { if (c && !c.isClosed()) c.send(JSON.stringify(o)); }

// 看门狗：每2秒检查一次，机器人该出牌而没出 → 立即补打；玩家提示超过12秒没响应 → 自动"过"
function startWatchdog(room) {
  if (room.wd) clearInterval(room.wd);
  room.wd = setInterval(() => {
    try {
      if (room.phase === 'end') return clearInterval(room.wd);
      if (room.phase === 'que') {
        // 定缺阶段真人超时15秒 → 帮他随机定缺
        if (room.queSince && Date.now() - room.queSince > 15000 && room.quePending.length) {
          room.quePending.forEach(s => { room.que[s] = Math.random() * 3 | 0; });
          bcast(room, { t: 'msg', text: '定缺超时，已自动随机定缺' });
          room.quePending = [];
          beginTurn(room, 0);
        }
        return;
      }
      if (room.phase !== 'play') return;
      if (room.prompt) {
        if (!room.prompt.since) room.prompt.since = Date.now();
        else if (Date.now() - room.prompt.since > 12000) {
          bcast(room, { t: 'msg', text: '操作超时，自动过' });
          const wasSelf = room.prompt.type === 'self';
          room.prompt = null;
          if (wasSelf) return sendState(room); // 自摸过了 → 该玩家继续出牌
          return resolveClaims(room);
        }
        return;
      }
      const p = room.players[room.turn];
      if (p && p.bot) botDiscard(room, room.turn); // 机器人卡住 → 直接补打
    } catch (e) { console.error('watchdog', e.message); }
  }, 2000);
}

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const conn = mkConn(sock, m => { try { handle(conn, JSON.parse(m)); } catch (e) {} }, () => dropPlayer(conn));
});
// 旧版 jsend(ws,o) 已由上面 conn 版本替代

// ---------------- 牌逻辑 ----------------
function count(tiles) { const c = {}; tiles.forEach(t => c[t] = (c[t] || 0) + 1); return c; }
function canHu(tiles) { // 14张（或2+3n），返回胡型或null
  const cnt = count(tiles);
  if (tiles.length % 3 === 2 && Object.values(cnt).every(v => v % 2 === 0) && Object.keys(cnt).length >= 5) {
    return Object.values(cnt).some(v => v === 4) ? '龙七对' : '七对';
  }
  if (tiles.length % 3 !== 2) return null;
  for (const t in cnt) {
    if (cnt[t] >= 2) {
      cnt[t] -= 2;
      const ok = win(cnt);
      cnt[t] += 2;
      if (ok) return '平胡';
    }
  }
  return null;
}
function win(cnt) {
  for (const k in cnt) {
    if (cnt[k] > 0) {
      const t = +k;
      if (cnt[t] >= 3) {
        cnt[t] -= 3;
        const ok = win(cnt);
        cnt[t] += 3;
        return ok;
      }
      const n = t % 10;
      if (n > 7 || !(cnt[t + 1] > 0 && cnt[t + 2] > 0)) return false;
      cnt[t]--; cnt[t + 1]--; cnt[t + 2]--;
      const ok = win(cnt);
      cnt[t]++; cnt[t + 1]++; cnt[t + 2]++;
      return ok;
    }
  }
  return true;
}
function hasQue(tiles, q) { return tiles.some(t => (t / 10 | 0) === q); }
function calcFan(hand, melds, huType, selfDraw) {
  let fan = huType === '平胡' ? 1 : 4;
  const suits = new Set(hand.map(t => t / 10 | 0));
  if (suits.size === 1 && melds.length === 0) fan *= 4;
  if (huType === '龙七对') fan *= 2;
  if (selfDraw) fan *= 2;
  return fan;
}

// ---------------- 房间 ----------------
function mkRoom(code, rounds) {
  return {
    code, rounds, round: 1, phase: 'wait', cheat: false,
    scores: [0, 0, 0, 0], names: ['-', '-', '-', '-'],
    players: [null, null, null, null],
    hands: [[], [], [], []], melds: [[], [], [], []], out: [[], [], [], []],
    huOut: [false, false, false, false], que: [0, 0, 0, 0],
    wall: [], turn: 0, prompt: null, lastDrawnSeat: -1, lastTile: null,
  };
}
function seatOf(room, ws) { return room.players.findIndex(p => p && !p.bot && p.ws === ws); }
function roomOf(ws) { for (const r of rooms.values()) if (seatOf(r, ws) >= 0) return r; return null; }
function send(p, o) { if (p && !p.bot && p.ws && !p.ws.isClosed()) p.ws.send(JSON.stringify(o)); }
function bcast(room, o) { room.players.forEach(p => send(p, o)); }
function alive(room) { return [0, 1, 2, 3].filter(i => !room.huOut[i]); }
function tileStr(t) { return (t % 10) + SUITS[t / 10 | 0]; }

function joinSeat(room, seat, ws, name) {
  const old = room.players[seat];
  if (old && !old.bot) send(old, { t: 'err', text: '你的位置被顶替了' });
  room.players[seat] = { ws, name, bot: false };
  room.names[seat] = name;
}
function dropPlayer(ws) {
  const room = roomOf(ws); if (!room) return;
  const s = seatOf(room, ws);
  if (s < 0) return;
  room.players[s] = { bot: true, name: room.names[s] + '(掉线AI)' };
  bcast(room, { t: 'msg', text: room.names[s] + ' 掉线，AI接管' });
  if (room.phase === 'play' || room.phase === 'que') tick(room);
}
function fillBots(room) {
  const BN = ['机器人老王', '机器人李婶', '机器人张三', '机器人赵六'];
  room.players.forEach((p, i) => { if (!p) { room.players[i] = { bot: true, name: BN[i] || ('机器人' + (i + 1)) }; room.names[i] = room.players[i].name; } });
}
function lobbyState(room) {
  bcast(room, { t: 'lobby', code: room.code, rounds: room.rounds, names: room.names, started: room.phase !== 'wait', lanIp: LAN_IP, port: PORT });
}

// ---------------- 消息入口 ----------------
function handle(ws, msg) {
  if (msg.a === 'create') {
    const code = (++seq).toString(36).toUpperCase();
    const room = mkRoom(code, msg.rounds === 8 ? 8 : 4);
    rooms.set(code, room);
    joinSeat(room, 0, ws, (msg.name || '房主').slice(0, 8));
    jsend(ws, { t: 'room', code, rounds: room.rounds, you: 0, lanIp: LAN_IP, port: PORT });
    lobbyState(room);
  } else if (msg.a === 'join') {
    const room = rooms.get((msg.code || '').trim().toUpperCase());
    if (!room) return jsend(ws, { t: 'err', text: '房间不存在' });
    if (room.phase !== 'wait') {
      // 游戏进行中：允许顶替一个机器人座位加入
      const seat = room.players.findIndex(p => p && p.bot && !p.human);
      if (seat < 0) return jsend(ws, { t: 'err', text: '房间已满（没有机器人座位了）' });
      room.players[seat] = { ws, name: (msg.name || '玩家' + (seat + 1)).slice(0, 8), bot: false };
      room.names[seat] = room.players[seat].name;
      jsend(ws, { t: 'room', code: room.code, rounds: room.rounds, you: seat, lanIp: LAN_IP, port: PORT });
      bcast(room, { t: 'msg', text: room.names[seat] + ' 加入，顶替了机器人' });
      sendState(room);
      return;
    }
    const seat = room.players.findIndex(p => !p);
    if (seat < 0) return jsend(ws, { t: 'err', text: '房间已满' });
    joinSeat(room, seat, ws, (msg.name || '玩家' + (seat + 1)).slice(0, 8));
    jsend(ws, { t: 'room', code: room.code, rounds: room.rounds, you: seat, lanIp: LAN_IP, port: PORT });
    lobbyState(room);
  }
  const room = roomOf(ws); if (!room) return;
  const me = seatOf(room, ws);

  if (msg.a === 'start' && me === 0 && room.phase === 'wait') {
    fillBots(room); startRound(room);
  } else if (msg.a === 'que' && room.phase === 'que' && room.quePending && room.quePending.includes(me)) {
    let q = [0, 1, 2].includes(msg.q) ? msg.q : 0;
    if (room.cheat && me === 0) q = 0; // 恶搞局房主定缺强制万（手牌全是筒）
    room.que[me] = q;
    room.quePending = room.quePending.filter(s => s !== me);
    bcast(room, { t: 'msg', text: room.names[me] + ' 定缺 ' + SUITS[q] });
    if (!room.quePending.length) beginTurn(room, 0);
  } else if (msg.a === 'discard' && room.phase === 'play' && me === room.turn && !room.prompt) {
    const h = room.hands[me];
    const i = h.indexOf(msg.tile);
    if (i >= 0) { h.splice(i, 1); afterDiscard(room, me, msg.tile); }
  } else if (msg.a === 'claim' && room.prompt && room.prompt.seats.includes(me)) {
    const pr = room.prompt;
    if (msg.act !== 'pass' && !pr.opts[me][msg.act]) return;
    if (pr.type === 'self') { // 自摸提示：过 → 继续自己出牌
      room.prompt = null;
      if (msg.act === 'hu') return doHu(room, me, true);
      return sendState(room);
    }
    if (msg.act !== 'pass') pr.claims.push({ seat: me, act: msg.act });
    pr.seats = pr.seats.filter(s => s !== me);
    if (!pr.seats.length) { room.prompt = null; resolveClaims(room); }
    else sendState(room);
  } else if (msg.a === 'next' && me === 0 && room.phase === 'roundend') {
    if (room.round >= room.rounds) {
      let champ = 0; room.scores.forEach((s, i) => { if (s > room.scores[champ]) champ = i; });
      const prank = champ === 0 ? `<div class="bigtext">房主获胜秘诀：最后一局暗改牌 😈</div>` : '';
      bcast(room, {
        t: 'modal', title: '🏆 全场结束 🏆', html:
          room.scores.map((s, i) => `<div class="bigtext">${room.names[i]}：${s} 分</div>`).join('') +
          `<div class="fan">冠军：${room.names[champ]}</div>` + prank, btn: '再来一场'
      });
      room.phase = 'end';
    } else { room.round++; startRound(room); }
  }
}

// ---------------- 一局流程 ----------------
function startRound(room) {
  room.cheat = (room.round === room.rounds); // 恶搞：最后一局房主必赢最大倍数
  room.phase = 'que';
  startWatchdog(room); // 看门狗：防止机器人卡住不出牌 / 玩家提示无人响应
  room.melds = [[], [], [], []]; room.out = [[], [], [], []];
  room.huOut = [false, false, false, false];
  room.prompt = null; room.lastTile = null;
  const wall = [];
  for (let s = 0; s < 3; s++) for (let n = 1; n <= 9; n++) for (let c = 0; c < 4; c++) wall.push(s * 10 + n);
  for (let i = wall.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [wall[i], wall[j]] = [wall[j], wall[i]]; }
  room.hands = [0, 1, 2, 3].map(() => wall.splice(0, 13));
  if (room.cheat) room.hands[0] = [22, 22, 22, 22, 23, 23, 24, 24, 25, 25, 26, 26, 29]; // 清一色龙七对·天胡(筒)
  room.hands.forEach(h => h.sort((a, b) => a - b));
  room.wall = wall;
  // 定缺：机器人随机，真人弹窗选
  room.quePending = [];
  room.queSince = Date.now();
  room.players.forEach((p, i) => {
    if (p.bot) {
      if (room.cheat && i === 0) room.que[0] = 0;
      else room.que[i] = Math.random() * 3 | 0;
    } else room.quePending.push(i);
  });
  if (room.cheat) {
    bcast(room, {
      t: 'modal', title: '最后一局', html:
        `🎉 恭喜房主触发隐藏福利！<br><span class='fan'>【天胡 · 清一色龙七对 · 32番】</span><br>系统：检测到房主充值信仰+999`,
      btn: '开始'
    });
  }
  sendState(room);
  if (!room.quePending.length) beginTurn(room, 0);
}

function beginTurn(room, seat, skipDraw) {
  if (room.phase !== 'play' && room.phase !== 'que') return;
  room.phase = 'play';
  if (alive(room).length <= 1 || !room.wall.length) return endRound(room, '流局');
  room.turn = seat; room.lastTile = null;
  if (!skipDraw) {
    let tile;
    if (room.cheat && seat === 0) tile = 29; // 恶搞：房主摸到的“神之一手”
    else tile = room.wall.pop();
    if (tile === undefined) return endRound(room, '流局');
    room.hands[seat].push(tile);
    room.lastTile = tile;
    if (room.cheat && seat === 0 && room.round === room.rounds) {
      sendState(room);
      bcast(room, { t: 'msg', text: '房主摸到 9筒 ……这手感不对劲' });
      return setTimeout(() => doHu(room, 0, true), 1500);
    }
  }
  const h = room.hands[seat];
  const p = room.players[seat];
  if (!skipDraw && h.length % 3 === 2) {
    const huType = canHu(h.slice());
    const huOK = huType && !hasQue(h, room.que[seat]);
    if (huOK) {
      if (p.bot) return doHu(room, seat, true);
      room.prompt = { type: 'self', seats: [seat], opts: { [seat]: { hu: true } }, claims: [] };
      bcast(room, { t: 'msg', text: room.names[seat] + ' 摸牌后沉默了……' });
      return sendState(room);
    }
  }
  if (p.bot) { sendState(room); setTimeout(() => botDiscard(room, seat), 800); }
  else sendState(room);
}

function botDiscard(room, seat) {
  if (room.phase !== 'play' || room.turn !== seat || room.prompt) return;
  const h = room.hands[seat];
  let d = h.find(t => (t / 10 | 0) === room.que[seat]);
  if (d === undefined) d = h[Math.random() * h.length | 0];
  h.splice(h.indexOf(d), 1);
  bcast(room, { t: 'msg', text: room.names[seat] + ' 打出 ' + tileStr(d) });
  afterDiscard(room, seat, d);
}

function afterDiscard(room, seat, tile) {
  room.out[seat].push(tile);
  const claims = [], seats = [], opts = {};
  for (let k = 1; k <= 3; k++) {
    const q = (seat + k) % 4;
    if (room.huOut[q]) continue;
    const h = room.hands[q];
    const c = h.filter(x => x === tile).length;
    const o = {};
    if (canHu(h.concat(tile)) && !hasQue(h.concat(tile), room.que[q])) o.hu = true;
    if (c === 3) o.gang = true;
    if (c === 2) o.peng = true;
    if (!Object.keys(o).length) continue;
    if (room.players[q].bot) {
      if (o.hu) claims.push({ seat: q, act: 'hu' });
      else if (o.gang && Math.random() < .7) claims.push({ seat: q, act: 'gang' });
      else if (o.peng && Math.random() < .5) claims.push({ seat: q, act: 'peng' });
    } else { seats.push(q); opts[q] = o; }
  }
  if (!seats.length) return resolveClaims(room, claims);
  room.prompt = { type: 'claim', seats, opts, claims, tile, from: seat };
  sendState(room);
}

function resolveClaims(room, claims) {
  const pending = room.prompt; room.prompt = null;
  if (pending && pending.type === 'claim') claims = claims.concat(pending.claims);
  const hu = claims.find(c => c.act === 'hu');
  const gang = claims.find(c => c.act === 'gang');
  const peng = claims.find(c => c.act === 'peng');
  let tile = null, from = null;
  if (pending && pending.type === 'claim') { tile = pending.tile; from = pending.from; }
  else if (room.out[room.turn].length) { tile = room.out[room.turn][room.out[room.turn].length - 1]; from = room.turn; }
  if (hu && tile !== null) return doHu(room, hu.seat, false, tile);
  if (gang && tile !== null) {
    const q = gang.seat, h = room.hands[q];
    room.out[from].pop();
    for (let r = 0; r < 3; r++) h.splice(h.indexOf(tile), 1);
    room.melds[q].push([tile, tile, tile, tile]);
    bcast(room, { t: 'msg', text: room.names[q] + ' 杠了 ' + tileStr(tile) + '！' });
    return beginTurn(room, q);
  }
  if (peng && tile !== null) {
    const q = peng.seat, h = room.hands[q];
    room.out[from].pop();
    for (let r = 0; r < 2; r++) h.splice(h.indexOf(tile), 1);
    room.melds[q].push([tile, tile, tile]);
    bcast(room, { t: 'msg', text: room.names[q] + ' 碰了 ' + tileStr(tile) });
    room.turn = q;
    if (room.players[q].bot) { sendState(room); setTimeout(() => botDiscard(room, q), 800); }
    else sendState(room); // 真人碰完直接出牌（不再摸牌）
    return;
  }
  // 无人要牌 → 下家
  let q = room.turn, n = 0;
  do { q = (q + 1) % 4; n++; } while (room.huOut[q] && n < 5);
  if (n >= 5 || !alive(room).length) return endRound(room, '流局');
  beginTurn(room, q);
}

function doHu(room, seat, selfDraw, tile) {
  const h = room.hands[seat];
  let huType = selfDraw ? canHu(h.slice()) : canHu(h.concat(tile));
  let fan = calcFan(h, room.melds[seat], huType || '平胡', selfDraw);
  if (room.cheat && seat === 0) { huType = '清一色龙七对 · 天胡'; fan = 32; }
  const others = alive(room).filter(i => i !== seat);
  others.forEach(i => room.scores[i] -= fan * BASE);
  room.scores[seat] += fan * BASE * others.length;
  room.huOut[seat] = true;
  room.phase = 'roundend'; room.prompt = null;
  const isMeCheat = room.cheat && seat === 0;
  let html;
  if (isMeCheat) {
    html = `<div class="bigtext">🏆 房主觉醒 · 神仙手段 🏆</div>
      <div class="bigtext">【${huType}】</div><div class="fan">${fan} 番 × ${others.length}家 = +${fan * BASE * others.length}分</div>
      <div class="bigtext">AI们：？？？<br>老王：这绝对有猫腻！<br>李婶：我不玩了我要报警！<br>张三：房主你出千！！</div>
      <div style="font-size:13px;opacity:.7">(本恶搞游戏：最后一局房主必赢最大倍数 😏)</div>`;
  } else {
    html = `<div class="bigtext">${room.names[seat]} ${selfDraw ? '自摸' : '胡 ' + tileStr(tile)} 【${huType}】</div>
      <div class="fan">${fan} 番 · 得 ${fan * BASE * others.length} 分</div>`;
  }
  sendState(room);
  bcast(room, {
    t: 'modal', title: seat === 0 ? '🎉 房主赢了！' : '💀 ' + room.names[seat] + ' 胡了',
    html, btn: null
  });
  bcast(room, { t: 'roundend', hostNext: true });
}
function endRound(room, reason) {
  room.phase = 'roundend'; room.prompt = null;
  sendState(room);
  bcast(room, { t: 'modal', title: '本局结束', html: `<div class="bigtext">${reason}，荒庄不计分</div>`, btn: null });
  bcast(room, { t: 'roundend', hostNext: true });
}

// ---------------- 同步状态给每个真人 ----------------
function sendState(room) {
  room.players.forEach((p, i) => {
    if (!p || p.bot) return;
    const myPrompt = room.phase === 'que' && room.quePending && room.quePending.includes(i)
      ? { type: 'que', opts: { que: true } }
      : room.prompt && room.prompt.seats.includes(i) ? { opts: room.prompt.opts[i], type: room.prompt.type } : null;
    send(p, {
      t: 'state', phase: room.phase, round: room.round, rounds: room.rounds,
      scores: room.scores, names: room.names, que: room.que,
      hands: room.hands.map((h, k) => k === i ? h : h.length),
      melds: room.melds, out: room.out, huOut: room.huOut,
      turn: room.turn, prompt: myPrompt,
      myTurn: room.turn === i && room.phase === 'play' && !room.prompt,
      lastTile: room.lastTile, wall: room.wall.length, you: i, host: 0,
    });
  });
}
function tick(room) { // 掉线AI接管后继续推进
  if (room.phase === 'play' && !room.prompt) {
    const p = room.players[room.turn];
    if (p && p.bot) botDiscard(room, room.turn);
  } else if (room.phase === 'que' && room.quePending) {
    room.quePending = room.quePending.filter(s => !room.players[s].bot);
    if (!room.quePending.length) beginTurn(room, 0);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('麻将服务器已启动: http://localhost:' + PORT + '  局域网地址: http://' + LAN_IP + ':' + PORT));
