const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const clients = new Map();
const ALLOWED_ITEMS = new Set(['tree','croc','rock','box','wall','floor','pizza','toilet','sofa','chair','woodman']);
const ALLOWED_WEAPONS = new Set(['none','knife','pistol','ak','minigun']);
const MAX_MESSAGE_BYTES = 16 * 1024;
function rateAllowed(client, type) {
  const now = Date.now();
  if (!client.rate) client.rate = { start: now, count: 0, chatAt: 0, damageAt: 0 };
  if (now - client.rate.start >= 1000) { client.rate.start = now; client.rate.count = 0; }
  client.rate.count++;
  if (client.rate.count > 60) return false;
  if (type === 'chat') { if (now - client.rate.chatAt < 500) return false; client.rate.chatAt = now; }
  if (type === 'damage') { if (now - client.rate.damageAt < 100) return false; client.rate.damageAt = now; }
  return true;
}
const makeCode = () => { let c; do { c = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(c)); return c; };
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const clampNumber = (value, min, max, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };
const roomSummary = room => ({ name: room.name, map: room.map, players: room.players.size, public: !!room.isPublic });
function broadcastItems(room) { broadcastRoom(room, { type: 'items', items: [...room.items.values()] }); }
function broadcastRoomList() { const data = { type: 'rooms', rooms: [...rooms.values()].map(roomSummary) }; for (const c of clients.values()) send(c.ws, data); }
function broadcastRoom(room, data) { for (const id of room.players.keys()) { const client = [...clients.values()].find(c => c.id === id); if (client) send(client.ws, data); } }
function broadcastPlayers(room) { broadcastRoom(room, { type: 'players', players: [...room.players.values()].map(p => ({ ...p })) }); }
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ name: 'Crocodiles Wars WebSocket server', status: 'ok', rooms: [...rooms.values()].map(roomSummary) })); });
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
wss.on('connection', ws => {
  const client = { id: Math.random().toString(36).slice(2, 10), ws, room: null, rate: { start: Date.now(), count: 0, chatAt: 0, damageAt: 0 } };
  clients.set(ws, client);
  send(ws, { type: 'hello', playerId: client.id });
  ws.on('message', raw => {
    if (raw.length > MAX_MESSAGE_BYTES) { ws.close(1009, 'Message too large'); return; }
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'Неверный формат сообщения' }); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return;
    if (!rateAllowed(client, msg.type)) return send(ws, { type: 'error', message: 'Слишком много запросов. Подожди немного.' });
    if (msg.type === 'list' || msg.type === 'rooms') return send(ws, { type: 'rooms', rooms: [...rooms.values()].map(roomSummary) });
    if (msg.type === 'create') {
      if (client.room) return send(ws, { type: 'error', message: 'Ты уже на сервере. Перезайди после выхода.' });
      const name = String(msg.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28);
      const password = String(msg.password || '').slice(0, 40);
      if (!name) return send(ws, { type: 'error', message: 'Укажи название сервера.' });
      const isPublic = msg.isPublic === true || password.trim() === ''; 
      if ([...rooms.values()].some(r => r.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return send(ws, { type: 'error', message: 'Сервер с таким названием уже существует. Выбери другое название.' });
      const code = makeCode(); // Внутренний ID для соединения, игрокам его вводить не нужно.
      const room = { code, name, password: isPublic ? '' : password, isPublic, map: ['forest','city','parkour'].includes(msg.map) ? msg.map : 'forest', players: new Map(), items: new Map() };
      room.players.set(client.id, { id: client.id, name: 'Игрок', hp: 100, x: 0, z: 5, yaw: 0, weapon: 'knife', playing: false }); rooms.set(code, room); client.room = code;
      send(ws, { type: 'created', code, playerId: client.id, map: room.map, name: room.name }); broadcastPlayers(room); broadcastRoomList(); return;
    }
    if (msg.type === 'join') {
      const name = String(msg.name || '').trim().slice(0, 28);
      const password = String(msg.password || '').slice(0, 40);
      const room = [...rooms.values()].find(r => r.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!room) return send(ws, { type: 'error', message: 'Сервер с таким названием не найден.' });
      if (!room.isPublic && room.password !== password) return send(ws, { type: 'error', message: 'Неверный пароль сервера.' });
      if (room.players.size >= 8) return send(ws, { type: 'error', message: 'На сервере уже 8 игроков.' });
      if (client.room) { const old = rooms.get(client.room); if (old) { old.players.delete(client.id); if (!old.players.size) rooms.delete(old.code); } }
      client.room = room.code; room.players.set(client.id, { id: client.id, name: 'Игрок', hp: 100, x: 2, z: 5, yaw: 0, weapon: 'knife', playing: false });
      send(ws, { type: 'joined', code: room.code, playerId: client.id, map: room.map, name: room.name }); broadcastPlayers(room); broadcastItems(room); broadcastRoomList(); return;
    }
    if (msg.type === 'leave') {
      const room = rooms.get(client.room);
      if (room) {
        room.players.delete(client.id);
        if (room.players.size === 0) rooms.delete(room.code);
        else { broadcastRoom(room, { type: 'player-left', playerId: client.id }); broadcastPlayers(room); }
      }
      client.room = null;
      send(ws, { type: 'left' });
      broadcastRoomList();
      return;
    }
    if (msg.type === 'items-request') { const room = rooms.get(client.room); if (!room) return; send(ws, { type: 'items', items: [...room.items.values()] }); return; }
    if (msg.type === 'item-spawn' || msg.type === 'item-update' || msg.type === 'item-remove') {
      const room = rooms.get(client.room); if (!room) return;
      const rawItem = msg.item || {}; const id = String(rawItem.id || '').slice(0, 80);
      if (!id) return;
      if (msg.type === 'item-remove') { const existing = room.items.get(id); if (existing && existing.ownerId === client.id) { room.items.delete(id); broadcastRoom(room, { type: 'item-remove', item: { id } }); } return; }
      const kind = ALLOWED_ITEMS.has(rawItem.kind) ? rawItem.kind : 'box';
      const old = room.items.get(id);
      if (msg.type === 'item-spawn' && old) return;
      if (msg.type === 'item-update' && old && old.ownerId !== client.id) return;
      const item = { id, kind, ownerId: old?.ownerId || client.id, x: Math.max(-500, Math.min(500, Number(rawItem.x) || 0)), y: Math.max(0, Math.min(20, Number(rawItem.y) || 0)), z: Math.max(-500, Math.min(500, Number(rawItem.z) || 0)), rx: clampNumber(rawItem.rx, -Math.PI * 4, Math.PI * 4, 0), ry: clampNumber(rawItem.ry, -Math.PI * 4, Math.PI * 4, 0), rz: clampNumber(rawItem.rz, -Math.PI * 4, Math.PI * 4, 0), held: !!rawItem.held };
      if (!old && room.items.size >= 250) return send(ws, { type: 'error', message: 'В сервере достигнут лимит предметов (250).' });
      room.items.set(id, item);
      broadcastRoom(room, { type: msg.type, item }); return;
    }
    if (msg.type === 'chat') {
      const room = rooms.get(client.room); if (!room || !room.players.has(client.id)) return;
      const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
      if (!text) return;
      const name = String(msg.name || 'Игрок').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Игрок';
      broadcastRoom(room, { type: 'chat', playerId: client.id, name, text, at: Date.now() }); return;
    }
    if (msg.type === 'damage') {
      const room = rooms.get(client.room); if (!room) return;
      const targetId = String(msg.targetId || '');
      if (!room.players.has(targetId) || targetId === client.id) return;
      const attacker = room.players.get(client.id); const target = room.players.get(targetId);
      if (!attacker || !target || attacker.hp <= 0 || target.hp <= 0) return;
      const distance = Math.hypot((attacker.x || 0) - (target.x || 0), (attacker.z || 0) - (target.z || 0));
      if (distance > 35) return;
      const amount = Math.max(1, Math.min(18, Number(msg.amount) || 0));
      const targetClient = [...clients.values()].find(c => c.id === targetId && c.room === client.room);
      if (targetClient) send(targetClient.ws, { type: 'damage', targetId, amount, fromId: client.id });
      return;
    }
    if (msg.type === 'state') {
      const room = rooms.get(client.room); if (!room) return;
      const p = room.players.get(client.id); if (!p) return;
      p.x = Number.isFinite(msg.x) ? Math.max(-500, Math.min(500, msg.x)) : p.x;
      p.z = Number.isFinite(msg.z) ? Math.max(-500, Math.min(500, msg.z)) : p.z;
      p.yaw = Number.isFinite(msg.yaw) ? msg.yaw : p.yaw;
      p.weapon = ALLOWED_WEAPONS.has(msg.weapon) ? msg.weapon : 'knife'; p.name = String(msg.name || p.name || 'Игрок').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) || 'Игрок'; p.hp = clampNumber(msg.hp, 0, 100, p.hp);  p.playing = !!msg.playing;
      broadcastPlayers(room); return;
    }
  });
  ws.on('close', () => { clients.delete(ws); if (client.room) { const room = rooms.get(client.room); if (room) { room.players.delete(client.id); if (!room.players.size) rooms.delete(room.code); else { broadcastRoom(room, { type: 'player-left', playerId: client.id }); broadcastPlayers(room); } } client.room = null; broadcastRoomList(); } });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Crocodiles Wars WebSocket server listening on ${PORT}`));
