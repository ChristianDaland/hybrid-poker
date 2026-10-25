// Laster miljøvariabler fra .env hvis tilgjengelig
try { require('dotenv').config(); } catch (err) { /* dotenv ikke installert – OK */ }

// All dato-logikk (dagens hender, omgangsnummer) skal følge norsk tid, også når
// serveren kjører i skyen (Render går i UTC). Kan overstyres med APP_TZ.
process.env.TZ = process.env.APP_TZ || 'Europe/Oslo';

const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
// Lengre pingTimeout gir telefoner med ustabilt wifi / kort dvale tid til å svare før de regnes som frakoblet
const io = new Server(server, { pingInterval: 25000, pingTimeout: 60000 });

app.use(express.static('public'));
app.use(express.json());

// Admin-endepunkter (tømme databasen, se rådata inkl. spiller-UUID-er) krever enten
// - riktig admin-passord (miljøvariabelen ADMIN_PASSWORD, sendes i headeren
//   x-admin-password) – brukes når serveren kjører på Render/internett, eller
// - at forespørselen kommer direkte fra maskinen som kjører serveren (npm start lokalt).
// UUID fungerer som innloggingsnøkkel, så rådata skal ikke kunne hentes av andre.
// ALLOW_REMOTE_ADMIN=1 åpner for alle (frarådes).
const crypto = require('crypto');

function passwordMatches(given) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || !given) return false;
  // Sammenlign hasher med fast lengde (tidskonstant sammenligning)
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function isDirectLocalRequest(req) {
  // Bak en proxy (Render) er forespørselen aldri «lokal», uansett avsenderadresse
  if (req.headers['x-forwarded-for']) return false;
  const addr = req.socket.remoteAddress || '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
}

function adminOnly(req, res, next) {
  if (process.env.ALLOW_REMOTE_ADMIN === '1') return next();
  if (passwordMatches(req.headers['x-admin-password'])) return next();
  if (isDirectLocalRequest(req)) return next();

  const passwordSet = !!process.env.ADMIN_PASSWORD;
  const respond = () => res.status(403).json({
    error: passwordSet ? 'Feil eller manglende admin-passord.' : 'Admin-passord er ikke satt opp på serveren (ADMIN_PASSWORD).',
    needsPassword: passwordSet
  });
  // Litt forsinkelse ved feil passord gjør gjetting tregere
  if (req.headers['x-admin-password']) setTimeout(respond, 1000); else respond();
}

// ============================================================
// API: Statistikk, Topp 10 vinnerhender, DB-nullstilling og Inspeksjon
// ============================================================

