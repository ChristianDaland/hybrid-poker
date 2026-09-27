import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import crypto from 'crypto';
import pkg from 'pokersolver';
const { Hand } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- DATABASE OPPSETT ---
// Bruker minnet (:memory:) på Render/sky for å unngå skrivefeil på skrivebeskyttet disk
const dbPath = process.env.NODE_ENV === 'production' || process.env.RENDER
  ? ':memory:'
  : path.join(__dirname, 'poker.db');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Feil ved åpning av database:', err.message);
  } else {
    console.log(`Tilkoblet SQLite-database (${dbPath})`);
  }
});

function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS player_stats (
        uuid TEXT PRIMARY KEY,
        name TEXT,
        hands_played INTEGER DEFAULT 0,
        hands_won INTEGER DEFAULT 0,
        texas_played INTEGER DEFAULT 0,
        texas_won INTEGER DEFAULT 0,
        omaha_played INTEGER DEFAULT 0,
        omaha_won INTEGER DEFAULT 0
      )
    `);
  });
}

function ensurePlayerStats(uuid, name) {
  db.run(
    `INSERT INTO player_stats (uuid, name) VALUES (?, ?)
     ON CONFLICT(uuid) DO UPDATE SET name=excluded.name`,
    [uuid, name]
  );
}

// REST API for historikk
app.get('/api/stats', (req, res) => {
  db.all('SELECT * FROM player_stats ORDER BY hands_won DESC', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// --- SPILLTILSTAND ---
let players = {}; // socket.id -> Player
let uuidToPlayerId = new Map(); // uuid -> socket.id
let disconnectTimeouts = {}; // uuid -> timeoutId

let gameState = {
  phase: 'VENTING', // VENTING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, FINISHED
  gameMode: null,  // TEXAS eller OMAHA
  board: [],       // Felleskort
  deck: [],
  dealerIndex: 0,
  smallBlindIndex: -1,
  bigBlindIndex: -1,
  winnerInfo: null
};

// --- HJELPEFUNKSJONER ---
function generateDeck() {
  const suits = ['s', 'h', 'd', 'c'];
  const values = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (const s of suits) {
    for (const v of values) {
      deck.push(v + s);
    }
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function randomizePlayerSeats() {
  const playerList = Object.values(players);
  for (let i = playerList.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playerList[i], playerList[j]] = [playerList[j], playerList[i]];
  }
  playerList.forEach((p, idx) => {
    p.seat = idx + 1;
  });
}

function translateHandDescription(descr) {
  if (!descr) return '';
  const translations = {
    'Straight Flush': 'Straight Flush',
    'Four of a Kind': 'Fire like',
    'Full House': 'Fullt hus',
    'Flush': 'Flush',
    'Straight': 'Straight',
    'Three of a Kind': 'Tre like',
    'Two Pair': 'To par',
    'Pair': 'Ett par',
    'High Card': 'Høyt kort'
  };
  
  let translated = descr;
  Object.keys(translations).forEach(key => {
    if (translated.includes(key)) {
      translated = translated.replace(key, translations[key]);
    }
  });
  return translated;
}

function evaluatePlayerHand(playerCards, boardCards, gameMode) {
  if (gameMode === 'TEXAS') {
    const allCards = [...playerCards, ...boardCards];
    return Hand.solve(allCards);
  } else if (gameMode === 'OMAHA') {
    let bestHand = null;

    const handCombos = [];
    for (let i = 0; i < playerCards.length; i++) {
      for (let j = i + 1; j < playerCards.length; j++) {
        handCombos.push([playerCards[i], playerCards[j]]);
      }
    }

    const boardCombos = [];
    for (let i = 0; i < boardCards.length; i++) {
      for (let j = i + 1; j < boardCards.length; j++) {
        for (let k = j + 1; k < boardCards.length; k++) {
          boardCombos.push([boardCards[i], boardCards[j], boardCards[k]]);
        }
      }
    }

    for (const hCombo of handCombos) {
      for (const bCombo of boardCombos) {
        const candidate = [...hCombo, ...bCombo];
        const solved = Hand.solve(candidate);
        if (!bestHand || solved.rank > bestHand.rank || (solved.rank === bestHand.rank && solved.compare(bestHand) > 0)) {
          bestHand = solved;
        }
      }
    }
    return bestHand;
  }
}

function startNewHandLogic() {
  const activePlayers = Object.values(players);
  if (activePlayers.length < 2) return;

  gameState.deck = generateDeck();
  gameState.board = [];
  gameState.winnerInfo = null;
  gameState.phase = 'PREFLOP';

  activePlayers.sort((a, b) => a.seat - b.seat);

  gameState.dealerIndex = (gameState.dealerIndex + 1) % activePlayers.length;
  gameState.smallBlindIndex = (gameState.dealerIndex + 1) % activePlayers.length;
  gameState.bigBlindIndex = (gameState.dealerIndex + 2) % activePlayers.length;

  const cardCount = gameState.gameMode === 'TEXAS' ? 2 : 4;

  activePlayers.forEach((p, idx) => {
    p.folded = false;
    p.cards = [];
    for (let i = 0; i < cardCount; i++) {
      p.cards.push(gameState.deck.pop());
    }

    if (idx === gameState.dealerIndex) p.role = 'DEALER';
    else if (idx === gameState.smallBlindIndex) p.role = 'SB';
    else if (idx === gameState.bigBlindIndex) p.role = 'BB';
    else p.role = '';
  });
}

function maybeAutoStartHand() {
  if (gameState.phase === 'FINISHED') {
    const activeCount = Object.values(players).length;
    if (activeCount >= 2 && gameState.gameMode) {
      startNewHandLogic();
    }
  }
}

function resetToWaiting() {
  gameState.phase = 'VENTING';
  gameState.gameMode = null;
  gameState.board = [];
  gameState.deck = [];
  gameState.winnerInfo = null;
}

// --- SOCKET.IO EVENTS ---
io.on('connection', (socket) => {
  console.log('[Socket] Ny tilkobling:', socket.id);

  socket.emit('game_state', {
    gameState,
    players: Object.values(players)
  });

  socket.on('join_game', (payload) => {
    let name = '';
    let uuid = '';

    if (typeof payload === 'string') {
      name = payload;
      uuid = crypto.randomUUID();
    } else if (payload && typeof payload === 'object') {
      name = payload.name || 'Anonym';
      uuid = payload.uuid || crypto.randomUUID();
    }

    if (!name.trim()) return;

    let existingPlayerId = uuidToPlayerId.get(uuid);
    
    if (existingPlayerId && players[existingPlayerId]) {
      const p = players[existingPlayerId];
      delete players[existingPlayerId];
      
      p.id = socket.id;
      p.connected = true;
      p.name = name.trim();
      players[socket.id] = p;
      
      if (disconnectTimeouts[uuid]) {
        clearTimeout(disconnectTimeouts[uuid]);
        delete disconnectTimeouts[uuid];
      }
    } else {
      const newSeat = Object.keys(players).length + 1;
      players[socket.id] = {
        id: socket.id,
        uuid: uuid,
        name: name.trim(),
        cards: [],
        folded: false,
        role: '',
        seat: newSeat,
        connected: true
      };
    }

    uuidToPlayerId.set(uuid, socket.id);
    ensurePlayerStats(uuid, name.trim());

    socket.join('game');
    
    maybeAutoStartHand();

    io.emit('game_state', {
      gameState,
      players: Object.values(players)
    });
  });

  socket.on('select_gamemode', (mode) => {
    if (['TEXAS', 'OMAHA'].includes(mode)) {
      gameState.gameMode = mode;
      io.emit('game_state', {
        gameState,
        players: Object.values(players)
      });
    }
  });

  socket.on('start_hand', () => {
    if (!gameState.gameMode) return;
    startNewHandLogic();
    io.emit('game_state', {
      gameState,
      players: Object.values(players)
    });
  });

  socket.on('next_phase', () => {
    if (gameState.phase === 'VENTING' || gameState.phase === 'FINISHED') return;

    if (gameState.phase === 'PREFLOP') {
      gameState.phase = 'FLOP';
      for (let i = 0; i < 3; i++) gameState.board.push(gameState.deck.pop());
    } else if (gameState.phase === 'FLOP') {
      gameState.phase = 'TURN';
      gameState.board.push(gameState.deck.pop());
    } else if (gameState.phase === 'TURN') {
      gameState.phase = 'RIVER';
      gameState.board.push(gameState.deck.pop());
    } else if (gameState.phase === 'RIVER') {
      gameState.phase = 'SHOWDOWN';
      
      const activePlayers = Object.values(players).filter(p => !p.folded);
      if (activePlayers.length > 0) {
        let bestSolved = [];
        activePlayers.forEach(p => {
          const solved = evaluatePlayerHand(p.cards, gameState.board, gameState.gameMode);
          solved.playerName = p.name;
          solved.playerCards = p.cards;
          bestSolved.push(solved);
        });

        const winners = Hand.winners(bestSolved);
        const winnerNames = winners.map(w => w.playerName).join(' & ');
        const descr = translateHandDescription(winners[0].descr);

        gameState.winnerInfo = {
          winnerName: winners.length > 1 ? `UAVGJOERT / DELING: ${winnerNames}` : winnerNames,
          descr: descr,
          foldedWin: false,
          rawCards: winners[0].cards
        };
      }
    } else if (gameState.phase === 'SHOWDOWN') {
      gameState.phase = 'FINISHED';
    }

    io.emit('game_state', {
      gameState,
      players: Object.values(players)
    });
  });

  socket.on('fold_player', (playerId) => {
    if (players[playerId]) {
      players[playerId].folded = true;

      const activePlayers = Object.values(players).filter(p => !p.folded);
      if (activePlayers.length === 1 && gameState.phase !== 'VENTING') {
        gameState.phase = 'FINISHED';
        gameState.winnerInfo = {
          winnerName: activePlayers[0].name,
          descr: 'Alle andre kastet seg',
          foldedWin: true
        };
      }

      io.emit('game_state', {
        gameState,
        players: Object.values(players)
      });
    }
  });

  socket.on('randomize_seats', () => {
    randomizePlayerSeats();
    io.emit('game_state', {
      gameState,
      players: Object.values(players)
    });
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (player) {
      player.connected = false;
      
      disconnectTimeouts[player.uuid] = setTimeout(() => {
        delete players[socket.id];
        uuidToPlayerId.delete(player.uuid);
        delete disconnectTimeouts[player.uuid];

        if (Object.keys(players).length === 0) {
          resetToWaiting();
        }

        io.emit('game_state', {
          gameState,
          players: Object.values(players)
        });
      }, 60000);

      io.emit('game_state', {
        gameState,
        players: Object.values(players)
      });
    }
  });
});

// Start serveren
initDatabase();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Hybrid Poker kjører på port ${PORT}`);
});
