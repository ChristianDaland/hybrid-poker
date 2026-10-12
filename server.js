// Laster miljøvariabler fra .env hvis tilgjengelig
try { require('dotenv').config(); } catch (err) { /* dotenv ikke installert – OK */ }

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
// Lengre pingTimeout gir telefoner med ustabilt wifi / kort dvale tid til å svare før de regnes som frakoblet
const io = new Server(server, { pingInterval: 25000, pingTimeout: 60000 });

app.use(express.static('public'));
app.use(express.json());

// ============================================================
// API: Statistikk, Topp 10 vinnerhender, DB-nullstilling og Inspeksjon
// ============================================================

app.get('/api/stats', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
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

// Henter de 10 beste hendene noensinne og sorterer fra 1. plass (beste) og nedover
app.get('/api/winning-hands', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  try {
    const result = await db.execute(`
      SELECT player_name, hand_description, winning_cards, hand_rank, created_at 
      FROM (
        SELECT player_name, hand_description, winning_cards, hand_rank, created_at, id
        FROM winning_hands
        ORDER BY hand_rank DESC, id DESC
        LIMIT 10
      )
      ORDER BY hand_rank DESC, id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/winning-hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-db', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
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
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
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

function getCardNumericValue(v) {
  if (typeof v === 'number') return v;
  const s = String(v).toUpperCase();
  if (s === 'A') return 14;
  if (s === 'K') return 13;
  if (s === 'Q') return 12;
  if (s === 'J') return 11;
  if (s === 'T' || s === '10') return 10;
  return parseInt(s, 10) || 2;
}

function calculateHandScore(solved) {
  if (!solved) return 1000;
  const baseRank = solved.rank || 1; 
  let cardValues = [];
  if (solved.cards && Array.isArray(solved.cards)) {
    cardValues = solved.cards.map(c => getCardNumericValue(c.value));
  }
  // 10 milliarder som multiplikator sikrer at håndkategorien (baseRank) alltid veier tyngst
  let score = baseRank * 10000000000;
  for (let i = 0; i < cardValues.length && i < 5; i++) {
    score += cardValues[i] * Math.pow(100, (4 - i));
  }
  return score;
}

function evaluatePlayerHand(playerCards, boardCards, gameMode) {
  if (gameMode === 'TEXAS') {
    return Hand.solve([...playerCards, ...boardCards]);
  } else {
    let bestHand = null;
    for (let i = 0; i < playerCards.length; i++) {
      for (let j = i + 1; j < playerCards.length; j++) {
        const hand2 = [playerCards[i], playerCards[j]];
        for (let b1 = 0; b1 < boardCards.length; b1++) {
          for (let b2 = b1 + 1; b2 < boardCards.length; b2++) {
            for (let b3 = b2 + 1; b3 < boardCards.length; b3++) {
              const combo = Hand.solve([...hand2, boardCards[b1], boardCards[b2], boardCards[b3]]);
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
  winnerUuids: [], // Kun på serveren – UUID gir tilgang til kortene og må ikke sendes ut
  dealerSeat: 0 // Setenummeret til forrige dealer (0 = ingen ennå)
};

let players = {};
const disconnectTimeouts = {};
const uuidToPlayerId = new Map();

// Hvor lenge en frakoblet spiller beholder plassen sin (telefoner som låser seg kobler fra)
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 5 * 60 * 1000;
const MAX_NAME_LENGTH = 15;
const ACTIVE_HAND_PHASES = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];

function isHandInProgress() {
  return ACTIVE_HAND_PHASES.includes(gameState.phase);
}

// Rekkefølgen rundt bordet bestemmes av setenummer – IKKE av socket-id/innsettingsrekkefølge
function getSeatedPlayers() {
  return Object.values(players).sort((a, b) => a.seat - b.seat);
}

function getNextSeatNumber() {
  const seats = Object.values(players).map(p => p.seat);
  return seats.length > 0 ? Math.max(...seats) + 1 : 1;
}

// En spiller er med i hånden hvis hen har kort og ikke har kastet seg
function isInHand(p) {
  return !p.folded && Array.isArray(p.cards) && p.cards.length > 0;
}

// Kast er lov så lenge spilleren er med og minst én annen også er med
// (den siste spilleren kan ikke kaste – da står ingen igjen)
function canFold(p) {
  if (!isHandInProgress() || !isInHand(p)) return false;
  return Object.values(players).filter(isInHand).length > 1;
}

// Et kast kan angres fram til neste kort åpnes (samme fase).
// Avsluttet kastet hånden (bare én igjen), er fasen FINISHED og angre er ikke mulig.
function canUndoFold(p) {
  return isHandInProgress() && p.folded && !p.waiting &&
         Array.isArray(p.cards) && p.cards.length > 0 &&
         p.foldedInPhase === gameState.phase;
}

function removePlayer(playerId) {
  const p = players[playerId];
  if (!p) return;
  delete players[playerId];
  if (p.uuid && uuidToPlayerId.get(p.uuid) === playerId) {
    uuidToPlayerId.delete(p.uuid);
  }
}

// Fjerner spillere som har vært frakoblet for lenge, men ventet til hånden var ferdig
function removePlayersMarkedForRemoval() {
  Object.values(players).forEach(p => {
    if (p.removeAfterHand && !p.connected) removePlayer(p.id);
  });
}

// Sikrer at en feil i én hendelse ikke krasjer hele serveren
function safeHandler(eventName, fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[FEIL i ${eventName}]:`, err);
      try { updateAll(); } catch (e) { /* ignorer */ }
    }
  };
}

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