app.get('/api/stats', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  try {
    const result = await db.execute(`
      SELECT 
        ps.name, 
        SUM(ps.hands_played) as hands_played, 
        SUM(ps.hands_won) as hands_won,
        (SELECT COUNT(*) FROM omganger o WHERE LOWER(o.winner_name) = LOWER(ps.name)) as rounds_won
      FROM player_stats ps
      GROUP BY LOWER(ps.name)
      ORDER BY rounds_won DESC, hands_won DESC, hands_played DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('[DB Error /api/stats]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serverens adresser på lokalnettet – brukes til QR-koden når statusskjermen
// er åpnet via localhost (telefonene kan ikke nå «localhost»)
function getLanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  // Vanlige hjemmenett først (192.168.x, 10.x, 172.16–31.x); VPN o.l. (f.eks. 100.x) sist
  const rank = ip => ip.startsWith('192.168.') ? 0
    : ip.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2
    : 3;
  return addresses.sort((a, b) => rank(a) - rank(b));
}

app.get('/api/server-info', (req, res) => {
  res.json({ lanAddresses: getLanAddresses(), port: Number(PORT) });
});

// ------------------------------------------------------------
// Dato-hjelpere. Tidspunkter lagres som ISO/UTC. Turso kjører i UTC, så
// «dag» regnes ut her i Node (serverens lokale tidssone, dvs. norsk tid).
// ------------------------------------------------------------
function parseDateParam(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : undefined;
}

// Eldre rader kan ha SQLite-format «ÅÅÅÅ-MM-DD TT:MM:SS» (UTC). Med «T» i stedet
// for mellomrom sammenlignes de riktig mot ISO-strenger.
const CREATED_AT_ISO = "REPLACE(created_at, ' ', 'T')";

function normalizeTimestamp(value) {
  const s = String(value || '');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
}

// Lokal midnatt -> neste lokale midnatt, som ISO-strenger
function localDayRange(date) {
  const start = new Date(date.y, date.m - 1, date.d);
  const end = new Date(date.y, date.m - 1, date.d + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function localDateString(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// omgang_id -> { number, date }: «Omgang 3» = tredje omgang som startet den dagen
async function getRoundNumbers(roundIds) {
  const ids = [...new Set(roundIds.filter(id => id !== null && id !== undefined).map(Number))];
  if (ids.length === 0) return {};
  const rounds = await db.execute({
    sql: `SELECT omgang_id, started_at FROM omganger WHERE omgang_id IN (${ids.map(() => '?').join(',')})`,
    args: ids
  });
  const result = {};
  for (const r of rounds.rows) {
    const day = localDateString(r.started_at);
    const range = localDayRange(parseDateParam(day));
    const count = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM omganger WHERE started_at >= ? AND started_at <= ?",
      args: [range.start, r.started_at]
    });
    result[Number(r.omgang_id)] = { number: Number(count.rows[0].n), date: day };
  }
  return result;
}

// Legger til omgangsnummer og vinnerkort på hver hånd
async function decorateHands(rows) {
  const numbers = await getRoundNumbers(rows.map(r => r.omgang_id));
  return rows.map(r => {
    let winningCards = [];
    try { winningCards = JSON.parse(r.winning_cards || '{}').winningCards || []; } catch (e) { /* ignorer */ }
    const round = r.omgang_id != null ? numbers[Number(r.omgang_id)] : null;
    return {
      id: r.id,
      player_name: r.player_name,
      hand_description: retranslateStoredDescription(r.hand_description),
      hand_rank: r.hand_rank,
      created_at: normalizeTimestamp(r.created_at),
      omgang_id: r.omgang_id,
      omgang_nr: round ? round.number : null,
      omgang_date: round ? round.date : null,
      winning_cards: winningCards
    };
  });
}

// Topp 10 beste hender. Med ?date=ÅÅÅÅ-MM-DD: kun den dagen. Uten: all time.
// Seire der alle andre kastet seg (hand_rank 0) teller ikke.
app.get('/api/winning-hands', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  const date = parseDateParam(req.query.date);
  if (date === undefined) return res.status(400).json({ error: 'Ugyldig dato.' });
  try {
    const range = date ? localDayRange(date) : null;
    const result = await db.execute({
      sql: `SELECT id, player_name, hand_description, winning_cards, hand_rank, created_at, omgang_id
            FROM winning_hands
            WHERE hand_rank > 0 ${range ? `AND ${CREATED_AT_ISO} >= ? AND ${CREATED_AT_ISO} < ?` : ''}
            ORDER BY hand_rank DESC, id ASC
            LIMIT 10`,
      args: range ? [range.start, range.end] : []
    });
    res.json(await decorateHands(result.rows));
  } catch (err) {
    console.error('[DB Error /api/winning-hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Alle hender en gitt dag, i rekkefølge
app.get('/api/hands', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  const date = parseDateParam(req.query.date);
  if (!date) return res.status(400).json({ error: 'Mangler eller ugyldig dato.' });
  try {
    const range = localDayRange(date);
    const result = await db.execute({
      sql: `SELECT id, player_name, hand_description, winning_cards, hand_rank, created_at, omgang_id
            FROM winning_hands
            WHERE ${CREATED_AT_ISO} >= ? AND ${CREATED_AT_ISO} < ?
            ORDER BY ${CREATED_AT_ISO} ASC, id ASC`,
      args: [range.start, range.end]
    });
    res.json(await decorateHands(result.rows));
  } catch (err) {
    console.error('[DB Error /api/hands]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Omganger som startet en gitt dag, med vinner og antall hender
app.get('/api/rounds', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  const date = parseDateParam(req.query.date);
  if (!date) return res.status(400).json({ error: 'Mangler eller ugyldig dato.' });
  try {
    const range = localDayRange(date);
    const result = await db.execute({
      sql: `SELECT o.omgang_id, o.started_at, o.ended_at, o.game_mode, o.winner_name,
                   (SELECT COUNT(*) FROM winning_hands w WHERE w.omgang_id = o.omgang_id) AS hands
            FROM omganger o
            WHERE o.started_at >= ? AND o.started_at < ?
            ORDER BY o.started_at ASC`,
      args: [range.start, range.end]
    });
    res.json(result.rows.map((r, idx) => ({ ...r, omgang_nr: idx + 1 })));
  } catch (err) {
    console.error('[DB Error /api/rounds]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug-db', adminOnly, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  try {
    const hands = await db.execute("SELECT * FROM winning_hands ORDER BY id DESC");
    const stats = await db.execute("SELECT * FROM player_stats ORDER BY id DESC");
    const sessions = await db.execute("SELECT * FROM poker_sessions ORDER BY id DESC");
    const rounds = await db.execute("SELECT * FROM omganger ORDER BY omgang_id DESC");

    res.json({
      winning_hands: hands.rows,
      player_stats: stats.rows,
      poker_sessions: sessions.rows,
      omganger: rounds.rows
    });
  } catch (err) {
    console.error('[DB Error /api/debug-db]:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reset-db', adminOnly, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  try {
    await db.execute("DELETE FROM winning_hands");
    await db.execute("DELETE FROM player_stats");
    await db.execute("DELETE FROM poker_sessions");
    await db.execute("DELETE FROM omganger");
    currentSessionId = null;
    currentRoundId = null;
    console.log('[DB] Databasen er tømt for testdata!');
    res.json({ message: 'Databasen er tømt for all data.' });
  } catch (err) {
    console.error('[DB Error /api/reset-db]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sletter all data fra én dag (standard: i dag, norsk tid) – f.eks. testing på dagen før
// turneringen om kvelden. Hender, omganger og sesjoner fra dagen slettes, og hendene trekkes
// fra spillerstatistikken. Etterpå starter neste hånd omgang 1 (ingen er ute).
app.post('/api/reset-day', adminOnly, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Database ikke tilkoblet.' });
  // Ikke midt i en hånd, og ikke mens forrige hånd fortsatt lagres (den ville kommet inn igjen etterpå)
  if (isHandInProgress() || persistsInFlight > 0) return res.status(409).json({ error: 'En hånd pågår – vent til den er ferdig.' });
  const given = parseDateParam(req.query.date);
  if (given === undefined) return res.status(400).json({ error: 'Ugyldig dato.' });
  const date = given || parseDateParam(localDateString(new Date().toISOString()));
  try {
    const range = localDayRange(date);
    const hands = await db.execute({
      sql: `SELECT id, player_uuid, winning_cards, deltakere FROM winning_hands
            WHERE ${CREATED_AT_ISO} >= ? AND ${CREATED_AT_ISO} < ?`,
      args: [range.start, range.end]
    });

    // Hvor mange hender hver spiller skal trekkes for (spilt / vunnet)
    const played = {}, won = {};
    const add = (map, uuid) => { if (uuid && uuid !== 'ukjent-uuid') map[uuid] = (map[uuid] || 0) + 1; };
    for (const h of hands.rows) {
      const winnerUuids = String(h.player_uuid || '').split(',').map(u => u.trim()).filter(Boolean);
      winnerUuids.forEach(u => add(won, u));
      let participants = null;
      try { participants = JSON.parse(h.deltakere || 'null'); } catch (e) { participants = null; }
      if (!Array.isArray(participants)) {
        // Eldre rader uten deltakerliste: vinnerne og de som viste kort ved showdown
        let shown = [];
        try { shown = (JSON.parse(h.winning_cards || '{}').cards || []).map(c => c.uuid); } catch (e) { shown = []; }
        participants = [...new Set([...winnerUuids, ...shown])];
      }
      participants.forEach(u => add(played, u));
    }
    const affected = [...new Set([...Object.keys(played), ...Object.keys(won)])];

    // Alt i én transaksjon: enten trekkes statistikken og dagens rader slettes, eller ingenting
    const results = await db.batch([
      ...affected.map(uuid => ({
        sql: `UPDATE player_stats SET hands_played = MAX(0, hands_played - ?), hands_won = MAX(0, hands_won - ?) WHERE uuid = ?`,
        args: [played[uuid] || 0, won[uuid] || 0, uuid]
      })),
      // Spillere som ikke har noen hender igjen (f.eks. testnavn) fjernes fra statistikken
      ...affected.map(uuid => ({
        sql: "DELETE FROM player_stats WHERE uuid = ? AND hands_played <= 0 AND hands_won <= 0",
        args: [uuid]
      })),
      { sql: `DELETE FROM winning_hands WHERE ${CREATED_AT_ISO} >= ? AND ${CREATED_AT_ISO} < ?`, args: [range.start, range.end] },
      { sql: "DELETE FROM omganger WHERE started_at >= ? AND started_at < ?", args: [range.start, range.end] },
      {
        sql: "DELETE FROM poker_sessions WHERE REPLACE(started_at, ' ', 'T') >= ? AND REPLACE(started_at, ' ', 'T') < ?",
        args: [range.start, range.end]
      }
    ], 'write');
    const n = affected.length * 2;
    const deletedHands = results[n].rowsAffected;
    const deletedRounds = results[n + 1].rowsAffected;

    if (currentSessionId) {
      const s = await db.execute({ sql: "SELECT id FROM poker_sessions WHERE id = ?", args: [Number(currentSessionId)] });
      if (s.rows.length === 0) currentSessionId = null;
    }
    // Var pågående omgang fra den slettede dagen, starter neste hånd omgang 1 (alle er med).
    // En omgang fra en annen dag røres ikke.
    let roundDeleted = false;
    if (currentRoundId) {
      const r = await db.execute({ sql: "SELECT omgang_id FROM omganger WHERE omgang_id = ?", args: [Number(currentRoundId)] });
      roundDeleted = r.rows.length === 0;
    } else if (gameState.roundStartedAt) {
      roundDeleted = gameState.roundStartedAt >= range.start && gameState.roundStartedAt < range.end;
    }
    if (roundDeleted) {
      Object.values(players).forEach(p => { p.out = false; });
      startNewRound();
    }
    updateAll();

    console.log(`[DB] Slettet data for ${localDateString(range.start)}: ${deletedHands} hender, ${deletedRounds} omganger.`);
    res.json({
      message: `Slettet ${deletedHands} hender og ${deletedRounds} omganger.`,
      hands: deletedHands,
      rounds: deletedRounds
    });
  } catch (err) {
    console.error('[DB Error /api/reset-day]:', err);
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

// Kortverdier på norsk: entall («Konge-høy») og flertall («Konger»)
const VALUE_NAMES = {
  A: ['Ess', 'Ess'], K: ['Konge', 'Konger'], Q: ['Dame', 'Damer'], J: ['Knekt', 'Knekter'], T: ['10', '10-ere']
};
const SUIT_NAMES = { h: 'hjerter', d: 'ruter', c: 'kløver', s: 'spar' };

function valueName(v, plural) {
  const key = String(v).toUpperCase() === '10' ? 'T' : String(v).toUpperCase();
  if (VALUE_NAMES[key]) return VALUE_NAMES[key][plural ? 1 : 0];
  return plural ? `${key}-ere` : key;
}

// Oversetter pokersolver sine beskrivelser, f.eks.
// «Flush, Qd High» -> «Flush, Dame-høy i ruter», «Two Pair, A's & 2's» -> «To par, Ess og 2-ere»
function translateHandDescription(descr) {
  const text = String(descr || '').trim();
  if (!text) return 'Ukjent hånd';
  const V = '(10|[2-9TJQKA])';
  let m;

  if (/^(Wild )?Royal Flush$/.test(text)) return 'Royal Flush';
  if ((m = new RegExp(`^Straight Flush, ${V}([cdhs]) High$`).exec(text))) {
    return `Straight Flush, ${valueName(m[1])}-høy i ${SUIT_NAMES[m[2]]}`;
  }
  if ((m = new RegExp(`^Four of a Kind, ${V}'s$`).exec(text))) return `Fire like, ${valueName(m[1], true)}`;
  if ((m = new RegExp(`^Full House, ${V}'s over ${V}'s$`).exec(text))) {
    return `Fullt hus, ${valueName(m[1], true)} over ${valueName(m[2], true)}`;
  }
  if ((m = new RegExp(`^Flush, ${V}([cdhs]) High$`).exec(text))) {
    return `Flush, ${valueName(m[1])}-høy i ${SUIT_NAMES[m[2]]}`;
  }
  if (/^Straight, Wheel$/.test(text)) return 'Straight, 5-høy';
  if ((m = new RegExp(`^Straight, ${V} High$`).exec(text))) return `Straight, ${valueName(m[1])}-høy`;
  if ((m = new RegExp(`^Three of a Kind, ${V}'s$`).exec(text))) return `Tre like, ${valueName(m[1], true)}`;
  if ((m = new RegExp(`^Two Pair, ${V}'s & ${V}'s$`).exec(text))) {
    return `To par, ${valueName(m[1], true)} og ${valueName(m[2], true)}`;
  }
  if ((m = new RegExp(`^Pair, ${V}'s$`).exec(text))) return `Ett par, ${valueName(m[1], true)}`;
  if ((m = new RegExp(`^${V} High$`).exec(text))) return `Høyt kort, ${valueName(m[1])}`;

  // Ukjent format: vis teksten som den er
  return text;
}

// Eldre rader i databasen har en halvoversatt tekst (f.eks. «To Par, A's & 2's»).
// Den gjøres om til pokersolver-format og oversettes på nytt ved visning.
function retranslateStoredDescription(descr) {
  const text = String(descr || '');
  const english = text
    .replace(/^Fire like/, 'Four of a Kind')
    .replace(/^Fullt Hus/, 'Full House')
    .replace(/^Tre like/, 'Three of a Kind')
    .replace(/^To Par/, 'Two Pair')
    .replace(/^Ett Par/, 'Pair');
  const translated = translateHandDescription(english);
  return translated === english ? text : translated;
}

// Kortkode («As», «Td») fra et pokersolver-kort. I en straight A-2-3-4-5 gir pokersolver
// esset verdien «1» – det skal fortsatt vises og lagres som «A».
function cardCode(c) {
  if (!c || typeof c !== 'object') return String(c);
  return (c.value === '1' ? 'A' : c.value) + c.suit;
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
  roundStartedAt: null,  // Når første hånd i pågående omgang startet
  roundFinished: false,  // Omgangen er avgjort (vinner funnet)
  winnerUuids: [], // Kun på serveren – UUID gir tilgang til kortene og må ikke sendes ut
  dealerSeat: 0, // Setenummeret til forrige dealer (0 = ingen ennå)
  seatsDrawn: false, // Plassene er trukket – bytte av spilletype trekker ikke på nytt
  handNumber: 0,     // «Hånd N» i pågående omgang (vises på statusskjermen)
  roundNumber: null  // «Omgang N» = N-te omgang som startet denne dagen (som i dashboardet)
};

let players = {};
const disconnectTimeouts = {};
const uuidToPlayerId = new Map();
// Spillere som ble kastet ut ved «Nytt spill». Telefoner som sov da, skal ikke
// logge seg stille inn igjen når de våkner (kun manuell innlogging slipper inn).
const kickedUuids = new Set();

// Hvor lenge en frakoblet spiller beholder plassen sin (telefoner som låser seg kobler fra)
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 5 * 60 * 1000;
const MAX_NAME_LENGTH = 15;
// Flere enn 8 får ikke plass rundt bordet på statusskjermen
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 8;
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
  compactSeats();
}

// Nummererer setene 1..n uten hull (rekkefølgen beholdes) etter at noen har gått.
// Dealerknappen flyttes med, så neste dealer blir den samme som før.
function compactSeats() {
  const seated = getSeatedPlayers();
  const oldDealerSeat = gameState.dealerSeat;
  gameState.dealerSeat = seated.filter(p => p.seat <= oldDealerSeat).length;
  seated.forEach((p, idx) => { p.seat = idx + 1; });
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
let currentRoundId = null;        // omgang_id i databasen for pågående omgang
let roundRowPromise = null;       // hindrer at to samtidige kall oppretter to rader
// «Ute»-markeringer gjenopprettet fra databasen etter en omstart (UUID-er).
// Brukes når spillerne logger inn igjen.
let restoredOutUuids = new Set();
// En åpen omgang med aktivitet innenfor dette vinduet fortsetter etter omstart
// (Render legger tjenesten i dvale etter 15 min uten trafikk, og hver deploy starter den på nytt).
const ROUND_RESUME_WINDOW_MS = (Number(process.env.ROUND_RESUME_MINUTES) || 180) * 60 * 1000;

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
  // En omgang = fra alle er med til alle unntatt én er ute. Flere omganger per kveld.
  await db.execute(`CREATE TABLE IF NOT EXISTS omganger (
    omgang_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    game_mode TEXT,
    winner_uuid TEXT,
    winner_name TEXT
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

  // Migrering: eldre databaser mangler omgang_id i winning_hands
  const cols = await db.execute("PRAGMA table_info(winning_hands)");
  if (!cols.rows.some(c => c.name === 'omgang_id')) {
    await db.execute("ALTER TABLE winning_hands ADD COLUMN omgang_id INTEGER");
    console.log('[DB] La til kolonnen omgang_id i winning_hands.');
  }

  // Migrering: hvem som fikk kort i hånden (UUID-er) – trengs for å kunne trekke
  // hender fra statistikken når dagens testdata slettes
  if (!cols.rows.some(c => c.name === 'deltakere')) {
    await db.execute("ALTER TABLE winning_hands ADD COLUMN deltakere TEXT");
    console.log('[DB] La til kolonnen deltakere i winning_hands.');
  }

  // Migrering: «ute»-markeringer lagres per omgang, så de overlever en omstart
  const roundCols = await db.execute("PRAGMA table_info(omganger)");
  if (!roundCols.rows.some(c => c.name === 'out_uuids')) {
    await db.execute("ALTER TABLE omganger ADD COLUMN out_uuids TEXT");
    console.log('[DB] La til kolonnen out_uuids i omganger.');
  }

  await scrubUnshownCards();
  await resumeOrCloseOpenRounds();
}

// Ved oppstart: den nyeste åpne omgangen med aktivitet siste 3 timer fortsetter
// (inkl. hvem som er ute). Eldre åpne omganger avsluttes uten vinner («avbrutt»).
async function resumeOrCloseOpenRounds() {
  const open = await db.execute(`
    SELECT o.omgang_id, o.started_at, o.out_uuids,
           (SELECT MAX(${CREATED_AT_ISO}) FROM winning_hands w WHERE w.omgang_id = o.omgang_id) AS last_hand
    FROM omganger o
    WHERE o.ended_at IS NULL
    ORDER BY o.started_at DESC`);
  let closed = 0;
  for (const r of open.rows) {
    const lastActivity = normalizeTimestamp(r.last_hand || r.started_at);
    const age = Date.now() - Date.parse(lastActivity);
    if (!currentRoundId && age <= ROUND_RESUME_WINDOW_MS) {
      currentRoundId = Number(r.omgang_id);
      gameState.roundStartedAt = r.started_at;
      try { restoredOutUuids = new Set(JSON.parse(r.out_uuids || '[]')); } catch (e) { restoredOutUuids = new Set(); }
      const handCount = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM winning_hands WHERE omgang_id = ?",
        args: [currentRoundId]
      });
      gameState.handNumber = Number(handCount.rows[0].n);
      await assignRoundNumber();
      console.log(`[DB] Fortsetter omgang ${currentRoundId} etter omstart (${restoredOutUuids.size} ute).`);
    } else {
      await db.execute({
        sql: "UPDATE omganger SET ended_at = ? WHERE omgang_id = ?",
        args: [lastActivity, Number(r.omgang_id)]
      });
      closed++;
    }
  }
  if (closed > 0) console.log(`[DB] Avsluttet ${closed} forlatte omganger (avbrutt).`);
}

// Engangsopprydding av eldre rader (uten "v":2), som lagret kortene til alle spillere:
// - Alle andre kastet seg (hand_rank 0): alle spillerkort og vinnerkort fjernes.
// - Showdown: kortene per spiller fjernes (det går ikke å se hvem som kastet seg).
//   Vinnerhånden og bordkortene beholdes.
// Kjøres ved hver oppstart, men rører kun rader som ikke er ryddet ennå.
async function scrubUnshownCards() {
  const rows = await db.execute(
    "SELECT id, hand_rank, winning_cards FROM winning_hands WHERE winning_cards IS NULL OR winning_cards NOT LIKE '%\"v\":2%'"
  );
  let cleaned = 0;
  for (const r of rows.rows) {
    let payload = {};
    try { payload = JSON.parse(r.winning_cards || '{}') || {}; } catch (e) { payload = {}; }
    const isFoldedWin = Number(r.hand_rank) === 0;
    const scrubbed = {
      v: 2,
      board: Array.isArray(payload.board) ? payload.board : [],
      winningCards: isFoldedWin ? [] : (Array.isArray(payload.winningCards) ? payload.winningCards : []),
      cards: []
    };
    await db.execute({
      sql: "UPDATE winning_hands SET winning_cards = ? WHERE id = ?",
      args: [JSON.stringify(scrubbed), Number(r.id)]
    });
    cleaned++;
  }
  if (cleaned > 0) console.log(`[DB] Fjernet ikke-viste kort fra ${cleaned} eldre hender.`);
}

async function ensureSession(nowIso) {
  if (currentSessionId) return currentSessionId;
  try {
    const ins = await db.execute({
      sql: "INSERT INTO poker_sessions (started_at, game_mode) VALUES (?, ?)",
      args: [nowIso, gameState.gameMode || 'OMAHA']
    });
    currentSessionId = Number(ins.lastInsertRowid) || 1;
  } catch (sErr) {
    console.warn('[DB WARN] Kunne ikke opprette sesjon, bruker fallback ID 1:', sErr.message);
    currentSessionId = 1;
  }
  return currentSessionId;
}

// Oppretter raden for pågående omgang første gang den trengs
async function ensureRoundRow() {
  if (!db) return null;
  if (currentRoundId) return currentRoundId;
  if (!roundRowPromise) {
    roundRowPromise = (async () => {
      const nowIso = new Date().toISOString();
      const sessionId = await ensureSession(nowIso);
      const ins = await db.execute({
        sql: "INSERT INTO omganger (session_id, started_at, game_mode) VALUES (?, ?, ?)",
        args: [Number(sessionId), gameState.roundStartedAt || nowIso, gameState.gameMode || null]
      });
      currentRoundId = Number(ins.lastInsertRowid);
      console.log('[DB] Ny omgang startet, omgang_id =', currentRoundId);
      return currentRoundId;
    })().finally(() => { roundRowPromise = null; });
  }
  return roundRowPromise;
}

// Omgangen er avgjort (alle unntatt én er ute)
async function finishRound(winner) {
  gameState.roundFinished = true;
  if (!db) return;
  try {
    const roundId = await ensureRoundRow();
    await db.execute({
      sql: "UPDATE omganger SET ended_at = ?, winner_uuid = ?, winner_name = ? WHERE omgang_id = ?",
      args: [new Date().toISOString(), String(winner.uuid || ''), String(winner.name), Number(roundId)]
    });
  } catch (err) {
    console.error('[DB] Feil ved avslutning av omgang:', err.message);
  }
}

// Dealeren angret «ute»-markeringen som avgjorde omgangen
async function reopenRound() {
  gameState.roundFinished = false;
  if (!db || !currentRoundId) return;
  try {
    await db.execute({
      sql: "UPDATE omganger SET ended_at = NULL, winner_uuid = NULL, winner_name = NULL WHERE omgang_id = ?",
      args: [Number(currentRoundId)]
    });
  } catch (err) {
    console.error('[DB] Feil ved gjenåpning av omgang:', err.message);
  }
}

// Lagrer hvem som er ute i pågående omgang (overlever omstart av serveren)
async function saveOutUuids() {
  if (!db) return;
  try {
    const present = new Set(Object.values(players).map(p => p.uuid));
    const outUuids = Object.values(players).filter(p => p.out && p.uuid).map(p => p.uuid);
    // Ute-markerte som ikke har logget inn igjen etter en omstart, beholdes
    restoredOutUuids.forEach(u => { if (!present.has(u)) outUuids.push(u); });
    const roundId = await ensureRoundRow();
    await db.execute({
      sql: "UPDATE omganger SET out_uuids = ? WHERE omgang_id = ?",
      args: [JSON.stringify(outUuids), Number(roundId)]
    });
  } catch (err) {
    console.error('[DB] Feil ved lagring av ute-markeringer:', err.message);
  }
}

// En omgang som ikke ble avgjort (Nytt spill / Ny omgang) avsluttes uten vinner («avbrutt»)
async function closeUnfinishedRound() {
  if (!db || !currentRoundId || gameState.roundFinished) return;
  try {
    await db.execute({
      sql: "UPDATE omganger SET ended_at = ? WHERE omgang_id = ? AND ended_at IS NULL",
      args: [new Date().toISOString(), Number(currentRoundId)]
    });
  } catch (err) {
    console.error('[DB] Feil ved avslutning av omgang:', err.message);
  }
}

// «Ny omgang»: neste hånd hører til en ny omgang
function startNewRound() {
  currentRoundId = null;
  gameState.roundStartedAt = null;
  gameState.roundFinished = false;
  gameState.handNumber = 0;
  gameState.roundNumber = null;
  restoredOutUuids = new Set();
}

// Uten database: omganger startet per dag (norsk tid) – «Omgang N» starter på 1 hver dag
const roundsWithoutDb = { date: null, count: 0 };
function nextRoundNumberWithoutDb(startedAtIso) {
  const day = localDateString(startedAtIso);
  if (roundsWithoutDb.date !== day) { roundsWithoutDb.date = day; roundsWithoutDb.count = 0; }
  return ++roundsWithoutDb.count;
}

// Gir pågående omgang et nummer: antall omganger som startet tidligere samme dag + 1.
// Samme regel som dashboardet (getRoundNumbers), så numrene stemmer overens.
async function assignRoundNumber() {
  if (gameState.roundNumber || !gameState.roundStartedAt) return;
  let number = null;
  if (db) {
    try {
      const range = localDayRange(parseDateParam(localDateString(gameState.roundStartedAt)));
      const res = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM omganger
              WHERE started_at >= ? AND started_at < ? AND omgang_id != ?`,
        args: [range.start, gameState.roundStartedAt, Number(currentRoundId) || -1]
      });
      number = Number(res.rows[0].n) + 1;
    } catch (err) {
      console.error('[DB] Feil ved nummerering av omgang:', err.message);
    }
  }
  gameState.roundNumber = number || nextRoundNumberWithoutDb(gameState.roundStartedAt);
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

