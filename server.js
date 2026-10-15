const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const clients = new Map();
const makeCode = () => { let c; do { c = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(c)); return c; };
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const roomSummary = room => ({ code: room.code, name: room.name, map: room.map, players: room.players.size });
function broadcastRoom(room, data) { for (const id of room.players.keys()) { const client = [...clients.values()].find(c => c.id === id); if (client) send(client.ws, data); } }
function broadcastPlayers(room) { broadcastRoom(room, { type: 'players', players: [...room.players.values()].map(p => ({ ...p })) }); }
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ name: 'Crocodiles Wars WebSocket server', status: 'ok', rooms: [...rooms.values()].map(roomSummary) })); });
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const client = { id: Math.random().toString(36).slice(2, 10), ws, room: null };
  clients.set(ws, client);
  send(ws, { type: 'hello', playerId: client.id });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Неверный формат сообщения' }); }
    if (msg.type === 'list') return send(ws, { type: 'rooms', rooms: [...rooms.values()].map(roomSummary) });
    if (msg.type === 'create') {
      if (client.room) return send(ws, { type: 'error', message: 'Ты уже в комнате' });
      const code = makeCode();
      const room = { code, name: String(msg.name || 'Комната игрока').slice(0, 28), map: ['forest','city','parkour'].includes(msg.map) ? msg.map : 'forest', players: new Map() };
      room.players.set(client.id, { id: client.id, x: 0, z: 5, yaw: 0, weapon: 'knife', playing: false }); rooms.set(code, room); client.room = code;
      send(ws, { type: 'created', code, playerId: client.id, map: room.map, name: room.name }); broadcastPlayers(room); return;
    }
    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase(); const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: 'Комната не найдена. Проверь код.' });
      if (room.players.size >= 8) return send(ws, { type: 'error', message: 'В комнате уже 8 игроков.' });
      if (client.room) { const old = rooms.get(client.room); if (old) old.players.delete(client.id); }
      client.room = code; room.players.set(client.id, { id: client.id, x: 2, z: 5, yaw: 0, weapon: 'knife', playing: false });
      send(ws, { type: 'joined', code, playerId: client.id, map: room.map, name: room.name }); broadcastPlayers(room); return;
    }
    if (msg.type === 'state') {
      const room = rooms.get(client.room); if (!room) return;
      const p = room.players.get(client.id); if (!p) return;
      p.x = Number.isFinite(msg.x) ? Math.max(-500, Math.min(500, msg.x)) : p.x;
      p.z = Number.isFinite(msg.z) ? Math.max(-500, Math.min(500, msg.z)) : p.z;
      p.yaw = Number.isFinite(msg.yaw) ? msg.yaw : p.yaw;
      p.weapon = String(msg.weapon || 'knife').slice(0, 16); p.playing = !!msg.playing;
      broadcastPlayers(room); return;
    }
  });
  ws.on('close', () => { clients.delete(ws); if (client.room) { const room = rooms.get(client.room); if (room) { room.players.delete(client.id); if (!room.players.size) rooms.delete(room.code); else { broadcastRoom(room, { type: 'player-left', playerId: client.id }); broadcastPlayers(room); } } } });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Crocodiles Wars WebSocket server listening on ${PORT}`));
