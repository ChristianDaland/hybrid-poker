// ============================================================
// Tydelige kortsymboler som SVG (i stedet for skrifttegnene ♠ ♥ ♦ ♣,
// som blir små og like hverandre). Formene er laget for å være lette
// å skille: kløver = tre runde blader, spar = spiss topp, ruter = smal
// rombe, hjerter = to runde buer. Fargen arves (fill: currentColor).
// Bruk: suitIcon('s') -> '<svg ...>…</svg>'
// ============================================================
(function () {
  var SHAPES = {
    // Hjerter: to runde buer som møtes i en spiss nederst
    h: '<path d="M50 90 C 22 68, 4 50, 8 30 C 12 12, 34 6, 50 26 C 66 6, 88 12, 92 30 C 96 50, 78 68, 50 90 Z"/>',
    // Ruter: smal, høy rombe
    d: '<path d="M50 4 L84 50 L50 96 L16 50 Z"/>',
    // Spar: spiss topp, runde «skuldre» og stilk
    s: '<path d="M50 4 C 64 22, 92 38, 92 58 C 92 74, 76 82, 62 74 C 58 72, 55 68, 54 64 C 55 76, 60 86, 70 94 L30 94 C 40 86, 45 76, 46 64 C 45 68, 42 72, 38 74 C 24 82, 8 74, 8 58 C 8 38, 36 22, 50 4 Z"/>',
    // Kløver: tre tydelige runde blader og stilk
    c: '<circle cx="50" cy="27" r="20"/><circle cx="26" cy="58" r="20"/><circle cx="74" cy="58" r="20"/>' +
       '<circle cx="50" cy="52" r="12"/><path d="M45 56 C 45 74, 40 86, 30 94 L70 94 C 60 86, 55 74, 55 56 Z"/>'
  };

  window.suitIcon = function (suitChar) {
    var key = String(suitChar || '').toLowerCase();
    var shape = SHAPES[key];
    if (!shape) return '';
    return '<svg class="suit-icon" viewBox="0 0 100 100" aria-hidden="true">' + shape + '</svg>';
  };
})();
