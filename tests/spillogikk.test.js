// Spillogikk: roller, angre kast, «ute», omgangsvinner, plassering, nytt spill
const test = require('node:test');
const assert = require('node:assert');
const { startServer, wait, findPlayer } = require('./helpers');

test('Heads-up: dealer er også lilleblind', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  srv.player('Anne'); srv.player('Bjørn'); await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  assert.deepStrictEqual(host.state.players.map(p => p.role).sort(), ['Dealer / Lilleblind', 'Storeblind']);
});

test('Dealer kan kaste kort for frakoblet og tilkoblet spiller, ikke for den siste', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  srv.player('Anne'); srv.player('Bjørn'); const C = srv.player('Cato'); srv.player('Dina'); await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  host.emit('host_fold_player', P('Dina').seat); await wait(150);
  assert.strictEqual(P('Dina').folded, true, 'tilkoblet spiller');
  C.disconnect(); await wait(200);
  host.emit('host_fold_player', P('Cato').seat); await wait(150);
  assert.strictEqual(P('Cato').folded, true, 'frakoblet spiller');
  host.emit('host_fold_player', P('Bjørn').seat); await wait(200);
  assert.strictEqual(host.state.phase, 'FINISHED');
  assert.strictEqual(host.state.winnerInfo.winnerName, 'Anne');
  host.emit('host_fold_player', P('Anne').seat); await wait(150);
  assert.strictEqual(P('Anne').folded, false, 'den siste kan ikke kastes');
});

test('Angre kast: til neste kort åpnes; to igjen + kast = ferdig uten angre', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  const A = srv.player('Anne'), B = srv.player('Bjørn'); srv.player('Cato'); await wait(300);
  host.emit('set_game_mode', 'OMAHA'); await wait(100);
  host.emit('start_new_hand'); await wait(150);

  A.emit('player_fold'); await wait(150);
  assert.ok(P('Anne').folded && A.st.canUndoFold, 'kan angre');
  A.emit('player_unfold'); await wait(150);
  assert.strictEqual(P('Anne').folded, false, 'angret');

  A.emit('player_fold'); await wait(150);
  host.emit('next_phase'); await wait(150);
  assert.strictEqual(A.st.canUndoFold, false, 'kan ikke angre etter flopp');
  A.emit('player_unfold'); await wait(150);
  assert.strictEqual(P('Anne').folded, true, 'serveren avviser for sen angring');

  B.emit('player_fold'); await wait(200);
  assert.strictEqual(host.state.phase, 'FINISHED');
  assert.strictEqual(host.state.winnerInfo.winnerName, 'Cato');
  B.emit('player_unfold'); await wait(150);
  assert.strictEqual(P('Bjørn').folded, true, 'ingen angring når hånden er avgjort');
});

test('Ute-markering, omgangsvinner og ny omgang', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  let celebrated = null;
  host.on('celebrate_win', d => { celebrated = d; });
  const P = n => findPlayer(host.state, n);
  const S = {};
  for (const n of ['Anne', 'Bjørn', 'Cato', 'Dina']) { S[n] = srv.player(n); await wait(60); }
  await wait(200);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);

  host.emit('host_set_out', { seat: P('Bjørn').seat, out: true }); await wait(150);
  assert.strictEqual(P('Bjørn').out, false, 'kan ikke markeres midt i en hånd');

  for (const n of ['Anne', 'Cato', 'Dina']) { S[n].emit('player_fold'); await wait(60); }
  await wait(150);
  host.emit('host_set_out', { seat: P('Bjørn').seat, out: true }); await wait(150);
  assert.ok(P('Bjørn').out && S['Bjørn'].st.out);

  for (let h = 0; h < 3; h++) {
    host.emit('start_new_hand'); await wait(150);
    assert.strictEqual(P('Bjørn').role, '');
    assert.strictEqual(S['Bjørn'].st.cards.length, 0);
    assert.strictEqual(host.state.players.filter(p => p.role.startsWith('Dealer')).length, 1);
    S.Anne.emit('player_fold'); await wait(60); S.Cato.emit('player_fold'); await wait(150);
    if (host.state.phase !== 'FINISHED') { S.Dina.emit('player_fold'); await wait(150); }
  }

  host.emit('host_set_out', { seat: P('Cato').seat, out: true }); await wait(100);
  host.emit('host_set_out', { seat: P('Anne').seat, out: true }); await wait(200);
  assert.strictEqual(host.state.roundWinner, 'Dina');
  assert.strictEqual(celebrated && celebrated.playerName, 'Dina');

  const phase = host.state.phase;
  host.emit('start_new_hand'); await wait(150);
  assert.strictEqual(host.state.phase, phase, 'ingen ny hånd når omgangen er avgjort');

  host.emit('host_set_out', { seat: P('Anne').seat, out: false }); await wait(150);
  assert.strictEqual(host.state.roundWinner, null, 'feilmarkering kan angres');

  host.emit('host_reset_out'); await wait(150);
  assert.ok(host.state.players.every(p => !p.out), 'ny omgang: alle inn igjen');
});

