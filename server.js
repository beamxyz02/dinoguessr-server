'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 2;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STALE_ROOM_MS = 2 * 60 * 60 * 1000;

const rooms = new Map();

function uid() { return crypto.randomBytes(8).toString('hex'); }
function makeRoomCode() {
  let code;
  do { code = Array.from({length:5}, () => ROOM_CODE_CHARS[Math.floor(Math.random()*ROOM_CODE_CHARS.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeName(v) { return String(v||'Player').replace(/[<>]/g,'').trim().slice(0,20)||'Player'; }
function finiteNum(v, fb=0, min=-Infinity, max=Infinity) { const n=Number(v); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fb; }

function makeRoom(code, host) {
  return { code, players:[host], hostId:host.id, started:false, totalRounds:5, createdAt:Date.now() };
}
function lobbyState(room) {
  return { type:'lobby_state', code:room.code, hostId:room.hostId, started:room.started, maxPlayers:MAX_PLAYERS, players:room.players.map(p=>({id:p.id,name:p.name})) };
}
function send(client, obj) { try { client.ws.send(JSON.stringify(obj)); } catch(e){} }
function broadcast(room, obj, exclude) { for (const p of room.players) { if (p!==exclude) send(p,obj); } }

function removeFromRoom(client) {
  if (!client.room) return;
  const room = rooms.get(client.room);
  if (room) {
    room.players = room.players.filter(p => p !== client);
    if (room.players.length === 0) { rooms.delete(room.code); }
    else {
      if (room.hostId === client.id) room.hostId = room.players[0].id;
      broadcast(room, { type:'opponent_left', name:client.name });
      broadcast(room, lobbyState(room));
    }
  }
  client.room = null;
}

function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'create_lobby') {
    if (client.room) removeFromRoom(client);
    client.name = safeName(msg.name);
    const code = makeRoomCode();
    const room = makeRoom(code, client);
    rooms.set(code, room);
    client.room = code;
    send(client, { ...lobbyState(room), yourId: client.id });
    return;
  }

  if (msg.type === 'join_lobby') {
    const code = String(msg.code||'').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { send(client, { type:'error', message:'Room not found.' }); return; }
    if (room.started) { send(client, { type:'error', message:'That match already started.' }); return; }
    if (room.players.length >= MAX_PLAYERS) { send(client, { type:'error', message:'Room is full.' }); return; }
    if (client.room) removeFromRoom(client);
    client.name = safeName(msg.name);
    room.players.push(client);
    client.room = code;
    broadcast(room, lobbyState(room), client);
    send(client, { ...lobbyState(room), yourId: client.id });
    return;
  }

  const room = client.room ? rooms.get(client.room) : null;
  if (!room) return;

  if (msg.type === 'start_game') {
    if (client.id !== room.hostId) return;
    if (room.players.length < MAX_PLAYERS) return;
    if (room.started) return;
    room.started = true;
    room.totalRounds = [5,10].includes(Number(msg.totalRounds)) ? Number(msg.totalRounds) : 5;
    broadcast(room, {
      type: 'game_start',
      seed: Math.floor(finiteNum(msg.seed, Date.now(), 0, 999999999)),
      category: ['dino','ptero','marine'].includes(msg.category) ? msg.category : 'dino',
      totalRounds: room.totalRounds
    });
    return;
  }

  if (msg.type === 'round_complete') {
    broadcast(room, {
      type: 'opponent_round_complete',
      fromId: client.id,
      name: client.name,
      roundIndex: Math.floor(finiteNum(msg.roundIndex, 0, 0, 999)),
      guesses: Math.floor(finiteNum(msg.guesses, 0, 0, 999)),
      time: Math.floor(finiteNum(msg.time, 0, 0, 86400))
    }, client);
    return;
  }

  if (msg.type === 'leave_lobby') { removeFromRoom(client); return; }
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DinoGuessr multiplayer server is running.');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  const client = { id: uid(), ws, name: 'Player', room: null };
  ws.on('message', (data) => {
    try { handleMessage(client, JSON.parse(data.toString())); } catch(e) {}
  });
  ws.on('close', () => removeFromRoom(client));
  ws.on('error', () => removeFromRoom(client));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 || now - room.createdAt > STALE_ROOM_MS) rooms.delete(code);
  }
}, 60000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`DinoGuessr multiplayer server running on port ${PORT}`);
});
