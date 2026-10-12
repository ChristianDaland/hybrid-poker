// Enhetstester: håndevaluering (Texas/Omaha) og norske håndbeskrivelser
const test = require('node:test');
const assert = require('node:assert');
const { Hand } = require('pokersolver');
const { translateHandDescription, retranslateStoredDescription, evaluatePlayerHand } = require('../server.js');

test('Omaha: må bruke nøyaktig 2 hullkort + 3 bordkort', () => {
  const board = ['Ah', 'Kh', 'Qh', 'Jh', '2c'];
  const hole = ['Th', '3c', '4d', '5s'];
  // Texas ville gitt Royal Flush med bare tieren – Omaha skal ikke
  assert.strictEqual(evaluatePlayerHand(['Th', '3c'], board, 'TEXAS').descr, 'Royal Flush');
  const omaha = evaluatePlayerHand(hole, board, 'OMAHA');
  assert.ok(omaha.rank < 5, `Omaha skal ikke gi straight/flush, fikk: ${omaha.descr}`);
});

test('Omaha: finner beste kombinasjon av 60', () => {
  const board = ['9h', '8h', '2c', '2d', 'Ks'];
  const hole = ['7h', '6h', 'Ac', 'Ad'];
  // 7h 6h + 9h 8h ... trenger 5h for straight flush – finnes ikke. Ess-par + 2-par = to par
  const best = evaluatePlayerHand(hole, board, 'OMAHA');
  assert.strictEqual(best.name, 'Two Pair');
});

test('Norske beskrivelser for alle håndtyper', () => {
  const cases = [
    [['Ah', 'Kh', 'Qh', 'Jh', 'Th'], 'Royal Flush'],
    [['9h', '8h', '7h', '6h', '5h'], 'Straight Flush, 9-høy i hjerter'],
    [['9h', '9d', '9c', '9s', 'Ah'], 'Fire like, 9-ere'],
    [['Kh', 'Kd', 'Ks', '2c', '2d'], 'Fullt hus, Konger over 2-ere'],
    [['Qd', 'Jd', '8d', '4d', '2d'], 'Flush, Dame-høy i ruter'],
    [['Th', '9d', '8c', '7s', '6h'], 'Straight, 10-høy'],
    [['Ah', '2d', '3c', '4s', '5h'], 'Straight, 5-høy'],
    [['7h', '7d', '7c', 'Ks', '2d'], 'Tre like, 7-ere'],
    [['Ah', 'Ad', '2s', '2h', 'Kc'], 'To par, Ess og 2-ere'],
    [['Jh', 'Jd', 'Ts', 'Th', 'Kc'], 'To par, Knekter og 10-ere'],
    [['Qh', 'Qd', '9c', '5s', '3h'], 'Ett par, Damer'],
    [['Ah', 'Jd', '9c', '5s', '3h'], 'Høyt kort, Ess']
  ];
  for (const [cards, expected] of cases) {
    assert.strictEqual(translateHandDescription(Hand.solve(cards).descr), expected);
  }
});

test('Eldre lagrede (halvoversatte) beskrivelser oversettes på nytt', () => {
  assert.strictEqual(retranslateStoredDescription("To Par, A's & 2's"), 'To par, Ess og 2-ere');
  assert.strictEqual(retranslateStoredDescription('Flush, Qd High'), 'Flush, Dame-høy i ruter');
  assert.strictEqual(retranslateStoredDescription("Fullt Hus, K's over 2's"), 'Fullt hus, Konger over 2-ere');
  assert.strictEqual(retranslateStoredDescription('Alle andre kastet seg'), 'Alle andre kastet seg');
  assert.strictEqual(retranslateStoredDescription('Ett par, Damer'), 'Ett par, Damer');
});
