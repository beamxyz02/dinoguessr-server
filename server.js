#!/usr/bin/env node
'use strict';

/*
 * DinoGuessr Multiplayer relay server.
 *
 * Deliberately small: this only coordinates a 2-player lobby and relays
 * "round complete" events between the two players. The creature database
 * lives in the browser (same as before) — the server never sees dinosaur
 * data, it only passes along a seed + round index + guess/time numbers.
 * There's no per-frame game loop, because nothing here needs one.
 */

const http = require('http');
const crypto = require('crypto');
const url = require('url');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 2;
const MAX_FRAME_BYTES = 16 * 1024;      // messages here are tiny; generous but capped
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const STALE_ROOM_MS = 2 * 60 * 60 * 1000; // sweep abandoned rooms after 2h

const rooms = new Map(); // code -> room

/* ---------------- helpers ---------------- */
function id(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function safeName(v) { return String(v || 'Player').replace(/[<>]/g, '').trim().slice(0, 20) || 'Player'; }

function finiteNumber(v, fallback = 0, min = -Infinity, max = Infinity) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/* ---------------- room state ---------------- */
function makeRoom(code, hostClient) {
  return {
    code,
    players: [hostClient],
    hostId: hostClient.id,
    started: false,
    totalRounds: 5,
    createdAt: Date.now()
  };
}

function lobbyState(room) {
  return {
    type: 'lobby_state',
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    maxPlayers: MAX_PLAYERS,
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  };
}

function broadcast(room, obj, exclude) {
  for (const p of room.players) {
    if (p !== exclude) send(p, obj);
  }
}

function send(client, obj) {
  if (!client || !client.socket || client.socket.destroyed || !client.socket.writable) return false;
  try {
    const data = Buffer.from(JSON.stringify(obj));
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    client.socket.write(Buffer.concat([header, data]));
    return true;
  } catch (e) { return false; }
}

function removeFromRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (room) {
    room.players = room.players.filter(p => p !== client);
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      if (room.hostId === client.id) room.hostId = room.players[0].id;
      broadcast(room, { type: 'opponent_left', name: client.name });
      send(client, { ...lobbyState(room), yourId: client.id });
      broadcast(room, lobbyState(room), client);
    }
  }
  client.room = null;
}

/* ---------------- message handling ---------------- */
function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'create_lobby') {
    if (client.room) removeFromRoom(client);
    client.name = safeName(msg.name);
    const code = makeRoomCode();
    const room = makeRoom(code, client);
    rooms.set(code, room);
    client.room = code;
    send(client, lobbyState(room));
    return;
  }

  if (msg.type === 'join_lobby') {
    const code = String(msg.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { send(client, { type: 'error', message: 'Room not found.' }); return; }
    if (room.started) { send(client, { type: 'error', message: 'That match already started.' }); return; }
    if (room.players.length >= MAX_PLAYERS) { send(client, { type: 'error', message: 'Room is full.' }); return; }
    if (client.room) removeFromRoom(client);
    client.name = safeName(msg.name);
    room.players.push(client);
    client.room = code;
    send(client, { ...lobbyState(room), yourId: client.id });
    broadcast(room, lobbyState(room), client);
    return;
  }

  // everything past this point requires the client to already be in a room
  const room = client.room ? rooms.get(client.room) : null;
  if (!room) return;

  if (msg.type === 'start_game') {
    if (client.id !== room.hostId) return;          // only the host starts the match
    if (room.players.length < MAX_PLAYERS) return;   // wait for the second player
    if (room.started) return;
    room.started = true;
    room.totalRounds = [5, 10].includes(Number(msg.totalRounds)) ? Number(msg.totalRounds) : 5;
    broadcast(room, {
      type: 'game_start',
      seed: Math.floor(finiteNumber(msg.seed, Date.now(), 0, 999999999)),
      category: ['dino', 'ptero', 'marine'].includes(msg.category) ? msg.category : 'dino',
      totalRounds: room.totalRounds
    });
    return;
  }

  if (msg.type === 'round_complete') {
    broadcast(room, {
      type: 'opponent_round_complete',
      fromId: client.id,
      name: client.name,
      roundIndex: Math.floor(finiteNumber(msg.roundIndex, 0, 0, 999)),
      guesses: Math.floor(finiteNumber(msg.guesses, 0, 0, 999)),
      time: Math.floor(finiteNumber(msg.time, 0, 0, 86400))
    }, client);
    return;
  }

  if (msg.type === 'leave_lobby') {
    removeFromRoom(client);
    return;
  }
}

/* ---------------- raw WebSocket framing ---------------- */
function decodeFrames(client, chunk) {
  if (!Buffer.isBuffer(chunk) || !chunk.length) return;
  client.lastSeen = Date.now();
  client.buffer = client.buffer ? Buffer.concat([client.buffer, chunk]) : chunk;
  if (client.buffer.length > MAX_FRAME_BYTES * 2) { client.socket.destroy(); return; }

  let offset = 0;
  while (client.buffer.length - offset >= 2) {
    const b0 = client.buffer[offset];
    const opcode = b0 & 0x0f;
    const b1 = client.buffer[offset + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let header = 2;
    if (len === 126) {
      if (client.buffer.length - offset < 4) break;
      len = client.buffer.readUInt16BE(offset + 2); header = 4;
    } else if (len === 127) {
      if (client.buffer.length - offset < 10) break;
      const big = client.buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_FRAME_BYTES)) { client.socket.destroy(); return; }
      len = Number(big); header = 10;
    }
    if (len > MAX_FRAME_BYTES) { client.socket.destroy(); return; }
    const maskBytes = masked ? 4 : 0;
    if (client.buffer.length - offset < header + maskBytes + len) break;

    let payload = client.buffer.subarray(offset + header + maskBytes, offset + header + maskBytes + len);
    if (masked) {
      const mask = client.buffer.subarray(offset + header, offset + header + 4);
      payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    }
    offset += header + maskBytes + len;

    if (opcode === 0x8) { client.socket.end(); return; }   // close
    if (opcode === 0x9) { sendPong(client); continue; }    // ping
    if (opcode !== 0x1) continue;                          // only handle text frames

    try {
      const parsed = JSON.parse(payload.toString('utf8'));
      handleMessage(client, parsed);
    } catch (e) {
      // malformed packet — ignore, don't crash the connection
    }
  }
  client.buffer = client.buffer.subarray(offset);
}

function sendPong(client) { try { client.socket.write(Buffer.from([0x8a, 0])); } catch (e) {} }

/* ---------------- HTTP + upgrade ---------------- */
function handleHttp(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('DinoGuessr multiplayer server is running.');
}

const server = http.createServer(handleHttp);

server.on('upgrade', (req, socket) => {
  if (url.parse(req.url).pathname !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ].join('\r\n'));

  const client = { id: id(), socket, name: 'Player', room: null, buffer: null, lastSeen: Date.now() };
  socket.on('data', chunk => decodeFrames(client, chunk));
  socket.on('close', () => removeFromRoom(client));
  socket.on('error', () => removeFromRoom(client));
});

/* ---------------- cleanup sweep ---------------- */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 || now - room.createdAt > STALE_ROOM_MS) {
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DinoGuessr multiplayer server running on port ${PORT}`);
});
