const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const clients = new Map();
const clean = (v, n=28) => String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0,n);
const bounded = v => Number.isFinite(Number(v)) ? Math.max(-500,Math.min(500,Number(v))) : 0;
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
const roomSummary = room => ({ name: room.name, map: room.map, players: room.players.size, public: room.isPublic, maxPlayers: 8 });
function broadcastRoom(room, data) { for (const id of room.players.keys()) { const c = [...clients.values()].find(x => x.id === id); if (c) send(c.ws, data); } }
function broadcastPlayers(room) { broadcastRoom(room, { type:'players', players:[...room.players.values()].map(p=>({...p})) }); }
function updatePlayerKills(room, targetId, delta, ws) {
  if (!room) return;
  const target = room.players.get(targetId);
  if (!target) return send(ws, {type:'error', message:'Игрок не найден в этой комнате'});
  const before = Math.max(0, Math.min(999999999, Math.floor(Number(target.kills) || 0)));
  const after = Math.max(0, Math.min(999999999, before + delta));
  target.kills = after;
  const targetClient = [...clients.values()].find(c => c.id === targetId && c.room === room.name.toLowerCase());
  if (targetClient) send(targetClient.ws, {type:'kills-updated', kills:after});
  broadcastPlayers(room);
  send(ws, {type:'kills-action-result', targetId, kills:after});
}
function broadcastRooms() { const data={type:'rooms',rooms:[...rooms.values()].map(roomSummary)}; for(const c of clients.values()) send(c.ws,data); }
function removeFromRoom(client) { if(!client.room) return; const room=rooms.get(client.room); if(room){ room.players.delete(client.id); if(!room.players.size) rooms.delete(room.name.toLowerCase()); else { broadcastRoom(room,{type:'player-left',playerId:client.id}); broadcastPlayers(room); } } client.room=null; broadcastRooms(); }
const server = http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*'});res.end(JSON.stringify({name:'Crocodiles Wars WebSocket server',status:'ok',rooms:[...rooms.values()].map(roomSummary)}));});
const wss = new WebSocketServer({server});
wss.on('connection',ws=>{
 const client={id:crypto.randomBytes(5).toString('hex'),ws,room:null}; clients.set(ws,client); send(ws,{type:'hello',playerId:client.id});
 ws.on('message',raw=>{ let msg; try{msg=JSON.parse(raw.toString())}catch{return send(ws,{type:'error',message:'Неверный формат сообщения'})}
  if(msg.type==='list'||msg.type==='rooms') return send(ws,{type:'rooms',rooms:[...rooms.values()].map(roomSummary)});
  if(msg.type==='leave'){removeFromRoom(client);return;}
  if(msg.type==='create'){
   if(client.room) return send(ws,{type:'error',message:'Сначала выйди из текущей комнаты'});
   const name=clean(msg.name); if(!name)return send(ws,{type:'error',message:'Укажи название сервера'});
   const key=name.toLowerCase(); if(rooms.has(key))return send(ws,{type:'error',message:'Сервер с таким названием уже существует'});
   const isPublic=!!msg.isPublic; const password=isPublic?'':String(msg.password||''); if(!isPublic&&!password.trim())return send(ws,{type:'error',message:'Укажи пароль или создай сервер без пароля'});
   const room={name,map:['forest','city','parkour'].includes(msg.map)?msg.map:'forest',isPublic,password,hostId:client.id,players:new Map(),items:new Map()};
   room.players.set(client.id,{id:client.id,x:0,z:5,yaw:0,weapon:'knife',skin:0,accessory:'',name:'Игрок',hp:100,kills:0,playing:false}); rooms.set(key,room); client.room=key;
   send(ws,{type:'created',code:name,playerId:client.id,map:room.map,name:room.name}); broadcastPlayers(room); broadcastRooms(); return;
  }
  if(msg.type==='join'){
   if(client.room)removeFromRoom(client);
   const name=clean(msg.name); const key=name.toLowerCase(); const room=rooms.get(key);
   if(!room)return send(ws,{type:'error',message:'Сервер с таким названием не найден'});
   if(room.players.size>=8)return send(ws,{type:'error',message:'На сервере уже 8 игроков'});
   if(!room.isPublic && String(msg.password||'')!==room.password)return send(ws,{type:'error',message:'Неверный пароль'});
   room.players.set(client.id,{id:client.id,x:2,z:5,yaw:0,weapon:'knife',skin:0,accessory:'',name:'Игрок',hp:100,kills:0,playing:false}); client.room=key;
   send(ws,{type:'joined',code:room.name,playerId:client.id,map:room.map,name:room.name}); send(ws,{type:'items',items:[...room.items.values()]}); broadcastPlayers(room); broadcastRooms(); return;
  }
  const room=client.room?rooms.get(client.room):null;
  if(msg.type==='items-request'){if(!room)return;send(ws,{type:'items',items:[...room.items.values()]});return;}
  if(msg.type==='item-spawn'||msg.type==='item-update'||msg.type==='item-remove'){
   if(!room)return;const raw=msg.item;if(!raw||typeof raw!=='object')return;
   const id=clean(raw.id,80);if(!id)return;
   if(msg.type==='item-remove'){room.items.delete(id);broadcastRoom(room,{type:'item-remove',item:{id}});return;}
   const kind=['tree','croc','rock','box','wall','floor','pizza','toilet','sofa','chair','woodman'].includes(raw.kind)?raw.kind:'box';
   const item={id,kind,x:bounded(raw.x),y:bounded(raw.y),z:bounded(raw.z),rx:bounded(raw.rx),ry:bounded(raw.ry),rz:bounded(raw.rz),held:!!raw.held};
   if(!room.items.has(id)&&room.items.size>=200)return send(ws,{type:'error',message:'На сервере максимум 200 предметов'});
   room.items.set(id,item);broadcastRoom(room,{type:msg.type,item});return;
  }
  if(msg.type==='chat'){if(!room)return;const text=String(msg.text||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,180);if(text)broadcastRoom(room,{type:'chat',name:clean(msg.name,16)||'Игрок',text,at:Date.now()});return;}
  if(msg.type==='damage'){if(!room)return;const targetId=String(msg.targetId||'');if(!room.players.has(targetId)||targetId===client.id)return;const amount=Math.max(1,Math.min(100,Number(msg.amount)||0));const target=[...clients.values()].find(c=>c.id===targetId&&c.room===client.room);if(target)send(target.ws,{type:'damage',targetId,amount,fromId:client.id});return;}
  if(msg.type==='give-kills'||msg.type==='steal-kills'){
   if(!room)return send(ws,{type:'error',message:'Сначала подключись к комнате'});
   if(room.hostId!==client.id)return send(ws,{type:'error',message:'Давать и забирать убийства может только создатель комнаты'});
   const targetId=String(msg.targetId||'');
   if(!targetId||targetId===client.id)return send(ws,{type:'error',message:'Выбери другого игрока'});
   const amount=Math.floor(Number(msg.amount));
   if(!Number.isFinite(amount)||amount<1)return send(ws,{type:'error',message:'Количество должно быть не меньше 1'});
   const boundedAmount=Math.min(999999999,amount);
   const target=room.players.get(targetId);
   if(!target)return send(ws,{type:'error',message:'Игрок не найден в этой комнате'});
   if(msg.type==='give-kills') updatePlayerKills(room,targetId,boundedAmount,ws);
   else updatePlayerKills(room,targetId,-boundedAmount,ws);
   return;
  }
  if(msg.type==='state'){if(!room)return;const p=room.players.get(client.id);if(!p)return;p.x=Number.isFinite(msg.x)?Math.max(-500,Math.min(500,msg.x)):p.x;p.z=Number.isFinite(msg.z)?Math.max(-500,Math.min(500,msg.z)):p.z;p.yaw=Number.isFinite(msg.yaw)?msg.yaw:p.yaw;p.weapon=String(msg.weapon||'knife').slice(0,16);p.skin=Number.isInteger(Number(msg.skin))?Math.max(0,Math.min(4,Number(msg.skin))):(p.skin||0);p.accessory=['hat','watermelon','glasses','goldglasses','crown','horns','backpack','wings','halo'].includes(String(msg.accessory||''))?String(msg.accessory):'';p.name=clean(msg.name,16)||p.name;p.hp=Number.isFinite(Number(msg.hp))?Math.max(0,Math.min(100,Number(msg.hp))):(p.hp||100);p.jump=Number.isFinite(Number(msg.jump))?Math.max(0,Math.min(1.35,Number(msg.jump))):(p.jump||0);p.playing=!!msg.playing;broadcastPlayers(room);return;}
 });
 ws.on('close',()=>{removeFromRoom(client);clients.delete(ws);});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Crocodiles Wars server listening on ${PORT}`));