// Antall hender som lagres akkurat nå (reset-day venter til de er ferdige)
let persistsInFlight = 0;

async function persistHandResult() {
  persistsInFlight++;
  try {
    await writeHandResult();
  } finally {
    persistsInFlight--;
  }
}

async function writeHandResult() {
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

  await ensureSession(nowIso);
  let roundId = null;
  try {
    roundId = await ensureRoundRow();
  } catch (rErr) {
    console.error('[DB ERROR] Kunne ikke opprette omgang:', rErr.message);
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
    // Kun kort som faktisk ble vist ved bordet lagres:
    // - Alle andre kastet seg: INGEN kort lagres (vinneren kan ha bløffet).
    // - Showdown: kun kortene til spillerne som var med helt til showdown.
    //   Kort fra spillere som kastet seg tidligere lagres ikke.
    const isFoldedWin = !!winnerInfo.foldedWin;
    const cleanWinningCards = (!isFoldedWin && Array.isArray(winnerInfo.rawCards))
      ? winnerInfo.rawCards.map(cardCode)
      : [];
    const shownPlayers = isFoldedWin ? [] : activePlayersList.filter(isInHand);

    const jsonPayload = JSON.stringify({
      v: 2, // versjon: kun viste kort lagres (se scrubUnshownCards)
      board: cleanBoard,
      winningCards: cleanWinningCards,
      cards: shownPlayers.map(p => ({
        uuid: String(p.uuid || ''),
        name: String(p.name || ''),
        cards: p.cards.map(c => String(c))
      }))
    });

    const deltakere = activePlayersList.filter(p => p.uuid && p.cards.length > 0).map(p => String(p.uuid));

    const res = await db.execute({
      sql: `INSERT INTO winning_hands (session_id, omgang_id, player_uuid, player_name, hand_description, winning_cards, hand_rank, created_at, deltakere)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        Number(currentSessionId),
        roundId ? Number(roundId) : null,
        String(winnerUuidStr),
        String(winnerNamesStr),
        String(rawDescr),
        jsonPayload,
        Number(rankVal),
        nowIso,
        JSON.stringify(deltakere)
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

// Spillere som er tomme for sjetonger («ute») får ikke kort og hoppes over av dealerknappen
function getActiveSeatedPlayers() {
  return getSeatedPlayers().filter(p => !p.out);
}

// Når alle unntatt én er markert «ute», har den ene vunnet omgangen
function getRoundWinnerPlayer() {
  const all = Object.values(players);
  const remaining = all.filter(p => !p.out);
  return (remaining.length === 1 && all.length > 1) ? remaining[0] : null;
}

function getRoundWinner() {
  const p = getRoundWinnerPlayer();
  return p ? p.name : null;
}

function startNewHandLogic() {
  if (!gameState.gameMode) return;

  removePlayersMarkedForRemoval();

  // Ingen ny hånd når omgangen er avgjort – dealer må trykke «Ny omgang»
  if (getRoundWinner()) return;

  const playerList = getActiveSeatedPlayers();
  if (playerList.length === 0) return;

  // Første hånd i en (ny) omgang
  if (gameState.roundFinished) startNewRound();
  if (!gameState.roundStartedAt) gameState.roundStartedAt = new Date().toISOString();

  gameState.handNumber++;
  // Håndnavnene fra forrige showdown gjelder ikke lenger
  getSeatedPlayers().forEach(p => { p.handDescr = null; p.handRank = null; });

  // Spillere som er ute nullstilles og står over
  getSeatedPlayers().filter(p => p.out).forEach(p => {
    p.folded = true;
    p.foldedInPhase = null;
    p.waiting = false;
    p.cards = [];
    p.role = '';
  });

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
    winners: [remaining[0].name],
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
    let isAutoJoin = false;
    if (nameOrPayload && typeof nameOrPayload === 'object') {
      rawName = nameOrPayload.name ? String(nameOrPayload.name) : '';
      clientUuid = nameOrPayload.uuid ? String(nameOrPayload.uuid) : null;
      isAutoJoin = !!nameOrPayload.auto;
    } else {
      rawName = nameOrPayload ? String(nameOrPayload) : '';
    }

    // Kastet ut ved «Nytt spill»: automatisk innlogging avvises, manuell innlogging godtas
    if (clientUuid && kickedUuids.has(clientUuid)) {
      if (isAutoJoin) {
        socket.emit('kicked', { reason: 'Spillet er avsluttet. Logg inn på nytt for å bli med.' });
        return;
      }
      kickedUuids.delete(clientUuid);
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
      // Fullt bord: kun nye spillere avvises – de som tar over sin egen plass slipper alltid inn
      if (Object.keys(players).length >= MAX_PLAYERS) {
        socket.emit('join_failed', { reason: `Bordet er fullt (maks ${MAX_PLAYERS} spillere).` });
        return;
      }

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
        // Var spilleren markert ute før en omstart av serveren, er hen fortsatt ute
        out: restoredOutUuids.has(playerUuid),
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
    } else if (!gameState.seatsDrawn) {
      // Plassene trekkes kun første gang (etter serverstart / «Nytt spill»),
      // så rekkefølgen dealeren har satt med pilene beholdes ved bytte av spilletype
      randomizePlayerSeats();
      gameState.seatsDrawn = true;
    }
    updateAll();
  }));

  socket.on('start_new_hand', safeHandler('start_new_hand', async () => {
    startNewHandLogic();
    await assignRoundNumber();
    updateAll();
  }));

  socket.on('next_phase', safeHandler('next_phase', async () => {
    if (gameState.phase === 'FINISHED' || gameState.phase === 'SHOWDOWN') {
      startNewHandLogic();
      await assignRoundNumber();
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
          winners: [],
          descr: 'Ingen gyldige hender',
          foldedWin: true,
          rawCards: [],
          rankVal: 0
        };
        updateAll();
        return;
      }

      // Håndnavn og styrke for alle som var med til showdown (kortene deres vises uansett)
      solvedHands.forEach(sh => {
        sh.player.handDescr = translateHandDescription(sh.solved.descr);
        sh.player.handRank = calculateHandScore(sh.solved);
      });

      const handsOnly = solvedHands.map(sh => sh.solved);
      const winningHands = Hand.winners(handsOnly);
      
      const winners = solvedHands.filter(sh => winningHands.includes(sh.solved));
      
      let winnerText = '';
      if (winners.length > 1) {
        const names = winners.map(w => w.player.name).join(' & ');
        winnerText = `UAVGJORT – DELT POTT: ${names}`;
      } else {
        winnerText = winners[0].player.name;
      }

      const rawDescr = winners[0] ? winners[0].solved.descr : 'Ukjent hånd';
      const exactRankVal = winners[0] ? calculateHandScore(winners[0].solved) : 0;

      gameState.winnerUuids = winners.map(w => w.player.uuid);
      gameState.winnerInfo = {
        winnerName: winnerText,
        winners: winners.map(w => w.player.name),
        // Ved delt pott har hver vinner sine egne fem kort (like sterke, men ulike)
        winnerHands: winners.map(w => ({ name: w.player.name, cards: (w.solved.cards || []).map(cardCode) })),
        descr: translateHandDescription(rawDescr),
        foldedWin: false,
        rawCards: winners[0] ? winners[0].solved.cards.map(cardCode) : [],
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

  // Dealeren kaster kortene for en spiller fra statusskjermen – f.eks. en telefon
  // som er borte, eller en spiller som sier «jeg kaster» ved bordet
  socket.on('host_fold_player', safeHandler('host_fold_player', async (seat) => {
    const player = Object.values(players).find(p => p.seat === Number(seat));
    if (!player || !canFold(player)) return;

    player.folded = true;
    player.foldedInPhase = gameState.phase;
    await finishIfOnlyOneLeft();
    updateAll();
  }));

  // Dealeren markerer at en spiller er ute (tom for sjetonger) – eller angrer markeringen.
  // Kun lov mellom hender, så ingen blir tatt ut midt i en hånd.
  socket.on('host_set_out', safeHandler('host_set_out', async (data) => {
    if (isHandInProgress()) return;
    const seat = data && Number(data.seat);
    const player = Object.values(players).find(p => p.seat === seat);
    if (!player) return;

    const winnerBefore = getRoundWinnerPlayer();
    player.out = !!(data && data.out);
    if (player.out) player.role = '';
    const winnerAfter = getRoundWinnerPlayer();
    updateAll();

    if (!player.out && player.uuid) restoredOutUuids.delete(player.uuid);
    await saveOutUuids();

    if (winnerAfter && winnerAfter !== winnerBefore) {
      io.emit('celebrate_win', { playerName: winnerAfter.name, handDescription: 'Vinner av omgangen!' });
      await finishRound(winnerAfter);
    } else if (!winnerAfter && winnerBefore) {
      await reopenRound();
    }
  }));

  // Ny omgang: alle er med igjen, og neste hånd hører til en ny omgang.
  // {drawSeats: true} trekker nye plasser (pleier å gjøres mellom omgangene).
  socket.on('host_reset_out', safeHandler('host_reset_out', async (data) => {
    if (isHandInProgress()) return;
    Object.values(players).forEach(p => { p.out = false; });
    if (data && data.drawSeats) {
      // Nye plasser: dealerknappen starter på nytt (sete 1), rollene fra forrige hånd gjelder ikke
      randomizePlayerSeats();
      Object.values(players).forEach(p => { p.role = ''; });
    }
    await closeUnfinishedRound();
    startNewRound();
    updateAll();
  }));

  // Nytt spill: alle spillere kastes ut og spillet nullstilles.
  // Telefonene får 'kicked' og går til innloggingsskjermen (uten å logge inn igjen av seg selv).
  socket.on('host_kick_all', safeHandler('host_kick_all', async () => {
    Object.values(players).forEach(p => {
      io.to(p.id).emit('kicked', { reason: 'Spillet er avsluttet. Logg inn på nytt for å bli med.' });
    });

    Object.keys(disconnectTimeouts).forEach(id => {
      clearTimeout(disconnectTimeouts[id]);
      delete disconnectTimeouts[id];
    });
    Object.values(players).forEach(p => { if (p.uuid) kickedUuids.add(p.uuid); });
    players = {};
    uuidToPlayerId.clear();

    gameState.gameMode = null;
    gameState.phase = 'VENTING';
    gameState.board = [];
    gameState.deck = [];
    gameState.winnerInfo = null;
    gameState.winnerUuids = [];
    gameState.dealerSeat = 0;
    gameState.seatsDrawn = false;
    await closeUnfinishedRound();
    startNewRound();

    // Avslutt sesjonen i databasen – neste hånd starter en ny
    if (db && currentSessionId) {
      try {
        await db.execute({
          sql: "UPDATE poker_sessions SET ended_at = ? WHERE id = ?",
          args: [new Date().toISOString(), Number(currentSessionId)]
        });
      } catch (err) {
        console.error('[DB] Feil ved avslutning av sesjon:', err.message);
      }
    }
    currentSessionId = null;

    console.log('[SPILL] Nytt spill – alle spillere er kastet ut.');
    updateAll();
  }));

  // Dealeren flytter en spiller ett sete til venstre (-1) eller høyre (+1).
  // Kun lov mellom hender. Spilleren bytter plass med naboen.
  socket.on('host_move_player', safeHandler('host_move_player', async (data) => {
    if (isHandInProgress()) return;
    const seat = data && Number(data.seat);
    const direction = data && Number(data.direction);
    if (direction !== -1 && direction !== 1) return;

    const seated = getSeatedPlayers();
    const idx = seated.findIndex(p => p.seat === seat);
    const neighbour = seated[idx + direction];
    if (idx === -1 || !neighbour) return;

    const player = seated[idx];
    [player.seat, neighbour.seat] = [neighbour.seat, player.seat];
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
    roundWinner: getRoundWinner(),
    handNumber: gameState.handNumber,
    roundNumber: gameState.roundNumber,
    players: playerList.map(p => ({
      name: p.name,
      seat: p.seat,
      role: p.role,
      folded: p.folded,
      waiting: !!p.waiting,
      out: !!p.out,
      connected: p.connected,
      cards: showCardsOnScreen && !p.folded ? p.cards : [],
      // Håndnavn og styrke kun ved showdown, kun for spillere med viste kort
      handDescr: showCardsOnScreen && !p.folded ? (p.handDescr || null) : null,
      handRank: showCardsOnScreen && !p.folded ? (p.handRank || null) : null
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
        out: !!p.out,
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

const PORT = process.env.PORT || 3000;

// Start kun når filen kjøres direkte (node server.js). Testene kan da importere
// funksjonene under uten at serveren starter.
if (require.main === module) {
  initDatabase();
  server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
}

module.exports = { translateHandDescription, retranslateStoredDescription, evaluatePlayerHand, calculateHandScore, nextRoundNumberWithoutDb, cardCode };