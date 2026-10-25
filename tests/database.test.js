// Database: identitet, statistikk, omganger, migrering, dashboard-API og personvern.
// Bruker en midlertidig SQLite-fil – den ekte Turso-databasen røres aldri.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { createClient } = require('@libsql/client');
const { startServer, tempDbFile, wait, findPlayer, todayString } = require('./helpers');

test('Identitet og statistikk', async (t) => {
  const srv = await startServer({ dbFile: tempDbFile() });
  t.after(() => srv.stop());
  const host = srv.host();
  const ola = srv.player('Ola', 'uuid-ola'); srv.player('Olav', 'uuid-olav'); await wait(300);

  const eve = srv.player('ola'); await wait(200);
  assert.ok(eve.joinFailed, 'kan ikke ta navnet til en tilkoblet spiller');
  const empty = srv.player('   '); await wait(200);
  assert.ok(empty.joinFailed, 'tomt navn avvises');
  const lang = srv.player('Et veldig langt navn som er for langt'); await wait(200);
  assert.strictEqual(lang.joinedData.name.length, 15, 'langt navn kuttes til 15 tegn');
  eve.disconnect(); empty.disconnect();

  const olaNy = srv.player('Ola2', 'uuid-ola'); await wait(200);
  assert.strictEqual(olaNy.joinedData.name, 'Ola', 'samme UUID = samme spiller');
  ola.disconnect();

  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(100);
  srv.player('Sen', 'uuid-sen'); await wait(200); // venter på neste hånd
  lang.emit('player_fold'); olaNy.emit('player_fold'); await wait(300);
  assert.strictEqual(host.state.winnerInfo.winnerName, 'Olav');
  assert.ok(!JSON.stringify(host.state).includes('uuid-'), 'ingen UUID sendes til skjermene');

  olaNy.disconnect(); await wait(200);
  const olaTlf2 = srv.player('Ola'); await wait(200);
  assert.strictEqual(olaTlf2.uuid, 'uuid-ola', 'ny nettleser tar over frakoblet plass med opprinnelig UUID');

  await wait(300);
  const db = await srv.getJson('/api/debug-db');
  const st = Object.fromEntries(db.player_stats.map(r => [r.name, r]));
  assert.strictEqual(st.Ola.hands_won, 0, 'Ola får ikke Olav sin seier');
  assert.strictEqual(st.Olav.hands_won, 1);
  assert.strictEqual(st.Sen.hands_played, 0, 'ventende spiller teller ikke');
  assert.strictEqual(db.winning_hands[0].player_uuid, 'uuid-olav');
});