test('Plassering: flytte med piler, kun mellom hender, trekning kun én gang', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  const order = () => host.state.players.map(p => p.name).join(',');
  const move = async (n, d) => { host.emit('host_move_player', { seat: P(n).seat, direction: d }); await wait(150); };
  for (const n of ['A', 'B', 'C', 'D']) { srv.player(n); await wait(60); }
  await wait(200);

  assert.strictEqual(order(), 'A,B,C,D');
  await move('C', -1); assert.strictEqual(order(), 'A,C,B,D');
  await move('A', -1); assert.strictEqual(order(), 'A,C,B,D', 'kan ikke gå forbi kanten');
  await move('A', 1); assert.strictEqual(order(), 'C,A,B,D');

  host.emit('set_game_mode', 'TEXAS'); await wait(150);
  const want = ['D', 'C', 'B', 'A'];
  for (let i = 0; i < want.length; i++) {
    while (host.state.players.findIndex(p => p.name === want[i]) > i) await move(want[i], -1);
  }
  assert.strictEqual(order(), 'D,C,B,A');

  host.emit('set_game_mode', null); await wait(100);
  host.emit('set_game_mode', 'OMAHA'); await wait(150);
  assert.strictEqual(order(), 'D,C,B,A', 'bytte spilletype trekker ikke på nytt');

  host.emit('start_new_hand'); await wait(150);
  await move('B', -1);
  assert.strictEqual(order(), 'D,C,B,A', 'flytting sperret midt i hånd');
});

test('Nytt spill: alle kastes ut, sovende telefon logges ikke stille inn igjen', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  let hostKicked = false;
  host.on('kicked', () => { hostKicked = true; });
  const A = srv.player('Anne', 'u-anne'), B = srv.player('Bjørn', 'u-bjorn'), C = srv.player('Cato', 'u-cato');
  await wait(300);
  host.emit('set_game_mode', 'OMAHA'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  C.disconnect(); await wait(150);
  host.emit('host_kick_all'); await wait(250);

  assert.strictEqual(host.state.players.length, 0);
  assert.strictEqual(host.state.phase, 'VENTING');
  assert.strictEqual(host.state.gameMode, null);
  assert.strictEqual(A.kicked, 1); assert.strictEqual(B.kicked, 1);
  assert.strictEqual(hostKicked, false, 'statusskjermen får ikke «kicked»');

  // Cato sin telefon våkner: rejoin feiler -> automatisk innlogging skal avvises
  const c2 = srv.player();
  c2.on('rejoin_failed', () => c2.emit('join_game', { name: 'Cato', uuid: 'u-cato', auto: true }));
  c2.emit('rejoin_game', { uuid: 'u-cato' }); await wait(250);
  assert.strictEqual(c2.kicked, 1);
  assert.strictEqual(host.state.players.length, 0);

  // Manuell innlogging slipper inn
  c2.emit('join_game', { name: 'Cato', uuid: 'u-cato' }); await wait(200);
  assert.strictEqual(host.state.players.length, 1);
});

