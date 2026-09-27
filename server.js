// Laster miljøvariabler fra .env hvis tilgjengelig
try { require('dotenv').config(); } catch (err) { /* dotenv ikke installert – OK */ }

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// ============================================================
// API: Statistikk, Topp 10 vinnerhender, DB-nullstilling og Inspeksjon
// ============================================================

app.get('/api/stats', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  }
  try {
    const result = await db.execute(`
      SELECT 
        name, 
        SUM(hands_played) as hands_played, 
        SUM(hands_won) as hands_won 
      FROM player_stats 
      GROUP BY LOWER(name)
      ORDER BY hands_won DESC, hands_played DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/stats]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/winning-hands', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  }
  try {
    const result = await db.execute(`
      SELECT player_name, hand_description, winning_cards, hand_rank, created_at 
      FROM winning_hands 
      ORDER BY hand_rank DESC, id DESC 
      LIMIT 10
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/winning-hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-db', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  }
  try {
    const hands = await db.execute("SELECT * FROM winning_hands ORDER BY id DESC");
    const stats = await db.execute("SELECT * FROM player_stats ORDER BY id DESC");
    const sessions = await db.execute("SELECT * FROM poker_sessions ORDER BY id DESC");

    res.json({
      winning_hands: hands.rows,
      player_stats: stats.rows,
      poker_sessions: sessions.rows
    });
  } catch (err) {
    console.error('[DB Error /api/debug-db]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-db', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  }
  try {
    await db.execute("DELETE FROM winning_hands");
    await db.execute("DELETE FROM player_stats");
    await db.execute("DELETE FROM poker_sessions");
    currentSessionId = null;
    console.log('[DB] Databasen er tømt for testdata!');
    res.json({ message: 'Databasen er tømt for all data.' });
  } catch (err) {
    console.error('[DB Error /api/reset-db]:', err);
    res.status(500).json({ error: err.message });
  }
});

const SUITS = ['c', 'd', 'h', 's'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

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

function formatForSolver(card) {
  return card;
}

function translateHandDescription(descr) {
  let text = descr || 'Ukjent hånd';

  text = text.replace(/\bT\b/g, '10');
  text = text.replace(/Straight Flush/g, 'Straight Flush');
  text = text.replace(/Four of a Kind/g, 'Fire like');
  text = text.replace(/Full House/g, 'Fullt Hus');
  text = text.replace(/Flush/g, 'Flush');
  text = text.replace(/Straight/g, 'Straight');
  text = text.replace(/Three of a Kind/g, 'Tre like');
  text = text.replace(/Two Pair/g, 'To Par');
  text = text.replace(/Pair/g, 'Ett Par');
  text = text.replace(/High Card/g, 'Høyt Kort');

  text = text.replace(/Spades/g, 'Spar');
  text = text.replace(/Hearts/g, 'Hjerter');
  text = text.replace(/Diamonds/g, 'Ruter');
  text = text.replace(/Clubs/g, 'Kløver');

  return text;
}

function getHandRankValue(descr) {
  if (!descr) return 1;
  const d = String(descr).toLowerCase();
  if (d.includes('royal')) return 10;
  if (d.includes('straight flush')) return 9;
  if (d.includes('fire like')) return 8;
  if (d.includes('fullt hus')) return 7;
  if (d.includes('flush')) return 6;
  if (d.includes('straight')) return 5;
  if (d.includes('tre like')) return 4;
  if (d.includes('to par')) return 3;
  if (d.includes('ett par') || d.includes('par')) return 2;
  if (d.includes('høyt kort')) return 1;
  return 1;
}

function evaluatePlayerHand(playerCards, boardCards, gameMode) {
  const formattedBoard = boardCards.map(formatForSolver);
  const formattedPlayer = playerCards.map(formatForSolver);

  if (gameMode === 'TEXAS') {
    const allCards = [...formattedPlayer, ...formattedBoard];
    return Hand.solve(allCards);
  } else {
    let bestHand = null;
    for (let i = 0; i < formattedPlayer.length; i++) {
      for (let j = i + 1; j < formattedPlayer.length; j++) {
        const hand2 = [formattedPlayer[i], formattedPlayer[j]];

        for (let b1 = 0; b1 < formattedBoard.length; b1++) {
          for (let b2 = b1 + 1; b2 < formattedBoard.length; b2++) {
            for (let b3 = b2 + 1; b3 < formattedBoard.length; b3++) {
              const board3 = [formattedBoard[b1], formattedBoard[b2], formattedBoard[b3]];
              const combo = Hand.solve([...hand2, ...board3]);
              
              if (!bestHand) {
                bestHand = combo;
              } else {
                const winner = Hand.winners([bestHand, combo]);
                if (winner.includes(combo) && !winner.includes(bestHand)) {
                  bestHand = combo;
                }
              }
            }
          }
        }
      }
    }
    return bestHand;
  }
}

let gameState = {
  gameMode: null,
  phase: 'VENTING',
  board: [],
  deck: [],
  winnerInfo: null,
  dealerIndex: 0
};

let players = {};
const disconnectTimeouts = {};
const uuidToPlayerId = new Map();

// ============================================================
// Turso (SQLite) database-integrasjon
// ============================================================
let db = null;
let currentSessionId = null;

function initDatabase() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.warn('[DB] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN er ikke satt.');
    return;
  }

  let createClient;
  try {
    createClient = require('@libsql/client').createClient;
  } catch (err) {
    console.error('[DB] Kunne ikke laste @libsql/client.');
    return;
  }

  db = createClient({ url: url, authToken: authToken });

  ensureTables()
    .then(() => console.log('[DB] Tilkoblet Turso – tabeller verifisert.'))
    .catch(err => {
      console.error('[DB] Feil ved databaseinit:', err.message);
      db = null;
    });
}

