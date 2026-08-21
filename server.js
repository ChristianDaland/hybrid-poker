const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const HandSolver = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = [];
let gameMode = 'TEXAS'; // 'TEXAS' eller 'OMAHA'
let deck = [];
let communityCards = [];
let gameState = 'LOBBY';
let dealerIndex = 0;

const SUITS = ['s', 'c', 'h', 'd'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function createDeck() {
  let newDeck = [];
  for (let s of SUITS) {
    for (let r of RANKS) newDeck.push(r + s);
  }
  for (let i = newDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
  }
  return newDeck;
}

function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const head = arr[0], tail = arr.slice(1);
  return [...getCombinations(tail, k - 1).map(c => [head, ...c]), ...getCombinations(tail, k)];
}

function evaluatePlayerHand(playerCards, boardCards, mode) {
  if (mode === 'TEXAS') {
    return HandSolver.solve([...playerCards, ...boardCards]);
  } else {
    const handPairs = getCombinations(playerCards, 2);
    const boardTriplets = getCombinations(boardCards, 3);
    let bestHand = null;
    for (let pair of handPairs) {
      for (let triplet of boardTriplets) {
        const solved = HandSolver.solve([...pair, ...triplet]);
        if (!bestHand || solved.rank > bestHand.rank) bestHand = solved;
      }
    }
    return bestHand;
  }
}

function getNextActiveIndex(startIdx) {
  let idx = startIdx;
  do {
    idx = (idx + 1) % players.length;
  } while (players[idx].isOut && players.filter(p => !p.isOut).length > 0);
  return idx;
}

function updatePositions() {
  const activeCount = players.filter(p => !p.isOut).length;
  if (activeCount === 0) return;

  let sbIdx = activeCount === 2 ? dealerIndex : getNextActiveIndex(dealerIndex);
  let bbIdx = getNextActiveIndex(sbIdx);

  players.forEach((p, idx) => {
    p.role = '';
    if (idx === dealerIndex) p.role = 'DEALER';
    if (idx === sbIdx) p.role = 'SB';
    if (idx === bbIdx) p.role = 'BB';
  });
}

io.on('connection', (socket) => {
  socket.on('join_game', (name) => {
    players.push({
      id: socket.id,
      name: name || `Spiller ${players.length + 1}`,
      seatNumber: players.length + 1,
      isOut: false,
      cards: [],
      isFolded: false,
      role: ''
    });
    updatePositions();
    io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
  });

  socket.on('set_game_mode', (mode) => {
    gameMode = mode;
    io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
  });

  socket.on('toggle_player_out', (playerId) => {
    const p = players.find(p => p.id === playerId);
    if (p) {
      p.isOut = !p.isOut;
      updatePositions();
      io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
    }
  });

  socket.on('start_new_hand', () => {
    deck = createDeck();
    communityCards = [];
    gameState = 'PREFLOP';

    // Tilfeldig stokking av plasser
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }

    dealerIndex = getNextActiveIndex(dealerIndex);
    players.forEach((p, idx) => {
      p.seatNumber = idx + 1;
      p.cards = [];
      p.isFolded = false;
    });

    updatePositions();

    const cardsPerPlayer = gameMode === 'TEXAS' ? 2 : 4;
    players.forEach(p => {
      if (!p.isOut) {
        p.cards = deck.splice(0, cardsPerPlayer);
        io.to(p.id).emit('your_cards', { cards: p.cards, role: p.role });
      }
    });

    io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
  });

  socket.on('next_phase', () => {
    if (gameState === 'PREFLOP') { communityCards = deck.splice(0, 3); gameState = 'FLOP'; }
    else if (gameState === 'FLOP') { communityCards.push(deck.splice(0, 1)[0]); gameState = 'TURN'; }
    else if (gameState === 'TURN') { communityCards.push(deck.splice(0, 1)[0]); gameState = 'RIVER'; }
    else if (gameState === 'RIVER') {
      gameState = 'SHOWDOWN';
      let active = players.filter(p => !p.isOut && !p.isFolded);
      let results = active.map(p => ({
        player: p,
        hand: evaluatePlayerHand(p.cards, communityCards, gameMode)
      }));
      results.sort((a, b) => HandSolver.compare(b.hand, a.hand));
      
      if (results.length > 0) {
        io.emit('showdown_results', {
          winnerName: results[0].player.name,
          winningHandDesc: results[0].hand.descr
        });
      }
    }
    io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
  });

  socket.on('fold', () => {
    const p = players.find(p => p.id === socket.id);
    if (p) {
      p.isFolded = true;
      io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
      socket.emit('folded');
    }
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    updatePositions();
    io.emit('update_table', { players, gameState, communityCards, gameMode, dealerIndex });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));