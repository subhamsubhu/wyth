/**
 * Watch Party — Playback sync E2E test
 *
 * Verifies the user-reported bug: when a NON-host user joins via room code
 * and emits play / pause / seek, the host (and every other member) must
 * receive the corresponding broadcast events.
 *
 * Setup:
 *   • HOST   — Firebase signed-in admin (creates room via REST API)
 *   • JOINER — anonymous socket (server allows tokenless connections)
 *
 * All assertions print PASS/FAIL and the script exits with code 0 only if
 * every check succeeds.
 */
const { io: ioc } = require('socket.io-client');
const https = require('https');

const BASE = process.env.BASE_URL || 'http://localhost:8001';
const SOCKET_PATH = '/api/socket.io';
const FIREBASE_KEY = 'AIzaSyCgkNmm4o_dG4bNmg0_AgnpgYwjs6ZV53Q';
const EMAIL = 'subhamghadia@admin.com';
const PASSWORD = '#subham5';

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label}`); failures++; }
};

function httpJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : {} }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const waitFor = (sock, ev, ms = 4000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Timeout waiting for '${ev}'`)), ms);
  sock.once(ev, (payload) => { clearTimeout(t); resolve(payload); });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── 1. Sign in host via Firebase REST
  const fbRes = await httpJson(
    'POST',
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { email: EMAIL, password: PASSWORD, returnSecureToken: true }
  );
  assert(fbRes.status === 200 && fbRes.body.idToken, 'Firebase sign-in for host');
  const hostToken = fbRes.body.idToken;
  const hostUid = fbRes.body.localId;

  // ── 2. Create room via REST as host
  const createRes = await httpJson('POST', `${BASE}/api/rooms/create`, { roomName: 'TEST_SyncRoom' }, { Authorization: `Bearer ${hostToken}` });
  assert(createRes.status === 200 && createRes.body.success, `POST /api/rooms/create (status=${createRes.status})`);
  const roomId = createRes.body.roomId;
  const playbackControl = createRes.body.roomData?.settings?.playbackControl;
  assert(playbackControl === 'everyone', `Room default playbackControl === 'everyone' (got '${playbackControl}')`);

  // ── 3. Health
  const health = await httpJson('GET', `${BASE}/api/health`);
  assert(health.status === 200 && health.body.status === 'healthy', 'GET /api/health 200');

  // ── 4. Connect HOST socket (with Firebase token) and JOINER socket (anonymous)
  const hostSock = ioc(BASE, { path: SOCKET_PATH, transports: ['websocket'], auth: { token: hostToken }, reconnection: false });
  const joinerSock = ioc(BASE, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false }); // anonymous

  await Promise.all([waitFor(hostSock, 'connect'), waitFor(joinerSock, 'connect')]);
  assert(hostSock.connected && joinerSock.connected, 'Both sockets connected to /api/socket.io');

  // Generic error listener
  [hostSock, joinerSock].forEach(s => s.on('playback-denied', p => console.log('  playback-denied:', p)));

  // ── 5. Both join room
  const hostUserJoined = waitFor(hostSock, 'user-joined', 5000);
  hostSock.emit('join-room', { roomId });
  joinerSock.emit('join-room', { roomId });
  // host should see joiner-joined event
  try {
    const ev = await hostUserJoined;
    assert(!!ev && ev.userId, `Host received 'user-joined' from joiner (userId=${ev.userId})`);
  } catch (e) { assert(false, `Host received 'user-joined' (${e.message})`); }

  await sleep(300); // ensure both are in the room

  // ── 6. JOINER emits play-video → HOST must receive video-play
  let p = waitFor(hostSock, 'video-play', 4000);
  joinerSock.emit('play-video', { roomId, currentTime: 12.5 });
  try {
    const payload = await p;
    assert(payload && Math.abs(payload.currentTime - 12.5) < 0.01, `HOST got video-play from joiner (currentTime=${payload?.currentTime})`);
  } catch (e) { assert(false, `HOST got video-play from joiner (${e.message})`); }

  // ── 7. JOINER emits pause-video → HOST must receive video-pause
  p = waitFor(hostSock, 'video-pause', 4000);
  joinerSock.emit('pause-video', { roomId, currentTime: 20 });
  try {
    const payload = await p;
    assert(payload && payload.currentTime === 20, `HOST got video-pause from joiner (currentTime=${payload?.currentTime})`);
  } catch (e) { assert(false, `HOST got video-pause from joiner (${e.message})`); }

  // ── 8. JOINER emits seek-video → HOST must receive video-seek
  p = waitFor(hostSock, 'video-seek', 4000);
  joinerSock.emit('seek-video', { roomId, currentTime: 55.5 });
  try {
    const payload = await p;
    assert(payload && payload.currentTime === 55.5, `HOST got video-seek from joiner (currentTime=${payload?.currentTime})`);
  } catch (e) { assert(false, `HOST got video-seek from joiner (${e.message})`); }

  // ── 9. Reverse direction: HOST emits play → JOINER must receive video-play
  p = waitFor(joinerSock, 'video-play', 4000);
  hostSock.emit('play-video', { roomId, currentTime: 7 });
  try {
    const payload = await p;
    assert(payload && payload.currentTime === 7, `JOINER got video-play from host (currentTime=${payload?.currentTime})`);
  } catch (e) { assert(false, `JOINER got video-play from host (${e.message})`); }

  // ── 10. Sender must NOT receive own broadcast (socket.to(roomId) excludes sender)
  let selfEcho = false;
  const selfListener = () => { selfEcho = true; };
  joinerSock.on('video-pause', selfListener);
  joinerSock.emit('pause-video', { roomId, currentTime: 1 });
  await sleep(500);
  joinerSock.off('video-pause', selfListener);
  assert(!selfEcho, 'Sender does NOT receive own broadcast (socket.to excludes sender)');

  // ── 11. request-sync flow for late joiner
  const sync = waitFor(joinerSock, 'sync-response', 4000);
  joinerSock.emit('request-sync', { roomId });
  try {
    const state = await sync;
    assert(state && typeof state === 'object', `sync-response received (keys=${Object.keys(state).join(',')})`);
    assert('currentTime' in state || 'isPlaying' in state, 'sync-response carries state fields');
  } catch (e) { assert(false, `sync-response received (${e.message})`); }

  // ── 12. load-video is host-only — joiner emit should NOT trigger video-loaded on host
  let loadedFired = false;
  const loadListener = () => { loadedFired = true; };
  hostSock.on('video-loaded', loadListener);
  joinerSock.emit('load-video', { roomId, videoUrl: 'http://x/y.mp4', videoType: 'direct' });
  await sleep(700);
  hostSock.off('video-loaded', loadListener);
  assert(!loadedFired, 'load-video from non-host is rejected (no video-loaded broadcast)');

  // ── 13. HOST load-video should broadcast (io.to → both receive)
  const hostLoaded = waitFor(joinerSock, 'video-loaded', 4000);
  hostSock.emit('load-video', { roomId, videoUrl: 'http://x/host.mp4', videoType: 'direct' });
  try {
    const payload = await hostLoaded;
    assert(payload && payload.videoUrl === 'http://x/host.mp4', 'HOST load-video broadcast received by joiner');
  } catch (e) { assert(false, `HOST load-video broadcast (${e.message})`); }

  // ── cleanup
  hostSock.disconnect();
  joinerSock.disconnect();
  await sleep(200);

  console.log(`\n=== ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} ===`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('FATAL', err); process.exit(2); });
