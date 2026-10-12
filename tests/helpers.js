// Felles hjelpere for testene: starter en egen server per test og lager simulerte klienter.
// Testene regner datoer i norsk tid, som serveren
process.env.TZ = 'Europe/Oslo';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');

const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Lager en tom, midlertidig SQLite-fil (brukes i stedet for Turso)
function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-poker-test-'));
  return path.join(dir, 'test.db');
}

/**
 * Starter server.js i en egen prosess.
 * @param {object} opts
 * @param {string|null} opts.dbFile  SQLite-fil, eller null for ingen database
 * @param {number} opts.graceMs      Hvor lenge frakoblede beholder plassen
 */
async function startServer({ dbFile = null, graceMs = 1000, env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DISCONNECT_GRACE_MS: String(graceMs),
      // Tom verdi hindrer at dotenv kobler til den ekte Turso-databasen fra .env
      TURSO_DATABASE_URL: dbFile ? `file:${dbFile}` : '',
      TURSO_AUTH_TOKEN: dbFile ? 'test' : '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  // Vent til serveren lytter og (eventuelt) databasen er klar
  const started = Date.now();
  while (!log.includes('Server kjører')) {
    if (Date.now() - started > 10000) throw new Error('Serveren startet ikke:\n' + log);
    if (child.exitCode !== null) throw new Error('Serveren avsluttet:\n' + log);
    await wait(50);
  }
  if (dbFile) {
    while (!log.includes('[DB] Tilkoblet')) {
      if (Date.now() - started > 10000) throw new Error('Databasen ble ikke klar:\n' + log);
      await wait(50);
    }
  }

  const url = `http://localhost:${port}`;
  const sockets = [];

  // Statusskjermen: følger med på offentlig tilstand
  function host() {
    const s = io(url, { forceNew: true });
    s.state = null;
    s.on('state_update', st => { s.state = st; });
    sockets.push(s);
    return s;
  }

  // En spillers telefon: følger med på egen tilstand
  function player(name, uuid) {
    const s = io(url, { forceNew: true });
    s.st = null;
    s.joinedData = null;
    s.joinFailed = null;
    s.kicked = 0;
    s.on('player_state', st => { s.st = st; });
    s.on('joined', d => { s.joinedData = d; s.uuid = d.uuid; });
    s.on('join_failed', d => { s.joinFailed = d; });
    s.on('kicked', () => { s.kicked++; });
    if (name !== undefined) s.emit('join_game', uuid ? { name, uuid } : name);
    sockets.push(s);
    return s;
  }

  function socket() {
    const s = io(url, { forceNew: true });
    sockets.push(s);
    return s;
  }

  async function getJson(p) {
    const res = await fetch(url + p);
    return res.json();
  }

  async function stop() {
    sockets.forEach(s => s.disconnect());
    child.kill();
    await new Promise(r => (child.exitCode !== null ? r() : child.on('exit', r)));
  }

  return { url, port, host, player, socket, getJson, stop, log: () => log };
}

// Finn spiller i offentlig tilstand
function findPlayer(state, name) {
  return state.players.find(p => p.name === name);
}

function todayString() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { startServer, tempDbFile, wait, findPlayer, todayString, ROOT };