async function ensureTables() {
  await db.execute(`CREATE TABLE IF NOT EXISTS poker_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    game_mode TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS player_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    hands_played INTEGER NOT NULL DEFAULT 0,
    hands_won INTEGER NOT NULL DEFAULT 0,
    total_chips INTEGER NOT NULL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS winning_hands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    player_uuid TEXT,
    player_name TEXT,
    hand_description TEXT,
    winning_cards TEXT,
    hand_rank INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function ensurePlayerStats(uuid, name) {
  if (!db || !uuid) return;
  db.execute({
    sql: `INSERT INTO player_stats (uuid, name, hands_played, hands_won, total_chips)
          VALUES (?, ?, 0, 0, 0)
          ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`,
    args: [uuid, name]
  }).catch(err => console.error('[DB] Feil ved registrering av spiller:', err.message));
}

function parseWinnerNames(winnerInfo) {
  if (!winnerInfo || !winnerInfo.winnerName) return [];
  let raw = winnerInfo.winnerName;
  if (raw.includes(':')) {
    raw = raw.split(':')[1];
  }
  return raw.split('&').map(s => s.trim()).filter(Boolean);
}

function isMonsterHand(descr) {
  if (!descr) return false;
  const d = descr.toLowerCase();
  return d.includes('straight flush') ||
         d.includes('fullt hus') ||
         d.includes('fire like') ||
         d.includes('royal');
}

async function persistHandResult() {
  const { winnerInfo, board, gameMode } = gameState;
  if (!winnerInfo) return;

  if (!winnerInfo.foldedWin && isMonsterHand(winnerInfo.descr) &&
      winnerInfo.winnerName && !winnerInfo.winnerName.startsWith('UAVGJOERT / DELING:')) {
    io.to('game').emit('celebrate_win', {
      playerName: winnerInfo.winnerName,
      handDescription: winnerInfo.descr,
      winningCards: winnerInfo.rawCards || []
    });
  }

  if (!db) {
    console.warn('[DB] Databasetilkobling mangler – kan ikke lagre.');
    return;
  }

  const inHand = Object.values(players).filter(p => !p.folded);
  const winnerNames = parseWinnerNames(winnerInfo);
  const description = winnerInfo.descr || 'Ukjent hånd';
  const rankVal = getHandRankValue(description);
  const nowIso = new Date().toISOString();

  try {
    if (!currentSessionId) {
      try {
        const ins = await db.execute({
          sql: "INSERT INTO poker_sessions (started_at, game_mode) VALUES (?, ?)",
          args: [nowIso, gameMode || 'OMAHA']
        });
        currentSessionId = Number(ins.lastInsertRowid) || 1;
      } catch (sErr) {
        console.warn('[DB] Kunne ikke opprette sesjon, bruker fallback ID 1:', sErr.message);
        currentSessionId = 1;
      }
    }

    // 1. Oppdater generell spillerstatistikk for alle spillere
    for (const p of Object.values(players)) {
      if (!p.uuid) continue;
      const isWinner = winnerNames.includes(p.name);
      await db.execute({
        sql: "UPDATE player_stats SET hands_played = hands_played + 1, hands_won = hands_won + ? WHERE uuid = ?",
        args: [isWinner ? 1 : 0, p.uuid]
      });
    }

    // 2. Lagre i winning_hands (Kjøres BÅDE ved Showdown og ved Fold dersom hånd beskrivelse finnes)
    let safeRawCards = [];
    if (Array.isArray(winnerInfo.rawCards)) {
      safeRawCards = winnerInfo.rawCards.map(c => {
        if (!c) return '';
        return typeof c.toString === 'function' ? c.toString() : String(c);
      });
    }

    const winningCardsStr = JSON.stringify({
      board: board || [],
      winningCards: safeRawCards,
      cards: inHand.map(p => ({ uuid: p.uuid || '', name: p.name || '', cards: p.cards || [] }))
    });

    const winnerPlayer = Object.values(players).find(p => winnerNames.includes(p.name));
    const playerUuid = winnerPlayer?.uuid || Object.values(players)[0]?.uuid || 'ukjent-uuid';
    const playerNameStr = winnerNames.length > 0 ? winnerNames.join(' & ') : 'Ukjent Spiller';

    await db.execute({
      sql: `INSERT INTO winning_hands (session_id, player_uuid, player_name, hand_description, winning_cards, hand_rank, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        currentSessionId,
        String(playerUuid),
        String(playerNameStr),
        String(description),
        String(winningCardsStr),
        Number(rankVal),
        nowIso
      ]
    });

    console.log(`[DB SUCCESS] Vinnerhånd lagret i winning_hands: ${playerNameStr} | ${description} (Rank: ${rankVal})`);
  } catch (err) {
    console.error('[DB ERROR] Feil under lagring av håndresultat:', err);
  }
}

