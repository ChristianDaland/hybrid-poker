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

test('Dealer kan kaste kort for frakoblet spiller, ikke for tilkoblet', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  srv.player('Anne'); const B = srv.player('Bjørn'); const C = srv.player('Cato'); await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  host.emit('host_fold_player', P('Anne').seat); await wait(150);
  assert.strictEqual(P('Anne').folded, false);
  C.disconnect(); await wait(200);
  host.emit('host_fold_player', P('Cato').seat); await wait(150);
  assert.strictEqual(P('Cato').folded, true);
  B.emit('player_fold'); await wait(200);
  assert.strictEqual(host.state.phase, 'FINISHED');
  assert.strictEqual(host.state.winnerInfo.winnerName, 'Anne');
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
