/**
 * Backend WebRTC signaling tests via socket.io-client.
 * Tests the full call flow against the public preview URL.
 */
const { io } = require('socket.io-client');
async function httpGet(url) {
  const r = await fetch(url);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function httpPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

const BASE_URL = process.env.TEST_BASE_URL || 'https://wyth-sync-fix.preview.emergentagent.com';
const SOCKET_PATH = '/api/socket.io';

let pass = 0, fail = 0;
const results = [];

function assert(name, cond, detail = '') {
  if (cond) { pass++; results.push({ name, status: 'PASS' }); console.log(`✅ PASS: ${name}`); }
  else { fail++; results.push({ name, status: 'FAIL', detail }); console.log(`❌ FAIL: ${name} ${detail}`); }
}

function mkClient() {
  return io(BASE_URL, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    auth: { token: '' },
    reconnection: false,
    timeout: 10000,
  });
}

function waitConn(s) {
  return new Promise((res, rej) => {
    s.on('connect', () => res());
    s.on('connect_error', (e) => rej(e));
    setTimeout(() => rej(new Error('connect timeout')), 8000);
  });
}

function once(s, ev, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), timeoutMs);
    s.once(ev, (data) => { clearTimeout(to); res(data); });
  });
}

async function testHealth() {
  const r = await httpGet(`${BASE_URL}/api/health`);
  assert('GET /api/health 200', r.status === 200 && r.data.status === 'healthy');
}

async function testRoomsRest() {
  try {
    const r = await httpPost(`${BASE_URL}/api/rooms`, { name: 'TEST_room', isPublic: true });
    assert('POST /api/rooms responds', [200, 201, 400, 401, 403].includes(r.status), `status=${r.status}`);
  } catch (e) { assert('POST /api/rooms responds', false, e.message); }
}

async function joinRoom(sock, roomId) {
  sock.emit('join-room', { roomId });
  await new Promise(r => setTimeout(r, 400));
}

async function testFullCallFlow() {
  const roomId = `test-room-${Date.now()}-a`;
  const A = mkClient(); const B = mkClient();
  await Promise.all([waitConn(A), waitConn(B)]);
  assert('Two anon sockets connect', A.connected && B.connected);
  await joinRoom(A, roomId); await joinRoom(B, roomId);

  // initiate-call from A → B should get incoming-call, A should get call-initiated
  const pIncoming = once(B, 'incoming-call', 5000);
  const pInit = once(A, 'call-initiated', 5000);
  A.emit('initiate-call', { roomId, callType: 'video' });
  const [incoming, init] = await Promise.all([pIncoming, pInit]);
  assert('B receives incoming-call', incoming && incoming.roomId === roomId && incoming.callType === 'video');
  assert('A receives call-initiated', init && init.roomId === roomId);

  // accept-call from B → A gets call-accepted
  const pAccepted = once(A, 'call-accepted', 5000);
  B.emit('accept-call', { roomId });
  const accepted = await pAccepted;
  assert('A receives call-accepted on B accept', accepted && accepted.userId);

  // Both join-call → user-joined-call relay
  const pUserJoined = once(A, 'user-joined-call', 5000);
  A.emit('join-call', { roomId, callType: 'video' });
  await new Promise(r => setTimeout(r, 200));
  B.emit('join-call', { roomId, callType: 'video' });
  const uj = await pUserJoined;
  assert('user-joined-call relayed to A when B joins', uj && uj.userId);

  // webrtc-offer/answer relay
  const pOffer = once(B, 'webrtc-offer', 5000);
  A.emit('webrtc-offer', { roomId, targetUserId: uj.userId, offer: { type: 'offer', sdp: 'fake' } });
  const off = await pOffer;
  assert('webrtc-offer relayed', off && off.offer && off.offer.sdp === 'fake');

  const pAnswer = once(A, 'webrtc-answer', 5000);
  B.emit('webrtc-answer', { roomId, targetUserId: off.fromUserId, answer: { type: 'answer', sdp: 'fakea' } });
  const ans = await pAnswer;
  assert('webrtc-answer relayed', ans && ans.answer && ans.answer.sdp === 'fakea');

  // ice-candidate relay
  const pIce = once(B, 'ice-candidate', 5000);
  A.emit('ice-candidate', { roomId, targetUserId: uj.userId, candidate: { candidate: 'cand' } });
  const ice = await pIce;
  assert('ice-candidate relayed', ice && ice.candidate);

  // leave-call by B → A should get user-left-call, AND since multi-participant
  // dropped to 1, server auto-ends and broadcasts call-ended.
  const pLeft = once(A, 'user-left-call', 5000);
  const pEnded = once(A, 'call-ended', 5000);
  B.emit('leave-call', { roomId });
  const left = await pLeft;
  assert('A receives user-left-call when B leaves', left && left.userId);
  const ended = await pEnded;
  assert('Server auto-ends call after participant <=1 (maybeAutoEndOnLeave)',
    ended && ended.roomId === roomId && (ended.reason === 'last-participant' || ended.reason === 'ended'));

  A.close(); B.close();
}

async function testCheckActiveCall() {
  const roomId = `test-room-${Date.now()}-b`;
  const A = mkClient(); const B = mkClient(); const C = mkClient();
  await Promise.all([waitConn(A), waitConn(B), waitConn(C)]);
  await joinRoom(A, roomId); await joinRoom(B, roomId);

  A.emit('initiate-call', { roomId, callType: 'voice' });
  await once(B, 'incoming-call', 5000);

  // C joins room later and asks check-active-call → should get incoming-call
  await joinRoom(C, roomId);
  const pInc = once(C, 'incoming-call', 5000);
  C.emit('check-active-call', { roomId });
  const inc = await pInc;
  assert('check-active-call returns incoming-call to late joiner', inc && inc.callType === 'voice');

  // Cancel by initiator → broadcast call-ended
  const pCEnded = once(B, 'call-ended', 5000);
  A.emit('cancel-call', { roomId });
  const ce = await pCEnded;
  assert('cancel-call by initiator broadcasts call-ended', ce && ce.reason === 'cancelled');

  A.close(); B.close(); C.close();
}

async function testUnansweredTimeout() {
  const roomId = `test-room-${Date.now()}-c`;
  const A = mkClient(); const B = mkClient();
  await Promise.all([waitConn(A), waitConn(B)]);
  await joinRoom(A, roomId); await joinRoom(B, roomId);

  const pInc = once(B, 'incoming-call', 5000);
  A.emit('initiate-call', { roomId, callType: 'voice' });
  await pInc;

  // Wait ~22s for unanswered timeout (UNANSWERED_TIMEOUT_MS=20s)
  console.log('   waiting ~22s for unanswered auto-end...');
  const ended = await once(A, 'call-ended', 25000);
  assert('Unanswered auto-end fires (~20s)', ended && ended.reason === 'unanswered');

  A.close(); B.close();
}

(async () => {
  console.log(`Testing against ${BASE_URL}${SOCKET_PATH}`);
  try {
    await testHealth();
    await testRoomsRest();
    await testFullCallFlow();
    await testCheckActiveCall();
    await testUnansweredTimeout();
  } catch (e) {
    console.error('Suite error:', e);
    fail++;
  }
  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  // Write JUnit-ish JSON
  require('fs').writeFileSync('/app/test_reports/pytest/webrtc_results.json',
    JSON.stringify({ pass, fail, results }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
})();
