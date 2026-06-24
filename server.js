const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ===== In-memory room state =====
// rooms: { [roomCode]: { state: {...}, clients: Set<ws> } }
const rooms = {};

function defaultState() {
  return { buyIn: 0, pot: 0, players: [] };
}

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = { state: defaultState(), clients: new Set() };
  }
  return rooms[code];
}

function broadcast(code, payload, exceptWs) {
  const room = rooms[code];
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const client of room.clients) {
    if (client !== exceptWs && client.readyState === client.OPEN) {
      client.send(msg);
    }
  }
}

wss.on('connection', (ws, req) => {
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === 'join') {
      roomCode = (msg.room || 'DEFAULT').toUpperCase();
      const room = getRoom(roomCode);
      room.clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', state: room.state }));
      return;
    }

    if (msg.type === 'update' && roomCode) {
      const room = getRoom(roomCode);
      // Trust the client's full state object (simple last-write-wins model,
      // matches a casual home-game use case with no auth).
      room.state = msg.state;
      broadcast(roomCode, { type: 'state', state: room.state }, ws);
      return;
    }
  });

  ws.on('close', () => {
    if (roomCode && rooms[roomCode]) {
      rooms[roomCode].clients.delete(ws);
      // Clean up empty rooms after a delay so a quick refresh doesn't wipe data
      setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].clients.size === 0) {
          delete rooms[roomCode];
        }
      }, 1000 * 60 * 30); // 30 min grace period
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Poker chip counter running on port ${PORT}`);
});
