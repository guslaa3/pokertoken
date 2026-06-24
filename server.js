const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// =====================================================================
// In-memory room state.
// rooms: {
//   [roomCode]: {
//     buyIn: number,
//     pot: number,
//     hostToken: string,           // secret held only by the host's browser
//     players: [{ id, name, balance, token }],  // token = secret per-player auth
//     clients: Map<ws, { playerId, isHost }>
//   }
// }
// =====================================================================
const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function genId() {
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

function publicState(room) {
  // What every client receives — host secret token is never sent out,
  // and per-player tokens are only ever sent to that specific player.
  return {
    buyIn: room.buyIn,
    pot: room.pot,
    players: room.players.map(p => ({ id: p.id, name: p.name, balance: p.balance })),
  };
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const payload = JSON.stringify({ type: 'state', state: publicState(room) });
  for (const [client] of room.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function sendTo(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on('connection', (ws) => {
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ---- Create a new room (sender becomes host) ----
    if (msg.type === 'create_room') {
      const buyIn = Math.max(0, parseInt(msg.buyIn, 10) || 0);
      const hostName = (msg.name || '방장').toString().slice(0, 20).trim() || '방장';
      let code;
      do { code = genCode(); } while (rooms[code]);

      const hostToken = genToken();
      const hostId = genId();

      rooms[code] = {
        buyIn,
        pot: 0,
        hostToken,
        players: [{ id: hostId, name: hostName, balance: buyIn, token: genToken() }],
        clients: new Map(),
      };

      roomCode = code;
      const room = rooms[code];
      const me = room.players[0];
      room.clients.set(ws, { playerId: me.id, isHost: true });

      sendTo(ws, {
        type: 'joined',
        room: code,
        playerId: me.id,
        playerToken: me.token,
        hostToken,
        isHost: true,
        state: publicState(room),
      });
      return;
    }

    // ---- Join an existing room as a new player ----
    if (msg.type === 'join_room') {
      const code = (msg.room || '').toUpperCase().trim();
      const room = rooms[code];
      if (!room) {
        sendTo(ws, { type: 'error', message: '방을 찾을 수 없어요. 방 코드를 다시 확인해주세요.' });
        return;
      }
      const name = (msg.name || '플레이어').toString().slice(0, 20).trim() || '플레이어';
      const id = genId();
      const token = genToken();
      room.players.push({ id, name, balance: room.buyIn, token });

      roomCode = code;
      room.clients.set(ws, { playerId: id, isHost: false });

      sendTo(ws, {
        type: 'joined',
        room: code,
        playerId: id,
        playerToken: token,
        isHost: false,
        state: publicState(room),
      });
      broadcastState(code);
      return;
    }

    // ---- Reconnect using previously issued tokens (e.g. after refresh) ----
    if (msg.type === 'rejoin') {
      const code = (msg.room || '').toUpperCase().trim();
      const room = rooms[code];
      if (!room) {
        sendTo(ws, { type: 'error', message: '방이 더 이상 존재하지 않아요.' });
        return;
      }
      const player = room.players.find(p => p.id === msg.playerId && p.token === msg.playerToken);
      if (!player) {
        sendTo(ws, { type: 'error', message: '입장 정보가 유효하지 않아요. 다시 입장해주세요.' });
        return;
      }
      const isHost = msg.hostToken && msg.hostToken === room.hostToken;
      roomCode = code;
      room.clients.set(ws, { playerId: player.id, isHost });
      sendTo(ws, {
        type: 'joined',
        room: code,
        playerId: player.id,
        playerToken: player.token,
        hostToken: isHost ? room.hostToken : undefined,
        isHost,
        state: publicState(room),
      });
      return;
    }

    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const conn = room.clients.get(ws);
    if (!conn) return;

    // ---- Place a bet: only the authenticated owner of a player can bet for them ----
    if (msg.type === 'bet') {
      const player = room.players.find(p => p.id === conn.playerId);
      if (!player) return;
      const amount = msg.allIn ? player.balance : Math.max(0, parseInt(msg.amount, 10) || 0);
      if (amount <= 0 || amount > player.balance) {
        sendTo(ws, { type: 'error', message: '베팅할 수 없는 금액이에요.' });
        return;
      }
      player.balance -= amount;
      room.pot += amount;
      broadcastState(roomCode);
      return;
    }

    // ---- Host declares a winner: pot goes entirely to them, pot resets ----
    if (msg.type === 'declare_winner') {
      if (!conn.isHost) {
        sendTo(ws, { type: 'error', message: '방장만 승자를 지정할 수 있어요.' });
        return;
      }
      const winner = room.players.find(p => p.id === msg.winnerId);
      if (!winner) return;
      winner.balance += room.pot;
      room.pot = 0;
      broadcastState(roomCode);
      return;
    }

    // ---- Host updates buy-in baseline (display only — doesn't touch live balances) ----
    if (msg.type === 'set_buyin') {
      if (!conn.isHost) return;
      const val = Math.max(0, parseInt(msg.buyIn, 10) || 0);
      room.buyIn = val;
      broadcastState(roomCode);
      return;
    }
  });

  ws.on('close', () => {
    if (roomCode && rooms[roomCode]) {
      rooms[roomCode].clients.delete(ws);
      setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].clients.size === 0) {
          delete rooms[roomCode];
        }
      }, 1000 * 60 * 30); // 30 min grace period before cleanup
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker token counter running on port ${PORT}`);
});