test('Omganger og migrering fra gammelt skjema', async (t) => {
  const dbFile = tempDbFile();
  const old = createClient({ url: 'file:' + dbFile });
  await old.execute(`CREATE TABLE winning_hands (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, player_uuid TEXT, player_name TEXT, hand_description TEXT, winning_cards TEXT, hand_rank INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await old.execute(`INSERT INTO winning_hands (player_name, hand_description) VALUES ('Gammel', 'Ett Par')`);
  old.close();

  const srv = await startServer({ dbFile });
  t.after(() => srv.stop());
  const host = srv.host();
  const P = n => findPlayer(host.state, n);
  const out = async (n, v = true) => { host.emit('host_set_out', { seat: P(n).seat, out: v }); await wait(300); };

  let d = await srv.getJson('/api/debug-db');
  assert.ok(d.winning_hands.find(h => h.player_name === 'Gammel'), 'gammel rad beholdt');
  assert.ok('omgang_id' in d.winning_hands[0], 'omgang_id-kolonnen er lagt til');

  const A = srv.player('Anne'), B = srv.player('Bjørn'), C = srv.player('Cato'); await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  for (let i = 0; i < 2; i++) {
    host.emit('start_new_hand'); await wait(150);
    A.emit('player_fold'); await wait(100); B.emit('player_fold'); await wait(300);
  }
  await out('Anne'); await out('Bjørn');
  assert.strictEqual(host.state.roundWinner, 'Cato');

  d = await srv.getJson('/api/debug-db');
  assert.strictEqual(d.omganger.length, 1);
  assert.strictEqual(d.omganger[0].winner_name, 'Cato');
  const r1 = d.omganger[0].omgang_id;
  assert.strictEqual(d.winning_hands.filter(h => h.omgang_id === r1).length, 2);

  await out('Bjørn', false);
  d = await srv.getJson('/api/debug-db');
  assert.strictEqual(d.omganger[0].winner_name, null, 'angre gjenåpner omgangen');
  await out('Bjørn');
  host.emit('host_reset_out'); await wait(200);

  host.emit('start_new_hand'); await wait(150);
  C.emit('player_fold'); await wait(100); B.emit('player_fold'); await wait(300);
  await out('Bjørn'); await out('Cato');
  d = await srv.getJson('/api/debug-db');
  const r2 = d.omganger.find(o => o.omgang_id !== r1);
  assert.strictEqual(r2.winner_name, 'Anne');

  const stats = Object.fromEntries((await srv.getJson('/api/stats')).map(s => [s.name, s]));
  assert.strictEqual(stats.Cato.rounds_won, 1);
  assert.strictEqual(stats.Anne.rounds_won, 1);
  assert.strictEqual(stats['Bjørn'].rounds_won, 0);

  const hands = await srv.getJson('/api/hands?date=' + todayString());
  assert.strictEqual(hands.filter(h => h.omgang_nr === 1).length, 2);
  assert.strictEqual(hands.filter(h => h.omgang_nr === 2).length, 1);
  assert.deepStrictEqual(await srv.getJson('/api/winning-hands'), [], 'topp 10 tar ikke med «alle andre kastet seg» (gammel rad har rank 0)');
});

test('Dashboard-API: datofilter, omgangsnummer og all time', async (t) => {
  const dbFile = tempDbFile();
  const db = createClient({ url: 'file:' + dbFile });
  const iso = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();
  await db.execute(`CREATE TABLE omganger (omgang_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, started_at TEXT NOT NULL, ended_at TEXT, game_mode TEXT, winner_uuid TEXT, winner_name TEXT)`);
  await db.execute(`CREATE TABLE winning_hands (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, player_uuid TEXT, player_name TEXT, hand_description TEXT, winning_cards TEXT, hand_rank INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), omgang_id INTEGER)`);
  const R = async (start, end, winner) => Number((await db.execute({ sql: 'INSERT INTO omganger (session_id, started_at, ended_at, winner_name) VALUES (1,?,?,?)', args: [start, end, winner] })).lastInsertRowid);
  const H = (rid, at, name, descr, rank) => db.execute({ sql: 'INSERT INTO winning_hands (omgang_id, player_name, hand_description, hand_rank, winning_cards, created_at) VALUES (?,?,?,?,?,?)', args: [rid, name, descr, rank, '{"v":2,"winningCards":[]}', at] });
  const a1 = await R(iso(2026, 10, 10, 19, 0), iso(2026, 10, 10, 20, 30), 'Ola');
  await H(a1, iso(2026, 10, 10, 19, 20), 'Ola', "Fire like, 9's", 80000000000);
  await H(a1, iso(2026, 10, 10, 19, 40), 'Bjørn', 'Alle andre kastet seg', 0);
  const a2 = await R(iso(2026, 10, 10, 20, 35), iso(2026, 10, 10, 22, 0), 'Anne-Marte');
  await H(a2, iso(2026, 10, 10, 21, 0), 'Anne-Marte', 'Straight Flush, 9h High', 90000000000);
  const b1 = await R(iso(2026, 10, 11, 22, 0), iso(2026, 10, 12, 1, 0), 'Christian');
  await H(b1, iso(2026, 10, 12, 0, 30), 'Kristoffer', 'Flush, Ah High', 60000000000);
  db.close();

  // Serveren startes i UTC, som på Render – den skal likevel regne dager i norsk tid
  const srv = await startServer({ dbFile, env: { TZ: 'UTC' } });
  t.after(() => srv.stop());

  const all = await srv.getJson('/api/winning-hands');
  assert.strictEqual(all.length, 3, '«kastet seg» er ikke med');
  assert.strictEqual(all[0].hand_description, 'Straight Flush, 9-høy i hjerter');
  assert.strictEqual(all[0].omgang_nr, 2);
  const flush = all.find(h => h.player_name === 'Kristoffer');
  assert.strictEqual(flush.omgang_nr, 1);
  assert.strictEqual(flush.omgang_date, '2026-10-11', 'hånd etter midnatt hører til omgangen fra dagen før');

  // Hånden kl. 00:30 norsk tid 12.10 er kl. 22:30 UTC 11.10 – skal likevel høre til 12.10
  assert.strictEqual((await srv.getJson('/api/winning-hands?date=2026-10-12')).length, 1);
  assert.strictEqual((await srv.getJson('/api/hands?date=2026-10-11')).length, 0);
  assert.strictEqual((await srv.getJson('/api/hands?date=2026-10-10')).length, 3, 'alle tre hender den dagen, også «kastet seg»');
  const rounds = await srv.getJson('/api/rounds?date=2026-10-10');
  assert.deepStrictEqual(rounds.map(r => r.omgang_nr), [1, 2]);
  assert.strictEqual(rounds[1].winner_name, 'Anne-Marte');
  assert.strictEqual((await fetch(srv.url + '/api/hands?date=tull')).status, 400);
});

test('Personvern: kort som ikke ble vist ved bordet lagres ikke', async (t) => {
  const srv = await startServer({ dbFile: tempDbFile() });
  t.after(() => srv.stop());
  const host = srv.host();
  const A = srv.player('Anne'), B = srv.player('Bjørn'), C = srv.player('Cato'); await wait(300);
  host.emit('set_game_mode', 'OMAHA'); await wait(100);

  // Hånd 1: alle andre kaster seg (Cato kan ha bløffet)
  host.emit('start_new_hand'); await wait(150);
  host.emit('next_phase'); await wait(100);
  A.emit('player_fold'); await wait(100); B.emit('player_fold'); await wait(400);
  // Hånd 2: Anne kaster, Bjørn og Cato til showdown
  host.emit('next_phase'); await wait(150);
  const anneCards = A.st.cards.slice();
  A.emit('player_fold'); await wait(100);
  for (let i = 0; i < 4; i++) { host.emit('next_phase'); await wait(120); }
  await wait(400);

  const db = await srv.getJson('/api/debug-db');
  const rows = db.winning_hands.slice().sort((a, b) => a.id - b.id);
  const fold = JSON.parse(rows[0].winning_cards), show = JSON.parse(rows[1].winning_cards);
  assert.strictEqual(fold.cards.length, 0, 'ingen spillerkort ved «alle andre kastet seg»');
  assert.strictEqual(fold.winningCards.length, 0);
  assert.strictEqual(show.cards.length, 2, 'kun spillerne som var med til showdown');
  assert.ok(!show.cards.some(p => p.name === 'Anne'));
  assert.ok(!anneCards.some(c => JSON.stringify(show.cards).includes(`"${c}"`)), 'Annes kastede kort er ikke lagret');
  assert.strictEqual(show.winningCards.length, 5);
});

test('Engangsopprydding av kort i eldre rader', async (t) => {
  const dbFile = tempDbFile();
  const old = createClient({ url: 'file:' + dbFile });
  await old.execute(`CREATE TABLE winning_hands (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, player_uuid TEXT, player_name TEXT, hand_description TEXT, winning_cards TEXT, hand_rank INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = (name, rank, wc) => old.execute({ sql: 'INSERT INTO winning_hands (player_name, hand_rank, winning_cards) VALUES (?,?,?)', args: [name, rank, JSON.stringify(wc)] });
  await ins('Bløffer', 0, { board: ['2h'], winningCards: [], cards: [{ name: 'Bløffer', cards: ['7c', '2d'] }] });
  await ins('Vinner', 6e10, { board: ['2h'], winningCards: ['Ah', 'Kh', '2h', '3h', '4h'], cards: [{ name: 'Kastet', cards: ['Qs', 'Qc'] }] });
  await ins('Ny', 6e10, { v: 2, board: [], winningCards: [], cards: [{ name: 'Ny', cards: ['As', 'Ks'] }] });
  old.close();

  const srv = await startServer({ dbFile });
  t.after(() => srv.stop());
  const rows = (await srv.getJson('/api/debug-db')).winning_hands.sort((a, b) => a.id - b.id).map(r => JSON.parse(r.winning_cards));
  assert.deepStrictEqual(rows[0].cards, []);
  assert.deepStrictEqual(rows[1].cards, []);
  assert.strictEqual(rows[1].winningCards.length, 5, 'vinnerhånden beholdes');
  assert.strictEqual(rows[2].cards.length, 1, 'nye rader (v2) røres ikke');
  assert.match(srv.log(), /Fjernet ikke-viste kort fra 2 eldre hender/);
});

test('Admin-endepunkter: lokalt, eller med admin-passord', async (t) => {
  const srv = await startServer({ dbFile: tempDbFile(), env: { ADMIN_PASSWORD: 'hemmelig' } });
  t.after(() => srv.stop());
  const local = `http://127.0.0.1:${srv.port}`;
  assert.strictEqual((await fetch(local + '/api/debug-db')).status, 200, 'direkte lokalt uten passord');

  // Bak en proxy (som Render) regnes forespørselen ikke som lokal
  const proxied = { 'x-forwarded-for': '203.0.113.5' };
  const noPw = await fetch(local + '/api/debug-db', { headers: proxied });
  assert.strictEqual(noPw.status, 403);
  assert.strictEqual((await noPw.json()).needsPassword, true);
  assert.strictEqual((await fetch(local + '/api/debug-db', { headers: { ...proxied, 'x-admin-password': 'feil' } })).status, 403);
  assert.strictEqual((await fetch(local + '/api/debug-db', { headers: { ...proxied, 'x-admin-password': 'hemmelig' } })).status, 200);
  assert.strictEqual((await fetch(local + '/api/reset-db', { method: 'POST', headers: proxied })).status, 403);
  assert.strictEqual((await fetch(local + '/api/reset-db', { method: 'POST', headers: { ...proxied, 'x-admin-password': 'hemmelig' } })).status, 200);
  assert.strictEqual((await fetch(local + '/api/stats', { headers: proxied })).status, 200, 'dashboard-API er åpent');

  const lan = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  if (lan) {
    assert.strictEqual((await fetch(`http://${lan.address}:${srv.port}/api/debug-db`)).status, 403, 'fra nettet uten passord');
  }
});

test('Admin-endepunkter uten ADMIN_PASSWORD: kun lokalt', async (t) => {
  const srv = await startServer({ dbFile: tempDbFile() });
  t.after(() => srv.stop());
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/debug-db`, { headers: { 'x-forwarded-for': '203.0.113.5', 'x-admin-password': 'noe' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).needsPassword, false);
});

test('Omgang fortsetter etter omstart; ute huskes; forlatte omganger avsluttes', async (t) => {
  const dbFile = tempDbFile();

  // Første serverkjøring: én hånd i omgangen, Anne markeres ute
  let srv = await startServer({ dbFile });
  let host = srv.host();
  let P = n => findPlayer(host.state, n);
  let A = srv.player('Anne', 'u-a'), B = srv.player('Bjørn', 'u-b'); srv.player('Cato', 'u-c');
  await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  A.emit('player_fold'); await wait(100); B.emit('player_fold'); await wait(300);
  host.emit('host_set_out', { seat: P('Anne').seat, out: true }); await wait(300);
  const roundId = (await srv.getJson('/api/debug-db')).omganger[0].omgang_id;
  await srv.stop();

  // En gammel, forlatt omgang (10 timer siden) som aldri ble avsluttet
  const db = createClient({ url: 'file:' + dbFile });
  await db.execute({ sql: 'INSERT INTO omganger (session_id, started_at) VALUES (1, ?)', args: [new Date(Date.now() - 10 * 3600e3).toISOString()] });
  db.close();

  // Serveren starter på nytt (deploy / Render-dvale)
  srv = await startServer({ dbFile });
  t.after(() => srv.stop());
  assert.match(srv.log(), new RegExp(`Fortsetter omgang ${roundId}`));
  assert.match(srv.log(), /Avsluttet 1 forlatte omganger/);

  host = srv.host();
  P = n => findPlayer(host.state, n);
  A = srv.player('Anne', 'u-a'); B = srv.player('Bjørn', 'u-b'); srv.player('Cato', 'u-c');
  await wait(300);
  assert.strictEqual(P('Anne').out, true, 'Anne er fortsatt ute etter omstart');
  assert.strictEqual(host.state.handNumber, 1, 'håndnummeret huskes etter omstart');
  const rounds = await srv.getJson('/api/rounds?date=' + todayString());
  assert.strictEqual(host.state.roundNumber, rounds.find(r => r.omgang_id === roundId).omgang_nr,
    'omgangsnummeret er det samme som i dashboardet');

  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(150);
  assert.strictEqual(host.state.handNumber, 2);
  B.emit('player_fold'); await wait(300);
  let d = await srv.getJson('/api/debug-db');
  const hands = d.winning_hands.filter(h => h.omgang_id === roundId);
  assert.strictEqual(hands.length, 2, 'hånden etter omstart hører til samme omgang');
  const old = d.omganger.find(o => o.omgang_id !== roundId);
  assert.ok(old.ended_at, 'forlatt omgang er avsluttet');
  assert.strictEqual(old.winner_name, null);

  // «Ny omgang» før omgangen er avgjort -> avbrutt (avsluttet uten vinner)
  host.emit('host_reset_out'); await wait(300);
  d = await srv.getJson('/api/debug-db');
  const r = d.omganger.find(o => o.omgang_id === roundId);
  assert.ok(r.ended_at && r.winner_name === null, 'avbrutt omgang har slutt-tid men ingen vinner');
});

test('Omgangsnummeret starter på 1 på en ny dato', async (t) => {
  // Med database: en omgang som startet i går teller ikke med i dag
  const dbFile = tempDbFile();
  let srv = await startServer({ dbFile });
  await srv.stop();
  const db = createClient({ url: 'file:' + dbFile });
  const igaar = new Date(Date.now() - 24 * 3600e3).toISOString();
  await db.execute({ sql: 'INSERT INTO omganger (session_id, started_at, ended_at) VALUES (1, ?, ?)', args: [igaar, igaar] });
  db.close();

  srv = await startServer({ dbFile });
  t.after(() => srv.stop());
  const host = srv.host();
  srv.player('Anne'); srv.player('Bjørn'); await wait(300);
  host.emit('set_game_mode', 'TEXAS'); await wait(100);
  host.emit('start_new_hand'); await wait(200);
  assert.strictEqual(host.state.roundNumber, 1, 'gårsdagens omgang teller ikke');

  // Uten database: telleren nullstilles når datoen skifter
  const { nextRoundNumberWithoutDb } = require('../server.js');
  assert.strictEqual(nextRoundNumberWithoutDb('2026-10-24T18:00:00Z'), 1);
  assert.strictEqual(nextRoundNumberWithoutDb('2026-10-24T20:00:00Z'), 2);
  assert.strictEqual(nextRoundNumberWithoutDb('2026-10-25T18:00:00Z'), 1, 'ny dato: omgang 1');
  assert.strictEqual(nextRoundNumberWithoutDb('2026-10-25T19:00:00Z'), 2);
});
