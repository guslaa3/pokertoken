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
//     buyIn: number,       // starting balance for each player
//     ante: number,        // entry fee charged immediately on join
//     pot: number,         // confirmed bets, already moved out of balances
//     turnOrder: [id...],  // seating order, fixed once a player joins
//     turnIndex: number,   // index into turnOrder for whose turn it is
//     pendingBet: number,  // amount the current-turn player is staging (undoable)
//     hostToken: string,
//     players: [{ id, name, balance, token, bankrupt }],
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
function genToken() { return crypto.randomBytes(16).toString('hex'); }
function genId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

function currentTurnPlayerId(room) {
  const n = room.turnOrder.length;
  if (n === 0) return null;
  for (let step = 0; step < n; step++) {
    const idx = (room.turnIndex + step) % n;
    const id = room.turnOrder[idx];
    const p = room.players.find(pp => pp.id === id);
    if (!p || p.bankrupt) continue;
    if (p.balance <= 0) {
      // Broke but not bankrupt (e.g. went all-in or just paid the ante down
      // to zero) — nothing to bet, so this turn auto-passes to the next player.
      continue;
    }
    room.turnIndex = idx; // normalize so it always points at a real active player
    return id;
  }
  return null;
}

function advanceTurn(room) {
  const n = room.turnOrder.length;
  if (n === 0) return;
  for (let step = 1; step <= n; step++) {
    const idx = (room.turnIndex + step) % n;
    const id = room.turnOrder[idx];
    const p = room.players.find(pp => pp.id === id);
    if (p && !p.bankrupt) {
      room.turnIndex = idx;
      return;
    }
  }
  // nobody active left — leave turnIndex as-is
}

function setTurnToPlayer(room, playerId) {
  const idx = room.turnOrder.indexOf(playerId);
  if (idx !== -1) room.turnIndex = idx;
}

function publicState(room) {
  const turnId = currentTurnPlayerId(room);
  return {
    buyIn: room.buyIn,
    ante: room.ante,
    pot: room.pot,
    pendingBet: room.pendingBet,
    turnPlayerId: turnId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, balance: p.balance, bankrupt: !!p.bankrupt,
    })),
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

// Charging the ante is the only place a player can become bankrupt:
// if they can't afford the ante, they pay what they have and are marked
// bankrupt (removed from the turn order). If they can afford it, they pay
// in full and stay in — even if that leaves them at exactly 0 balance.
function chargeAnte(room, player) {
  if (room.ante <= 0) return;
  if (player.balance < room.ante) {
    room.pot += player.balance;
    player.balance = 0;
    player.bankrupt = true;
  } else {
    player.balance -= room.ante;
    room.pot += room.ante;
  }
}

wss.on('connection', (ws) => {
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    // ---- Create a new room (sender becomes host) ----
    if (msg.type === 'create_room') {
      const buyIn = Math.max(0, parseInt(msg.buyIn, 10) || 0);
      const ante = Math.max(0, parseInt(msg.ante, 10) || 0);
      const hostName = (msg.name || '방장').toString().slice(0, 20).trim() || '방장';
      let code;
      do { code = genCode(); } while (rooms[code]);

      const hostToken = genToken();
      const hostId = genId();
      const hostPlayer = { id: hostId, name: hostName, balance: buyIn, token: genToken(), bankrupt: false };

      rooms[code] = {
        buyIn,
        ante,
        pot: 0,
        turnOrder: [hostId],
        turnIndex: 0,
        pendingBet: 0,
        hostToken,
        players: [hostPlayer],
        clients: new Map(),
      };
      const room = rooms[code];
      chargeAnte(room, hostPlayer);

      roomCode = code;
      room.clients.set(ws, { playerId: hostId, isHost: true });

      sendTo(ws, {
        type: 'joined',
        room: code,
        playerId: hostId,
        playerToken: hostPlayer.token,
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
      const player = { id, name, balance: room.buyIn, token, bankrupt: false };
      room.players.push(player);
      room.turnOrder.push(id);
      chargeAnte(room, player);

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

    // ---- Stage a bet amount: only valid if it's this player's turn ----
    if (msg.type === 'stage_bet') {
      const player = room.players.find(p => p.id === conn.playerId);
      if (!player) return;
      const turnId = currentTurnPlayerId(room);
      if (turnId !== conn.playerId) {
        sendTo(ws, { type: 'error', message: '지금은 당신의 차례가 아니에요.' });
        return;
      }
      const addAmount = msg.allIn ? (player.balance - room.pendingBet) : Math.max(0, parseInt(msg.amount, 10) || 0);
      const nextPending = room.pendingBet + addAmount;
      if (addAmount <= 0 || nextPending > player.balance) {
        sendTo(ws, { type: 'error', message: '베팅할 수 없는 금액이에요.' });
        return;
      }
      room.pendingBet = nextPending;
      broadcastState(roomCode);
      return;
    }

    // ---- Undo the staged (not yet confirmed) bet back to 0 ----
    if (msg.type === 'reset_pending') {
      const turnId = currentTurnPlayerId(room);
      if (turnId !== conn.playerId) return;
      room.pendingBet = 0;
      broadcastState(roomCode);
      return;
    }

    // ---- Confirm the staged bet: moves it into the pot and advances the turn ----
    if (msg.type === 'confirm_bet') {
      const player = room.players.find(p => p.id === conn.playerId);
      if (!player) return;
      const turnId = currentTurnPlayerId(room);
      if (turnId !== conn.playerId) {
        sendTo(ws, { type: 'error', message: '지금은 당신의 차례가 아니에요.' });
        return;
      }
      if (room.pendingBet <= 0) {
        sendTo(ws, { type: 'error', message: '베팅 금액을 먼저 선택해주세요.' });
        return;
      }
      player.balance -= room.pendingBet;
      room.pot += room.pendingBet;
      room.pendingBet = 0;
      advanceTurn(room);
      broadcastState(roomCode);
      return;
    }

    // ---- Host declares a winner: pot goes entirely to them, pot resets,
    //      then every still-active player is charged the ante for the next hand,
    //      and the turn order starts again from the winner. ----
    if (msg.type === 'declare_winner') {
      if (!conn.isHost) {
        sendTo(ws, { type: 'error', message: '방장만 승자를 지정할 수 있어요.' });
        return;
      }
      const winner = room.players.find(p => p.id === msg.winnerId);
      if (!winner) return;
      winner.balance += room.pot;
      room.pot = 0;
      room.pendingBet = 0;
      if (winner.balance > 0) winner.bankrupt = false;

      // Collect next hand's ante from everyone who isn't bankrupt.
      // This can newly bankrupt someone who can no longer afford it.
      for (const p of room.players) {
        if (!p.bankrupt) chargeAnte(room, p);
      }

      setTurnToPlayer(room, winner.id);
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
  console.log(`Token counter running on port ${PORT}`);
});