test('Maks 8 spillere: den niende avvises, frakoblet spiller slipper inn igjen', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const S = [];
  for (let i = 1; i <= 8; i++) { S.push(srv.player('Spiller' + i, 'u-' + i)); await wait(40); }
  await wait(200);
  assert.strictEqual(host.state.players.length, 8);

  const niende = srv.player('Niende'); await wait(200);
  assert.match(niende.joinFailed && niende.joinFailed.reason, /fullt.*8/, 'den niende avvises');
  assert.strictEqual(host.state.players.length, 8);

  S[2].disconnect(); await wait(150);
  const sammeUuid = srv.player('Spiller3', 'u-3'); await wait(200);
  assert.ok(sammeUuid.joinedData && !sammeUuid.joinFailed, 'samme UUID slipper inn ved fullt bord');

  S[3].disconnect(); await wait(150);
  const nyTelefon = srv.player('Spiller4'); await wait(200);
  assert.strictEqual(nyTelefon.uuid, 'u-4', 'samme navn tar over frakoblet plass ved fullt bord');
  assert.strictEqual(host.state.players.length, 8);
});

test('Tavledata: håndnummer, omgangsnummer, vinnere og håndnavn kun ved showdown', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  const A = srv.player('Anne'), B = srv.player('Bjørn'); srv.player('Cato'); await wait(300);
  host.emit('set_game_mode', 'OMAHA'); await wait(100);
  assert.strictEqual(host.state.handNumber, 0);
  assert.strictEqual(host.state.roundNumber, null, 'ingen omgang før første hånd');

  host.emit('start_new_hand'); await wait(150);
  assert.strictEqual(host.state.handNumber, 1);
  assert.strictEqual(host.state.roundNumber, 1);

  // Alle andre kastet seg: én vinner, ingen håndnavn
  A.emit('player_fold'); await wait(60); B.emit('player_fold'); await wait(200);
  assert.deepStrictEqual(host.state.winnerInfo.winners, ['Cato']);
  assert.ok(host.state.players.every(p => p.handDescr === null && p.handRank === null));

  // Showdown: håndnavn for de som ble med, ikke for den som kastet seg
  host.emit('next_phase'); await wait(150);
  assert.strictEqual(host.state.handNumber, 2);
  A.emit('player_fold'); await wait(100);
  for (let i = 0; i < 3; i++) {
    assert.ok(host.state.players.every(p => p.handDescr === null), 'ingen håndnavn før showdown');
    host.emit('next_phase'); await wait(120);
  }
  host.emit('next_phase'); await wait(200);
  assert.strictEqual(host.state.phase, 'SHOWDOWN');
  assert.strictEqual(P('Anne').handDescr, null, 'ingen håndnavn for den som kastet seg');
  for (const n of ['Bjørn', 'Cato']) {
    assert.ok(P(n).handDescr && P(n).handRank > 0, `${n} har håndnavn og styrke`);
  }
  const best = Math.max(P('Bjørn').handRank, P('Cato').handRank);
  const expected = ['Bjørn', 'Cato'].filter(n => P(n).handRank === best);
  assert.deepStrictEqual([...host.state.winnerInfo.winners].sort(), expected);
  // Hver vinners egne fem kort: i Omaha nøyaktig 2 fra hånden + 3 fra bordet
  const hands = host.state.winnerInfo.winnerHands;
  assert.deepStrictEqual(hands.map(h => h.name).sort(), expected);
  for (const h of hands) {
    assert.strictEqual(h.cards.length, 5);
    assert.strictEqual(h.cards.filter(c => P(h.name).cards.includes(c)).length, 2, `${h.name}: 2 fra hånden`);
    assert.strictEqual(h.cards.filter(c => host.state.board.includes(c)).length, 3, `${h.name}: 3 fra bordet`);
  }

  // Ny omgang: nytt omgangsnummer, håndtellingen starter på nytt
  host.emit('host_reset_out'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  assert.strictEqual(host.state.roundNumber, 2);
  assert.strictEqual(host.state.handNumber, 1);
  assert.ok(host.state.players.every(p => p.handDescr === null), 'håndnavn nullstilles ved ny hånd');
});
