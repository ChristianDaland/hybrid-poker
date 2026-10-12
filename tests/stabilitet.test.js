// Stabilitet: reconnect, rekkefølge, spillere som kommer midt i en hånd, frakobling
const test = require('node:test');
const assert = require('node:assert');
const { startServer, wait, findPlayer } = require('./helpers');

test('Reconnect, sen spiller, showdown og frakobling', async (t) => {
  const srv = await startServer({ graceMs: 1000 });
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);

  const A = srv.player('Anne'), B = srv.player('Bjørn'), C = srv.player('Cato');
  await wait(300);
  host.emit('set_game_mode', 'OMAHA'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  const order1 = host.state.players.map(p => p.name).join();
  const dealer1 = host.state.players.find(p => p.role === 'Dealer');

  await t.test('reconnect (telefon i dvale) endrer ikke rekkefølgen', async () => {
    const uuid = B.uuid;
    B.disconnect(); await wait(100);
    const B2 = srv.socket();
    B2.emit('rejoin_game', { uuid }); await wait(200);
    assert.strictEqual(host.state.players.map(p => p.name).join(), order1);
    assert.strictEqual(P('Bjørn').connected, true);
  });

  srv.player('Dina'); await wait(200);

  await t.test('spiller som kommer midt i en hånd venter', () => {
    assert.strictEqual(P('Dina').waiting, true);
  });

  await t.test('showdown krasjer ikke, og ventende spiller kan ikke vinne', async () => {
    for (let i = 0; i < 4; i++) { host.emit('next_phase'); await wait(150); }
    assert.strictEqual(host.state.phase, 'SHOWDOWN');
    assert.ok(!host.state.winnerInfo.winnerName.includes('Dina'));
  });

  await t.test('fold under showdown ignoreres', async () => {
    const winner = host.state.winnerInfo.winnerName;
    A.emit('player_fold'); C.emit('player_fold'); await wait(150);
    assert.strictEqual(host.state.phase, 'SHOWDOWN');
    assert.strictEqual(host.state.winnerInfo.winnerName, winner);
  });

  await t.test('dealerknappen flytter ett sete', async () => {
    host.emit('next_phase'); await wait(150);
    const seats = host.state.players.map(p => p.seat);
    const dealer2 = host.state.players.find(p => p.role === 'Dealer');
    assert.strictEqual(dealer2.seat, seats[(seats.indexOf(dealer1.seat) + 1) % seats.length]);
    assert.ok(!host.state.players.some(p => p.waiting), 'Dina er med i hånd 2');
  });

});

test('Frakoblet spiller fjernes ikke midt i hånd, men ved neste hånd', async (t) => {
  const srv = await startServer({ graceMs: 800 });
  t.after(() => srv.stop());
  const host = srv.host();
  const A = srv.player('Anne'), B = srv.player('Bjørn'), C = srv.player('Cato');
  await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  C.disconnect(); await wait(1200);
  assert.ok(findPlayer(host.state, 'Cato'), 'Cato fortsatt ved bordet midt i hånden');
  A.emit('player_fold'); await wait(100);
  B.emit('player_fold'); await wait(200);
  assert.strictEqual(host.state.phase, 'FINISHED');
  assert.strictEqual(host.state.winnerInfo.winnerName, 'Cato');
  host.emit('next_phase'); await wait(200);
  assert.ok(!findPlayer(host.state, 'Cato'), 'Cato fjernet ved start av neste hånd');
  assert.deepStrictEqual(host.state.players.map(p => p.seat), [1, 2], 'setene nummereres om');
});

test('Stille innlogging etter serveromstart beholder UUID', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  // Simulerer mobilens logikk: rejoin -> rejoin_failed -> join_game med navn + uuid
  const s = srv.socket();
  let joined = null;
  s.on('joined', d => { joined = d; });
  s.on('rejoin_failed', () => s.emit('join_game', { name: 'Per', uuid: 'fast-uuid-123', auto: true }));
  s.emit('rejoin_game', { uuid: 'fast-uuid-123' }); await wait(300);
  assert.strictEqual(joined.uuid, 'fast-uuid-123');

  s.disconnect();
  const s2 = srv.socket();
  let j2 = null;
  s2.on('joined', d => { j2 = d; });
  s2.emit('rejoin_game', { uuid: 'fast-uuid-123' }); await wait(300);
  assert.strictEqual(j2.name, 'Per');
});

test('Statusskjerm som kobler til får tilstanden med en gang', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  srv.player('Anne'); await wait(200);
  const late = srv.host(); await wait(200);
  assert.ok(late.state, 'fikk state_update ved tilkobling');
  assert.strictEqual(late.state.players.length, 1);
});
