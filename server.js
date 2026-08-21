const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Hand = require('pokersolver').Hand;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const SUITS = ['c', 'd', 'h', 's'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (let s of SUITS) {
    for (let v of VALUES) {
      deck.push((v === '10' ? 'T' : v) + s);
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

// Konverterer kort til pokersolver-format (f.eks. 'Tc' -> 'Tc')
function formatForSolver(card) {
  if (card.startsWith('10')) return 'T' + card.slice(-1);
  return card;
}

// Evaluere beste hånd
function evaluatePlayerHand(playerCards, boardCards, gameMode) {
  const formattedBoard = boardCards.map(formatForSolver);
  const formattedPlayer = playerCards.map(formatForSolver);

  if (gameMode === 'TEXAS') {
    const allCards = [...formattedPlayer, ...formattedBoard];
    return Hand.solve(allCards);
  } else {
    // OMAHA: Må bruke NØYAKTIG 2 kort fra hånd og NØYAKTIG 3 kort fra bord
    let bestHand = null;
    for (let i = 0; i < formattedPlayer.length; i++) {
      for (let j = i + 1; j < formattedPlayer.length; j++) {
        const hand2 = [formattedPlayer[i], formattedPlayer[j]];

        for (let b1 = 0; b1 < formattedBoard.length; b1++) {
          for (let b2 = b1 + 1; b2 < formattedBoard.length; b2++) {
            for (let b3 = b2 + 1; b3 < formattedBoard.length; b3++) {
              const board3 = [formattedBoard[b1], formattedBoard[b2], formattedBoard[b3]];
              const combo = Hand.solve([...hand2, ...board3]);
              if (!bestHand || combo.rank > bestHand.rank || (combo.rank === bestHand.rank && combo.compare(bestHand) > 0)) {
                bestHand = combo;
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
  gameMode: 'OMAHA',
  phase: 'VENTING',
  board: [],
  deck: [],
  winnerInfo: null
};

let players = {};

io.on('connection', (socket) => {
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
    updateAll();
  });

  socket.on('set_game_mode', (mode) => {
    gameState.gameMode = mode;
    updateAll();
  });

  socket.on('start_new_hand', () => {
    const playerList = Object.values(players);
    if (playerList.length === 0) return;

    gameState.deck = createDeck();
    gameState.board = [];
    gameState.phase = 'PREFLOP';
    gameState.winnerInfo = null;

    playerList.forEach((p, idx) => {
      p.folded = false;
      p.cards = [];
      p.role = playerList.length >= 2 ? (idx === 0 ? 'SB' : idx === 1 ? 'BB' : '') : 'BB';
      
      const cardCount = gameState.gameMode === 'OMAHA' ? 4 : 2;
      for (let i = 0; i < cardCount; i++) {
        p.cards.push(gameState.deck.pop());
      }
    });

    updateAll();
  });

  socket.on('next_phase', () => {
    const activePlayers = Object.values(players).filter(p => !p.folded);

    // Hvis kun én spiller er igjen (alle andre har foldet)
    if (activePlayers.length === 1) {
      gameState.phase = 'SHOWDOWN';
      gameState.winnerInfo = {
        winnerName: activePlayers[0].name,
        descr: 'Alle andre foldet!'
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
    } else if (gameState.phase === 'RIVER' || gameState.phase === 'SHOWDOWN') {
      gameState.phase = 'SHOWDOWN';
      
      // Beregn vinner
      const solvedHands = activePlayers.map(p => ({
        player: p,
        solved: evaluatePlayerHand(p.cards, gameState.board, gameState.gameMode)
      }));

      const handsOnly = solvedHands.map(sh => sh.solved);
      const winningHands = Hand.winners(handsOnly);
      
      const winners = solvedHands.filter(sh => winningHands.includes(sh.solved));
      const winnerNames = winners.map(w => w.player.name).join(' & ');
      const handDescr = winners[0].solved.descr; // F.eks. "Two Pair, Nines and Eights"

      gameState.winnerInfo = {
        winnerName: winnerNames,
        descr: handDescr
      };
    }
    updateAll();
  });

  socket.on('player_fold', () => {
    if (players[socket.id]) {
      players[socket.id].folded = true;
      
      // Sjekk om det kun er én aktiv spiller igjen etter fold
      const activePlayers = Object.values(players).filter(p => !p.folded);
      if (activePlayers.length === 1 && gameState.phase !== 'VENTING') {
        gameState.phase = 'SHOWDOWN';
        gameState.winnerInfo = {
          winnerName: activePlayers[0].name,
          descr: 'Alle andre foldet!'
        };
      }
      updateAll();
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    updateAll();
  });
});

function updateAll() {
  const playerList = Object.values(players);

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
      // Avslør kortene på iPad kun i SHOWDOWN
      cards: gameState.phase === 'SHOWDOWN' && !p.folded ? p.cards : []
    }))
  });

  playerList.forEach(p => {
    io.to(p.id).emit('player_state', {
      phase: gameState.phase,
      cards: p.cards,
      role: p.role,
      folded: p.folded,
      winnerInfo: gameState.winnerInfo
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));