const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

/* ── Room / Game State ─────────────────────────────────── */
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function buildGameState(room) {
  const chess = room.chess;
  const history = chess.history({ verbose: true });
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    history,
    isGameOver: chess.game_over(),
    isCheck: chess.in_check(),
    isCheckmate: chess.in_checkmate(),
    isStalemate: chess.in_stalemate(),
    isDraw: chess.in_draw(),
    white: room.players.white ? room.players.white.username : null,
    black: room.players.black ? room.players.black.username : null,
    whiteElo: room.players.white ? room.players.white.elo : null,
    blackElo: room.players.black ? room.players.black.elo : null,
  };
}

/* ── ELO Calculation ───────────────────────────────────── */
function calcElo(ratingA, ratingB, scoreA) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(ratingA + K * (scoreA - expectedA));
}

/* ── Socket.IO ─────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`⚡ Connected: ${socket.id}`);

  /* Create Room */
  socket.on('create-room', (data) => {
    let roomId = genRoomId();
    while (rooms.has(roomId)) roomId = genRoomId();

    const room = {
      id: roomId,
      chess: new Chess(),
      players: {
        white: { id: socket.id, username: data.username, elo: data.elo || 1200 },
        black: null,
      },
      result: null,
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerColor = 'white';

    socket.emit('room-created', { roomId, color: 'white' });
    console.log(`🏠 Room ${roomId} created by ${data.username}`);
  });

  /* Join Room */
  socket.on('join-room', (data) => {
    const roomId = data.roomId.toUpperCase();
    const room = rooms.get(roomId);

    if (!room) return socket.emit('error-msg', { message: 'Room tidak ditemukan!' });
    if (room.players.black) return socket.emit('error-msg', { message: 'Room sudah penuh!' });
    if (room.players.white.username === data.username)
      return socket.emit('error-msg', { message: 'Tidak bisa join room sendiri!' });

    room.players.black = { id: socket.id, username: data.username, elo: data.elo || 1200 };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.playerColor = 'black';

    socket.emit('room-joined', { roomId, color: 'black' });
    io.to(roomId).emit('game-start', buildGameState(room));
    console.log(`🎮 ${data.username} joined room ${roomId}`);
  });

  /* Make Move */
  socket.on('make-move', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    /* Verify it's the right player's turn */
    const turn = room.chess.turn();
    if ((turn === 'w' && socket.playerColor !== 'white') ||
        (turn === 'b' && socket.playerColor !== 'black')) {
      return socket.emit('error-msg', { message: 'Bukan giliran kamu!' });
    }

    const move = room.chess.move(data.move);
    if (!move) return socket.emit('invalid-move', { message: 'Langkah tidak valid!' });

    const state = buildGameState(room);
    io.to(data.roomId).emit('move-made', { ...state, lastMove: move });

    /* Check game over */
    if (room.chess.game_over()) {
      let result = { type: 'draw', winner: null };
      if (room.chess.in_checkmate()) {
        result = { type: 'checkmate', winner: turn === 'w' ? 'white' : 'black' };
      } else if (room.chess.in_stalemate()) {
        result.type = 'stalemate';
      } else if (room.chess.in_draw()) {
        result.type = 'draw';
      }
      room.result = result;

      /* Calculate new ELO */
      const wElo = room.players.white.elo;
      const bElo = room.players.black.elo;
      let newWhiteElo, newBlackElo;
      if (result.winner === 'white') {
        newWhiteElo = calcElo(wElo, bElo, 1);
        newBlackElo = calcElo(bElo, wElo, 0);
      } else if (result.winner === 'black') {
        newWhiteElo = calcElo(wElo, bElo, 0);
        newBlackElo = calcElo(bElo, wElo, 1);
      } else {
        newWhiteElo = calcElo(wElo, bElo, 0.5);
        newBlackElo = calcElo(bElo, wElo, 0.5);
      }

      io.to(data.roomId).emit('game-over', {
        result,
        eloChanges: {
          white: { old: wElo, new: newWhiteElo, username: room.players.white.username },
          black: { old: bElo, new: newBlackElo, username: room.players.black.username },
        },
      });
    }
  });

  /* Resign */
  socket.on('resign', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const winner = socket.playerColor === 'white' ? 'black' : 'white';
    const wElo = room.players.white.elo;
    const bElo = room.players.black.elo;
    const newWhiteElo = winner === 'white' ? calcElo(wElo, bElo, 1) : calcElo(wElo, bElo, 0);
    const newBlackElo = winner === 'black' ? calcElo(bElo, wElo, 1) : calcElo(bElo, wElo, 0);

    io.to(data.roomId).emit('game-over', {
      result: { type: 'resign', winner },
      eloChanges: {
        white: { old: wElo, new: newWhiteElo, username: room.players.white.username },
        black: { old: bElo, new: newBlackElo, username: room.players.black.username },
      },
    });
  });

  /* Offer Draw */
  socket.on('offer-draw', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    socket.to(data.roomId).emit('draw-offered', { from: socket.playerColor });
  });

  /* Accept Draw */
  socket.on('accept-draw', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const wElo = room.players.white.elo;
    const bElo = room.players.black.elo;
    const newWhiteElo = calcElo(wElo, bElo, 0.5);
    const newBlackElo = calcElo(bElo, wElo, 0.5);

    io.to(data.roomId).emit('game-over', {
      result: { type: 'draw-agreement', winner: null },
      eloChanges: {
        white: { old: wElo, new: newWhiteElo, username: room.players.white.username },
        black: { old: bElo, new: newBlackElo, username: room.players.black.username },
      },
    });
  });

  /* Decline Draw */
  socket.on('decline-draw', (data) => {
    socket.to(data.roomId).emit('draw-declined');
  });

  /* Chat */
  socket.on('chat-message', (data) => {
    io.to(data.roomId).emit('chat-message', {
      username: data.username,
      message: data.message,
      color: socket.playerColor,
    });
  });

  /* Disconnect */
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room && !room.result) {
        io.to(socket.roomId).emit('opponent-disconnected', { color: socket.playerColor });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n♟️  Chess Arena running at http://localhost:${PORT}\n`);
});
