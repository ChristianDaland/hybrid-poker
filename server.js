// Laster miljøvariabler fra .env hvis tilgjengelig (kan også settes i systemet)
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

// ============================================================
// API: Statistikk og vinnerhender
// ============================================================
app.get('/api/stats', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet. Set TURSO_DATABASE_URL og TURSO_AUTH_TOKEN.' });
  }
  try {
    const result = await db.execute("SELECT name, hands_played, hands_won, total_chips FROM player_stats ORDER BY hands_won DESC, hands_played DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/stats]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/winning-hands', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet. Set TURSO_DATABASE_URL og TURSO_AUTH_TOKEN.' });
  }
  try {
    const result = await db.execute("SELECT player_name, hand_description, winning_cards, created_at FROM winning_hands ORDER BY created_at DESC, id DESC LIMIT 10");
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/winning-hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-hands', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database ikke tilkoblet. Set TURSO_DATABASE_URL og TURSO_AUTH_TOKEN.' });
  }
  try {
    // Dagens vinnerhender, rangert etter håndstyrke (beste øverst), topp 10
    const result = await db.execute(
      "SELECT id, player_name, hand_description, winning_cards, created_at FROM winning_hands WHERE date(created_at) = date('now') ORDER BY id DESC"
    );
    const top = result.rows
      .map(row => ({ ...row, _rank: handRank(row.hand_description) }))
      .sort((a, b) => (b._rank - a._rank) || (b.id - a.id))
      .slice(0, 10)
      .map(({ id, _rank, ...rest }) => rest);
    res.json(top);
  } catch (err) {
    console.error('[DB Error /api/top-hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rangerer en (norsk) håndbeskrivelse: 9 = Straight Flush (størst) … 0 = ukjent
function handRank(descr) {
  if (!descr) return 0;
  if (descr.includes('Straight Flush')) return 9;
  if (descr.includes('Fire like')) return 8;
  if (descr.includes('Fullt Hus')) return 7;
  if (descr.includes('Flush')) return 6;
  if (descr.includes('Straight')) return 5;
  if (descr.includes('Tre like')) return 4;
  if (descr.includes('To Par')) return 3;
  if (descr.includes('Ett Par')) return 2;
  if (descr.includes('Høyt Kort')) return 1;
  return 0;
}

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
  let text = descr;

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
    console.warn('[DB] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN er ikke satt – serveren kjører uten database.');
    return;
  }

  let createClient;
  try {
    createClient = require('@libsql/client').createClient;
  } catch (err) {
    console.error('[DB] Kunne ikke laste @libsql/client. Kjør: npm install');
    return;
  }

  db = createClient({ url: url, authToken: authToken });

  ensureTables()
    .then(() => console.log('[DB] Tilkoblet Turso – tabeller er opprettet/verifisert.'))
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

// Registrerer spiller i player_stats (eller oppdaterer navnet hvis vedkommende allerede finnes)
function ensurePlayerStats(uuid, name) {
  if (!db || !uuid) return;
  db.execute(
    `INSERT INTO player_stats (uuid, name, hands_played, hands_won, total_chips)
     VALUES (?, ?, 0, 0, 0)
     ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`,
    [uuid, name]
  ).catch(err => console.error('[DB] Feil ved registrering av spiller:', err.message));
}

// Trekker ut vinnernavn fra winnerInfo (håndterer delte potter)
function parseWinnerNames(winnerInfo) {
  if (!winnerInfo || !winnerInfo.winnerName) return [];
  const raw = winnerInfo.winnerName;
  if (raw.startsWith('UAVGJOERT / DELING:')) {
    return raw.split(':', 2)[1].split('&').map(s => s.trim()).filter(Boolean);
  }
  return [raw];
}

// Sjekker om en oversatt håndbeskrivelse er en «monsterhånd» som fortjener feiring
function isMonsterHand(descr) {
  if (!descr) return false;
  const d = descr.toLowerCase();
  return d.includes('straight/flush') ||
         d.includes('full house') ||
         d.includes('four of a kind') ||
         d.includes('royal');
}

// Lagrer forrige hånd i databasen. Kalles rett før en ny hånd deles,
// slik at både folded-win (FINISHED) og showdown (SHOWDOWN) fanges nøyaktig én gang.
function persistPreviousHand() {
  const { phase, winnerInfo, board, gameMode } = gameState;
  if (!winnerInfo) return;
  if (phase !== 'FINISHED' && phase !== 'SHOWDOWN') return;

  // 🎉 Feiring ved monsterhånd (virker uavhengig av databasen)
  if (!winnerInfo.foldedWin && isMonsterHand(winnerInfo.descr) &&
      winnerInfo.winnerName && !winnerInfo.winnerName.startsWith('UAVGJOERT / DELING:')) {
    io.to('game').emit('celebrate_win', {
      playerName: winnerInfo.winnerName,
      handDescription: winnerInfo.descr,
      winningCards: winnerInfo.rawCards || []
    });
    console.log('[FEIRING] Monsterhånd!', winnerInfo.winnerName, '–', winnerInfo.descr);
  }

  if (!db) return;

  const inHand = Object.values(players).filter(p => !p.folded);
  const winnerNames = parseWinnerNames(winnerInfo);
  const description = winnerInfo.descr || '';
  const winningCards = winnerInfo.foldedWin
    ? ''
    : JSON.stringify({ board: board, cards: inHand.map(p => ({ name: p.name, cards: p.cards })) });

  (async () => {
    // Åpne sesjon ved første hånd, eller forlenge den pågående
    let sessionId = currentSessionId;
    if (!sessionId) {
      await db.execute("UPDATE poker_sessions SET ended_at = datetime('now') WHERE ended_at IS NULL");
      const ins = await db.execute(
        "INSERT INTO poker_sessions (started_at, game_mode) VALUES (datetime('now'), ?)",
        [gameMode || 'UNKNOWN']
      );
      sessionId = Number(ins.lastInsertRowid);
      currentSessionId = sessionId;
    } else {
      await db.execute("UPDATE poker_sessions SET ended_at = datetime('now') WHERE id = ?", [sessionId]);
    }

    // Oppdater statistikk for de spillere som var med i hånden
    for (const p of inHand) {
      const isWinner = winnerNames.includes(p.name);
      await db.execute(
        "UPDATE player_stats SET hands_played = hands_played + 1, hands_won = hands_won + ? WHERE uuid = ?",
        [isWinner ? 1 : 0, p.uuid]
      );
    }

    // Logg vinnerhånden
    const winnerPlayer = inHand.find(p => winnerNames.includes(p.name));
    await db.execute(
      `INSERT INTO winning_hands (session_id, player_uuid, player_name, hand_description, winning_cards, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [sessionId, winnerPlayer ? winnerPlayer.uuid : null, winnerNames.join(' & '), description, winningCards]
    );
    console.log('[DB] Håndresultat lagret (vinner:', winnerNames.join(' & ') + ')');
  })().catch(err => console.error('[DB] Kunne ikke lagre håndresultat:', err.message));
}

// Hjælpefunksjon for å stokke om rekkefølgen på spillerne i `players`-objektet
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
  gameState.dealerIndex = 0; // Nullstill dealerknapp til første plass
}

function startNewHandLogic() {
  const playerList = Object.values(players);
  if (playerList.length === 0 || !gameState.gameMode) return;

  // Persist forrige hånd (hvis noen) i databasen før kortene nullstilles
  persistPreviousHand();

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
    // Støtter både gammelt format (navn som string) og nytt format ({ name, uuid })
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

      // Clear any pending disconnect timeout
      if (disconnectTimeouts[existingPlayerKey]) {
        clearTimeout(disconnectTimeouts[existingPlayerKey]);
        delete disconnectTimeouts[existingPlayerKey];
      }

      delete players[existingPlayerKey];

      playerData.id = socket.id;
      playerData.connected = true;

      // FIX: Oppdater UUID-mappingen slik at identiteten følger med det nye socketet
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
      // Generer vedvarende identitet for nye spillere
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

    // Send UUID tilbake til klienten slik at den kan lagres i localStorage
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
      // Stokker plassene til alle spillere når en spilletype velges
      randomizePlayerSeats();
    }
    updateAll();
  });

  socket.on('start_new_hand', () => {
    startNewHandLogic();
    updateAll();
  });

  socket.on('next_phase', () => {
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
        foldedWin: true
      };
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
    }
    updateAll();
  });

  socket.on('player_fold', () => {
    if (players[socket.id]) {
      players[socket.id].folded = true;
      
      const activePlayers = Object.values(players).filter(p => !p.folded);
      if (activePlayers.length === 1 && gameState.phase !== 'VENTING') {
        gameState.phase = 'FINISHED';
        gameState.winnerInfo = {
          winnerName: activePlayers[0].name,
          descr: 'Alle andre kastet seg',
          foldedWin: true
        };
      }
      updateAll();
    }
  });

  socket.on('rejoin_game', (data) => {
    const uuid = (data && data.uuid) || (typeof data === 'string' ? data : null);
    if (!uuid) {
      socket.emit('rejoin_failed', { reason: 'Mangler UUID. Last om siden og prøv igjen.' });
      return;
    }

    const existingId = uuidToPlayerId.get(uuid);
    if (!existingId) {
      socket.emit('rejoin_failed', { reason: 'Ukjent UUID. Spilleren er kanskje fjernet fra bordet.' });
      return;
    }

    const player = players[existingId];
    if (!player) {
      socket.emit('rejoin_failed', { reason: 'Spilleren finnes ikke lenger på bordet.' });
      return;
    }

    if (existingId !== socket.id) {
      // Clear any pending disconnect timeout
      if (disconnectTimeouts[existingId]) {
        clearTimeout(disconnectTimeouts[existingId]);
        delete disconnectTimeouts[existingId];
      }

      // Rebind player to new socket
      delete players[existingId];
    }

    player.connected = true;
    player.uuid = uuid;
    player.id = socket.id; // Viktig: updateAll() sender player_state til p.id
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

      // Clear any existing timeout for this socket
      if (disconnectTimeouts[disconnectedId]) {
        clearTimeout(disconnectTimeouts[disconnectedId]);
      }

      // 60-second grace period before permanently removing the player
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