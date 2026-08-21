const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Kortstokk-logikk
const SUITS = ['c', 'd', 'h', 's'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (let s of SUITS) {
    for (let v of VALUES) {
      deck.push(v + s);
    }
  }
  return shuffle(deck);
}

function shuffle(array) {
  let deck = [...array];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Spilltilstand
let gameState = {
  gameMode: 'TEXAS', // 'TEXAS' eller 'OMAHA'
  phase: 'VENTING',  // 'VENTING', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN'
  board: [],
  deck: []
};

let players = {}; // socket.id -> { id, name, seat, cards, folded, role }

io.on('connection', (socket) => {
  console.log('Ny tilkobling:', socket.id);

  // Spiller blir med
  socket.on('join_game', (name) => {
    const seatNumber = Object.keys(players).length + 1;
    players[socket.id] = {
      id: socket.id,
      name: name,
      seat: seatNumber,
      cards: [],
      folded: false,
      role: ''
    };
    console.log(`${name} ble med som plass ${seatNumber}`);
    updateAll();
  });

  // Endre spillmodus (Texas / Omaha)
  socket.on('set_game_mode', (mode) => {
    gameState.gameMode = mode;
    updateAll();
  });

  // Start ny hånd
  socket.on('start_new_hand', () => {
    const playerList = Object.values(players);
    if (playerList.length === 0) return; // Må ha minst 1 spiller

    gameState.deck = createDeck();
    gameState.board = [];
    gameState.phase = 'PREFLOP';

    // Tilbakestill spillere og tildel roller (SB / BB)
    playerList.forEach((p, idx) => {
      p.folded = false;
      p.cards = [];
      p.role = '';

      if (playerList.length >= 2) {
        if (idx === 0) p.role = 'SB';
        else if (idx === 1) p.role = 'BB';
      } else {
        p.role = 'BB';
      }

      // Del ut kort basert på modus
      const cardCount = gameState.gameMode === 'OMAHA' ? 4 : 2;
      for (let i = 0; i < cardCount; i++) {
        p.cards.push(gameState.deck.pop());
      }
    });

    updateAll();
  });

  // Neste fase (Flop -> Turn -> River -> Showdown)
  socket.on('next_phase', () => {
    if (gameState.phase === 'PREFLOP') {
      gameState.phase = 'FLOP';
      gameState.board = [gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop()];
    } else if (gameState.phase === 'FLOP') {
      gameState.phase = 'TURN';
      gameState.board.push(gameState.deck.pop());
    } else if (gameState.phase === 'TURN') {
      gameState.phase = 'RIVER';
      gameState.board.push(gameState.deck.pop());
    } else if (gameState.phase === 'RIVER') {
      gameState.phase = 'SHOWDOWN';
    }
    updateAll();
  });

  // Spiller kaster seg (Fold)
  socket.on('player_fold', () => {
    if (players[socket.id]) {
      players[socket.id].folded = true;
      updateAll();
    }
  });

  // Frakobling
  socket.on('disconnect', () => {
    delete players[socket.id];
    updateAll();
  });
});

function updateAll() {
  const playerList = Object.values(players);

  // Send oppdatert bord-tilstand til alle (felleskort + spillerliste)
  io.emit('state_update', {
    gameMode: gameState.gameMode,
    phase: gameState.phase,
    board: gameState.board,
    players: playerList.map(p => ({
      name: p.name,
      seat: p.seat,
      role: p.role,
      folded: p.folded
    }))
  });

  // Send private kort til hver enkelt mobil
  playerList.forEach(p => {
    io.to(p.id).emit('player_state', {
      phase: gameState.phase,
      cards: p.cards,
      role: p.role,
      folded: p.folded
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));