function randomizePlayerSeats() {
  const playerArray = Object.values(players);
  if (playerArray.length <= 1) return;

  const shuffled = shuffle(playerArray);
  const newPlayersObj = {};

  shuffled.forEach((p, index) => {
    p.seat = index + 1;
    newPlayersObj[p.id] = p;
  });

  players = newPlayersObj;
  gameState.dealerIndex = 0;
}

function startNewHandLogic() {
  const playerList = Object.values(players);
  if (playerList.length === 0 || !gameState.gameMode) return;

  gameState.deck = createDeck();
  gameState.board = [];
  gameState.phase = 'PREFLOP';
  gameState.winnerInfo = null;

  gameState.dealerIndex = (gameState.dealerIndex + 1) % playerList.length;

  playerList.forEach((p, idx) => {
    p.folded = false;
    p.cards = [];
    
    const relativePos = (idx - gameState.dealerIndex + playerList.length) % playerList.length;

    if (playerList.length === 2) {
      p.role = relativePos === 0 ? 'Lilleblind' : 'Storeblind';
    } else {
      if (relativePos === 0) p.role = 'Dealer';
      else if (relativePos === 1) p.role = 'Lilleblind';
      else if (relativePos === 2) p.role = 'Storeblind';
      else p.role = '';
    }
    
    const cardCount = gameState.gameMode === 'OMAHA' ? 4 : 2;
    for (let i = 0; i < cardCount; i++) {
      p.cards.push(gameState.deck.pop());
    }
  });
}