async function ensurePlayerStats(uuid, name) {
  if (!db || !uuid) return;
  try {
    await db.execute({
      sql: `INSERT INTO player_stats (uuid, name, hands_played, hands_won, total_chips)
            VALUES (?, ?, 0, 0, 0)
            ON CONFLICT(uuid) DO UPDATE SET name = excluded.name`,
      args: [String(uuid), String(name)]
    });
  } catch (err) {
    console.error('[DB] Feil ved registrering av spiller:', err.message);
  }
}

async function persistHandResult() {
  const { winnerInfo, board, gameMode } = gameState;
  const winnerUuids = [...(gameState.winnerUuids || [])];
  // Øyeblikksbilde før første await – en ny hånd kan starte mens vi skriver til databasen
  const activePlayersList = Object.values(players).map(p => ({ ...p, cards: [...(p.cards || [])] }));

  if (!db) {
    console.error('[DB ERROR] Ingen databasetilkobling.');
    return;
  }

  if (!winnerInfo) {
    console.error('[DB ERROR] winnerInfo mangler.');
    return;
  }

  const rawDescr = winnerInfo.descr || 'Ukjent hånd';
  const rankVal = winnerInfo.rankVal !== undefined ? winnerInfo.rankVal : 0;
  const nowIso = new Date().toISOString();

  if (!currentSessionId) {
    try {
      const ins = await db.execute({
        sql: "INSERT INTO poker_sessions (started_at, game_mode) VALUES (?, ?)",
        args: [nowIso, gameMode || 'OMAHA']
      });
      currentSessionId = Number(ins.lastInsertRowid) || 1;
    } catch (sErr) {
      console.warn('[DB WARN] Kunne ikke opprette sesjon, bruker fallback ID 1:', sErr.message);
      currentSessionId = 1;
    }
  }

  // Vinnere identifiseres på UUID (ikke navn – «Ola» skal ikke matche «Olav»)
  const winners = activePlayersList.filter(p => p.uuid && winnerUuids.includes(p.uuid));

  const winnerNamesStr = winners.length > 0 
    ? winners.map(w => w.name).join(' & ') 
    : (winnerInfo.winnerName || 'Ukjent Spiller');

  const winnerUuidStr = winners.length > 0 
    ? winners.map(w => w.uuid).join(', ') 
    : 'ukjent-uuid';

  // Kun spillere som ble delt kort i denne hånden teller som «spilt»
  for (const p of activePlayersList) {
    if (!p.uuid || p.cards.length === 0) continue;
    const isWinner = winners.some(w => w.uuid === p.uuid);
    try {
      await ensurePlayerStats(p.uuid, p.name);
      await db.execute({
        sql: "UPDATE player_stats SET hands_played = hands_played + 1, hands_won = hands_won + ? WHERE uuid = ?",
        args: [isWinner ? 1 : 0, String(p.uuid)]
      });
    } catch (pErr) {
      console.error('[DB ERROR] Feil ved oppdatering av player_stats:', pErr.message);
    }
  }

  try {
    const cleanBoard = Array.isArray(board) ? board.map(c => String(c)) : [];
    const cleanWinningCards = Array.isArray(winnerInfo.rawCards) 
      ? winnerInfo.rawCards.map(c => (c && c.value && c.suit ? c.value + c.suit : String(c)))
      : [];

    const jsonPayload = JSON.stringify({
      board: cleanBoard,
      winningCards: cleanWinningCards,
      cards: activePlayersList.map(p => ({
        uuid: String(p.uuid || ''),
        name: String(p.name || ''),
        cards: Array.isArray(p.cards) ? p.cards.map(c => String(c)) : []
      }))
    });

    const res = await db.execute({
      sql: `INSERT INTO winning_hands (session_id, player_uuid, player_name, hand_description, winning_cards, hand_rank, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Number(currentSessionId),
        String(winnerUuidStr),
        String(winnerNamesStr),
        String(rawDescr),
        jsonPayload,
        Number(rankVal),
        nowIso
      ]
    });

    console.log('[DB SUCCESS] Skrevet til winning_hands! Rader satt inn:', res.rowsAffected);
  } catch (err) {
    console.error('[DB CRITICAL ERROR] Feil under skriving til winning_hands:', err.message);
  }
}

function randomizePlayerSeats() {
  const shuffled = shuffle(Object.values(players));
  shuffled.forEach((p, index) => {
    p.seat = index + 1;
  });
  gameState.dealerSeat = 0;
}

function startNewHandLogic() {
  if (!gameState.gameMode) return;

  removePlayersMarkedForRemoval();

  const playerList = getSeatedPlayers();
  if (playerList.length === 0) return;

  gameState.deck = createDeck();
  gameState.board = [];
  gameState.phase = 'PREFLOP';
  gameState.winnerInfo = null;
  gameState.winnerUuids = [];

  // Dealerknappen går til neste sete etter forrige dealer (fungerer selv om noen har gått)
  let dealerPos = playerList.findIndex(p => p.seat > gameState.dealerSeat);
  if (dealerPos === -1) dealerPos = 0;
  gameState.dealerSeat = playerList[dealerPos].seat;

  playerList.forEach((p, idx) => {
    p.folded = false;
    p.foldedInPhase = null;
    p.waiting = false;
    p.cards = [];

    const relativePos = (idx - dealerPos + playerList.length) % playerList.length;

    if (playerList.length === 2) {
      // Heads-up: dealer er også lilleblind
      p.role = relativePos === 0 ? 'Dealer / Lilleblind' : 'Storeblind';
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

// Avslutter hånden når kun én spiller er igjen. Returnerer true hvis hånden ble avsluttet.
async function finishIfOnlyOneLeft() {
  if (!isHandInProgress()) return false;
  const remaining = Object.values(players).filter(isInHand);
  if (remaining.length !== 1) return false;

  gameState.phase = 'FINISHED';
  gameState.winnerUuids = [remaining[0].uuid];
  gameState.winnerInfo = {
    winnerName: remaining[0].name,
    descr: 'Alle andre kastet seg',
    foldedWin: true,
    rawCards: [],
    rankVal: 0
  };
  await persistHandResult();
  return true;
}

io.on('connection', (socket) => {
  // Skjermer som lastes inn på nytt får dagens tilstand med en gang
  socket.emit('state_update', getPublicState());

  socket.on('join_game', safeHandler('join_game', async (nameOrPayload) => {
    let rawName = '';
    let clientUuid = null;
    if (nameOrPayload && typeof nameOrPayload === 'object') {
      rawName = nameOrPayload.name ? String(nameOrPayload.name) : '';
      clientUuid = nameOrPayload.uuid ? String(nameOrPayload.uuid) : null;
    } else {
      rawName = nameOrPayload ? String(nameOrPayload) : '';
    }

    const cleanName = rawName.trim().slice(0, MAX_NAME_LENGTH);
    if (!cleanName) {
      socket.emit('join_failed', { reason: 'Du må skrive inn et navn.' });
      return;
    }

    // 1) Samme telefon (UUID) -> samme spiller, uansett hva som er skrevet i navnefeltet
    const uuidKey = clientUuid ? uuidToPlayerId.get(clientUuid) : null;
    let existingPlayerKey = uuidKey && players[uuidKey] ? uuidKey : null;

    // 2) Ellers: samme navn. Kun lov å ta over plassen hvis den spilleren er frakoblet
    //    (f.eks. ny telefon/nettleser). Ellers kan hvem som helst se andres kort.
    if (!existingPlayerKey) {
      const nameKey = Object.keys(players).find(
        key => players[key].name.toLowerCase() === cleanName.toLowerCase()
      );
      if (nameKey && players[nameKey].connected && nameKey !== socket.id) {
        socket.emit('join_failed', {
          reason: `Navnet «${players[nameKey].name}» er allerede i bruk ved bordet. Velg et annet navn.`
        });
        return;
      }
      existingPlayerKey = nameKey || null;
    }

    if (existingPlayerKey) {
      const playerData = players[existingPlayerKey];

      if (disconnectTimeouts[existingPlayerKey]) {
        clearTimeout(disconnectTimeouts[existingPlayerKey]);
        delete disconnectTimeouts[existingPlayerKey];
      }

      delete players[existingPlayerKey];

      playerData.id = socket.id;
      playerData.connected = true;
      playerData.removeAfterHand = false;

      // Spilleren beholder sin opprinnelige UUID (statistikken følger spilleren).
      // Klienten får den tilbake i 'joined' og lagrer den.
      if (playerData.uuid) {
        uuidToPlayerId.set(playerData.uuid, socket.id);
      }

      players[socket.id] = playerData;
      await ensurePlayerStats(playerData.uuid, playerData.name);
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

      // Kommer spilleren inn midt i en hånd, venter hen til neste hånd
      const joinsMidHand = isHandInProgress();
      players[socket.id] = {
        id: socket.id,
        name: cleanName,
        uuid: playerUuid,
        seat: getNextSeatNumber(),
        cards: [],
        folded: joinsMidHand,
        waiting: joinsMidHand,
        role: '',
        connected: true
      };
      uuidToPlayerId.set(playerUuid, socket.id);
      await ensurePlayerStats(playerUuid, cleanName);
    }

    const joinedPlayer = players[socket.id];
    if (!joinedPlayer) return;
    socket.emit('joined', { uuid: joinedPlayer.uuid, name: joinedPlayer.name });
    updateAll();
  }));

  socket.on('set_game_mode', safeHandler('set_game_mode', (mode) => {
    gameState.gameMode = mode;
    if (!mode) {
      gameState.phase = 'VENTING';
      gameState.board = [];
      gameState.winnerInfo = null;
      gameState.winnerUuids = [];
    } else {
      randomizePlayerSeats();
    }
    updateAll();
  }));

  socket.on('start_new_hand', safeHandler('start_new_hand', () => {
    startNewHandLogic();
    updateAll();
  }));

  socket.on('next_phase', safeHandler('next_phase', async () => {
    if (gameState.phase === 'FINISHED' || gameState.phase === 'SHOWDOWN') {
      startNewHandLogic();
      updateAll();
      return;
    }

    if (!isHandInProgress()) return;

    if (await finishIfOnlyOneLeft()) {
      updateAll();
      return;
    }

    const activePlayers = Object.values(players).filter(isInHand);

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

      const solvedHands = activePlayers
        .map(p => ({
          player: p,
          solved: evaluatePlayerHand(p.cards, gameState.board, gameState.gameMode)
        }))
        .filter(sh => sh.solved);

      if (solvedHands.length === 0) {
        gameState.phase = 'FINISHED';
        gameState.winnerInfo = {
          winnerName: 'Ingen',
          descr: 'Ingen gyldige hender',
          foldedWin: true,
          rawCards: [],
          rankVal: 0
        };
        updateAll();
        return;
      }

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
      const exactRankVal = winners[0] ? calculateHandScore(winners[0].solved) : 0;

      gameState.winnerUuids = winners.map(w => w.player.uuid);
      gameState.winnerInfo = {
        winnerName: winnerText,
        descr: translateHandDescription(rawDescr),
        foldedWin: false,
        rawCards: winners[0] ? winners[0].solved.cards : [],
        rankVal: exactRankVal
      };

      await persistHandResult();
    }
    updateAll();
  }));

  socket.on('player_fold', safeHandler('player_fold', async () => {
    const player = players[socket.id];
    // Fold er kun lov midt i en hånd, og kun for spillere som faktisk er med.
    // Står bare én igjen etter kastet, avsluttes hånden med en gang (kan ikke angres).
    if (!player || !canFold(player)) return;

    player.folded = true;
    player.foldedInPhase = gameState.phase;
    await finishIfOnlyOneLeft();
    updateAll();
  }));

  socket.on('player_unfold', safeHandler('player_unfold', async () => {
    const player = players[socket.id];
    if (!player || !canUndoFold(player)) return;

    player.folded = false;
    player.foldedInPhase = null;
    updateAll();
  }));

  // Dealeren kaster kortene for en frakoblet spiller (fra statusskjermen),
  // slik at hånden ikke blir hengende på en telefon som er borte
  socket.on('host_fold_player', safeHandler('host_fold_player', async (seat) => {
    const player = Object.values(players).find(p => p.seat === Number(seat));
    if (!player || player.connected || !canFold(player)) return;

    player.folded = true;
    player.foldedInPhase = gameState.phase;
    await finishIfOnlyOneLeft();
    updateAll();
  }));

  socket.on('rejoin_game', safeHandler('rejoin_game', async (data) => {
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
    player.removeAfterHand = false;
    player.uuid = uuid;
    player.id = socket.id;
    players[socket.id] = player;
    uuidToPlayerId.set(uuid, socket.id);
    await ensurePlayerStats(uuid, player.name);

    socket.emit('joined', { uuid: uuid, name: player.name });
    updateAll();
  }));

  socket.on('disconnect', () => {
    const disconnectedId = socket.id;
    if (!players[disconnectedId]) return;

    players[disconnectedId].connected = false;

    if (disconnectTimeouts[disconnectedId]) {
      clearTimeout(disconnectTimeouts[disconnectedId]);
    }

    disconnectTimeouts[disconnectedId] = setTimeout(() => {
      delete disconnectTimeouts[disconnectedId];
      const p = players[disconnectedId];
      if (!p || p.connected) return;

      if (isHandInProgress()) {
        // Ikke fjern noen midt i en hånd – vent til neste hånd starter
        p.removeAfterHand = true;
      } else {
        removePlayer(disconnectedId);
      }
      updateAll();
    }, DISCONNECT_GRACE_MS);

    updateAll();
  });
});

// Offentlig tilstand for statusskjerm og projektor (ingen private kort før showdown)
function getPublicState() {
  const playerList = getSeatedPlayers();

  const showCardsOnScreen = gameState.phase === 'SHOWDOWN' && 
                            gameState.winnerInfo && 
                            !gameState.winnerInfo.foldedWin;

  return {
    gameMode: gameState.gameMode,
    phase: gameState.phase,
    board: gameState.board,
    winnerInfo: gameState.winnerInfo,
    players: playerList.map(p => ({
      name: p.name,
      seat: p.seat,
      role: p.role,
      folded: p.folded,
      waiting: !!p.waiting,
      connected: p.connected,
      cards: showCardsOnScreen && !p.folded ? p.cards : []
    }))
  };
}

function updateAll() {
  io.emit('state_update', getPublicState());

  getSeatedPlayers().forEach(p => {
    if (p.connected) {
      io.to(p.id).emit('player_state', {
        phase: gameState.phase,
        cards: p.cards,
        role: p.role,
        folded: p.folded,
        waiting: !!p.waiting,
        canFold: canFold(p),
        canUndoFold: canUndoFold(p),
        winnerInfo: gameState.winnerInfo
      });
    }
  });
}

// Siste sikkerhetsnett: logg uventede feil i stedet for å la serveren dø
process.on('unhandledRejection', (err) => {
  console.error('[UHÅNDTERT PROMISE-FEIL]:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[UHÅNDTERT FEIL]:', err);
});

initDatabase();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));