io.on('connection', (socket) => {
  socket.on('join_game', (nameOrPayload) => {
    let cleanName = 'Spiller';
    let clientUuid = null;
    if (nameOrPayload && typeof nameOrPayload === 'object') {
      cleanName = nameOrPayload.name ? String(nameOrPayload.name).trim() : 'Spiller';
      clientUuid = nameOrPayload.uuid || null;
    } else {
      cleanName = nameOrPayload ? String(nameOrPayload).trim() : 'Spiller';
    }

    let existingPlayerKey = Object.keys(players).find(
      key => players[key].name.toLowerCase() === cleanName.toLowerCase()
    );

    if (existingPlayerKey) {
      const playerData = players[existingPlayerKey];

      if (disconnectTimeouts[existingPlayerKey]) {
        clearTimeout(disconnectTimeouts[existingPlayerKey]);
        delete disconnectTimeouts[existingPlayerKey];
      }

      delete players[existingPlayerKey];

      playerData.id = socket.id;
      playerData.connected = true;

      if (clientUuid && clientUuid !== playerData.uuid) {
        if (playerData.uuid) {
          uuidToPlayerId.delete(playerData.uuid);
        }
        playerData.uuid = clientUuid;
      }
      if (playerData.uuid) {
        uuidToPlayerId.set(playerData.uuid, socket.id);
      }

      players[socket.id] = playerData;
      ensurePlayerStats(playerData.uuid, playerData.name);
    } else {
      let playerUuid = clientUuid;
      if (!playerUuid) {
        try {
          playerUuid = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.randomUUID)
            ? globalThis.crypto.randomUUID()
            : null;
        } catch (e) { playerUuid = null; }
      }
      if (!playerUuid) {
        playerUuid = 'uuid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      }

      const seatNumber = Object.keys(players).length + 1;
      players[socket.id] = {
        id: socket.id,
        name: cleanName,
        uuid: playerUuid,
        seat: seatNumber,
        cards: [],
        folded: false,
        role: '',
        connected: true
      };
      uuidToPlayerId.set(playerUuid, socket.id);
      ensurePlayerStats(playerUuid, cleanName);
    }

    const joinedPlayer = players[socket.id];
    socket.emit('joined', { uuid: joinedPlayer.uuid, name: joinedPlayer.name });
    updateAll();
  });

  socket.on('set_game_mode', (mode) => {
    gameState.gameMode = mode;
    if (!mode) {
      gameState.phase = 'VENTING';
      gameState.board = [];
      gameState.winnerInfo = null;
    } else {
      randomizePlayerSeats();
    }
    updateAll();
  });

  socket.on('start_new_hand', () => {
    startNewHandLogic();
    updateAll();
  });

  socket.on('next_phase', async () => {
    const activePlayers = Object.values(players).filter(p => !p.folded);

    if (gameState.phase === 'FINISHED' || gameState.phase === 'SHOWDOWN') {
      startNewHandLogic();
      updateAll();
      return;
    }

    if (activePlayers.length === 1 && gameState.phase !== 'VENTING') {
      gameState.phase = 'FINISHED';
      gameState.winnerInfo = {
        winnerName: activePlayers[0].name,
        descr: 'Alle andre kastet seg',
        foldedWin: true,
        rawCards: [],
        rank: 0
      };
      await persistHandResult();
      updateAll();
      return;
    }

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
      
      const solvedHands = activePlayers.map(p => ({
        player: p,
        solved: evaluatePlayerHand(p.cards, gameState.board, gameState.gameMode)
      }));

      const handsOnly = solvedHands.map(sh => sh.solved);
      const winningHands = Hand.winners(handsOnly);
      
      const winners = solvedHands.filter(sh => winningHands.includes(sh.solved));
      
      let winnerText = '';
      if (winners.length > 1) {
        const names = winners.map(w => w.player.name).join(' & ');
        winnerText = `UAVGJOERT / DELING: ${names}`;
      } else {
        winnerText = winners[0].player.name;
      }

      const rawDescr = winners[0] ? winners[0].solved.descr : 'Ukjent hånd';

      gameState.winnerInfo = {
        winnerName: winnerText,
        descr: translateHandDescription(rawDescr),
        foldedWin: false,
        rawCards: winners[0] ? winners[0].solved.cards : []
      };

      await persistHandResult();
    }
    updateAll();
  });

  socket.on('player_fold', async () => {
    if (players[socket.id]) {
      players[socket.id].folded = true;
      
      const activePlayers = Object.values(players).filter(p => !p.folded);
      if (activePlayers.length === 1 && gameState.phase !== 'VENTING') {
        gameState.phase = 'FINISHED';
        gameState.winnerInfo = {
          winnerName: activePlayers[0].name,
          descr: 'Alle andre kastet seg',
          foldedWin: true,
          rawCards: [],
          rank: 0
        };
        await persistHandResult();
      }
      updateAll();
    }
  });

  socket.on('rejoin_game', (data) => {
    const uuid = (data && data.uuid) || (typeof data === 'string' ? data : null);
    if (!uuid) {
      socket.emit('rejoin_failed', { reason: 'Mangler UUID.' });
      return;
    }

    const existingId = uuidToPlayerId.get(uuid);
    if (!existingId) {
      socket.emit('rejoin_failed', { reason: 'Ukjent UUID.' });
      return;
    }

    const player = players[existingId];
    if (!player) {
      socket.emit('rejoin_failed', { reason: 'Spilleren finnes ikke lenger.' });
      return;
    }

    if (existingId !== socket.id) {
      if (disconnectTimeouts[existingId]) {
        clearTimeout(disconnectTimeouts[existingId]);
        delete disconnectTimeouts[existingId];
      }
      delete players[existingId];
    }

    player.connected = true;
    player.uuid = uuid;
    player.id = socket.id;
    players[socket.id] = player;
    uuidToPlayerId.set(uuid, socket.id);
    ensurePlayerStats(uuid, player.name);

    socket.emit('joined', { uuid: uuid, name: player.name });
    updateAll();
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      players[socket.id].connected = false;
      const disconnectedId = socket.id;
      const playerUuid = players[socket.id].uuid;

      if (disconnectTimeouts[disconnectedId]) {
        clearTimeout(disconnectTimeouts[disconnectedId]);
      }

      disconnectTimeouts[disconnectedId] = setTimeout(() => {
        delete players[disconnectedId];
        delete disconnectTimeouts[disconnectedId];
        if (playerUuid) {
          uuidToPlayerId.delete(playerUuid);
        }
        updateAll();
      }, 60000);

      updateAll();
    }
  });
});

function updateAll() {
  const playerList = Object.values(players);

  const showCardsOnScreen = gameState.phase === 'SHOWDOWN' && 
                            gameState.winnerInfo && 
                            !gameState.winnerInfo.foldedWin;

  io.emit('state_update', {
    gameMode: gameState.gameMode,
    phase: gameState.phase,
    board: gameState.board,
    winnerInfo: gameState.winnerInfo,
    players: playerList.map(p => ({
      name: p.name,
      seat: p.seat,
      role: p.role,
      folded: p.folded,
      connected: p.connected,
      cards: showCardsOnScreen && !p.folded ? p.cards : []
    }))
  });

  playerList.forEach(p => {
    if (p.connected) {
      io.to(p.id).emit('player_state', {
        phase: gameState.phase,
        cards: p.cards,
        role: p.role,
        folded: p.folded,
        winnerInfo: gameState.winnerInfo
      });
    }
  });
}

initDatabase();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));