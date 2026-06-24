/**
 * Defensive `currentTime` regression tests for backend/sockets/videoSocket.js
 *
 * These tests prove the bug fix: the server must NEVER accept
 * `currentTime: undefined | NaN | < 0 | > 86400` as a silent fallback to 0.
 * It must instead fall back to its own authoritative state (advanced by
 * elapsed × playbackRate if it was playing).
 *
 * Run standalone:   node backend/tests/videoSocket_defensive.test.js
 *
 * No Firebase / network is required — both `realtimeDb` and `db` are mocked
 * via a require-cache shim before videoSocket is loaded.
 */
'use strict';

const path = require('path');
const Module = require('module');

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label}`); failures++; }
};

// ─── In-memory mock for Realtime DB + Firestore ──────────────────────────────
let roomState = {};
const persisted = {};

function makeRef(refPath) {
  return {
    once: async () => ({
      val: () => {
        // Support paths like rooms/<id>/state and rooms/<id>/state/playbackRate
        if (refPath.endsWith('/state')) return { ...roomState };
        if (refPath.endsWith('/state/playbackRate')) {
          return roomState.playbackRate;
        }
        return null;
      },
      exists: () => true,
    }),
    update: async (patch) => {
      if (refPath.endsWith('/state')) {
        roomState = { ...roomState, ...patch };
      }
    },
  };
}

const mockFirebase = {
  realtimeDb: { ref: makeRef },
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        update: async (patch) => { Object.assign(persisted, patch); },
      }),
    }),
  },
};

const mockValidation = {
  validateVideoUrl: (u) => ({ valid: true, sanitized: u }),
  validatePayloadSize: () => ({ valid: true }),
};

// ─── Intercept require() so videoSocket loads our mocks ──────────────────────
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === '../config/firebase') return path.join(__dirname, '__mock_firebase__.js');
  if (req === '../utils/validation') return path.join(__dirname, '__mock_validation__.js');
  return origResolve.call(this, req, parent, ...rest);
};
require.cache[path.join(__dirname, '__mock_firebase__.js')] = {
  id: path.join(__dirname, '__mock_firebase__.js'),
  filename: path.join(__dirname, '__mock_firebase__.js'),
  exports: mockFirebase,
  loaded: true,
};
require.cache[path.join(__dirname, '__mock_validation__.js')] = {
  id: path.join(__dirname, '__mock_validation__.js'),
  filename: path.join(__dirname, '__mock_validation__.js'),
  exports: mockValidation,
  loaded: true,
};

const handleVideoSocket = require('../sockets/videoSocket');

// ─── Tiny socket / io shim ───────────────────────────────────────────────────
function makeSocket() {
  const handlers = {};
  return {
    user: { uid: 'u1', name: 'Tester' },
    rooms: new Set(),
    on: (ev, fn) => { handlers[ev] = fn; },
    emit: () => {},
    handlers,
  };
}
const io = {
  to: () => ({ emit: () => {} }),
  sockets: { adapter: { rooms: new Map() } },
};

// ─── Test runner ─────────────────────────────────────────────────────────────
async function resetState(initial) {
  roomState = { ...initial };
}

async function run() {
  // ── play-video defensive tests ──────────────────────────────────────────
  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    // Pretend the server already knows we're at t=420, paused.
    await resetState({
      currentTime: 420,
      isPlaying: false,
      playbackRate: 1,
      lastUpdate: Date.now(),
      videoUrl: 'https://example.com/v.mp4',
    });

    await sock.handlers['play-video']({ roomId: 'r1', currentTime: undefined });
    assert(
      Math.abs(roomState.currentTime - 420) < 1,
      `play-video with undefined keeps server time ≈420 (got ${roomState.currentTime})`
    );
    handleVideoSocket._stopHeartbeat('r1');
  }

  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 420, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['play-video']({ roomId: 'r1', currentTime: NaN });
    assert(
      Math.abs(roomState.currentTime - 420) < 1,
      `play-video with NaN keeps server time ≈420 (got ${roomState.currentTime})`
    );
    handleVideoSocket._stopHeartbeat('r1');
  }

  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 420, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['play-video']({ roomId: 'r1', currentTime: -5 });
    assert(
      Math.abs(roomState.currentTime - 420) < 1,
      `play-video with negative keeps server time ≈420 (got ${roomState.currentTime})`
    );
    handleVideoSocket._stopHeartbeat('r1');
  }

  {
    // > 2h drift sanity ceiling: should preserve server time, not jump.
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 100, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['play-video']({ roomId: 'r1', currentTime: 100 + 7300 });
    assert(
      Math.abs(roomState.currentTime - 100) < 1,
      `play-video rejects > 2h drift (got ${roomState.currentTime})`
    );
    handleVideoSocket._stopHeartbeat('r1');
  }

  // ── pause-video defensive tests ─────────────────────────────────────────
  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 420, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['pause-video']({ roomId: 'r1', currentTime: NaN });
    assert(
      Math.abs(roomState.currentTime - 420) < 1,
      `pause-video with NaN keeps server time ≈420 (got ${roomState.currentTime})`
    );
  }

  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 420, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['pause-video']({ roomId: 'r1', currentTime: -1 });
    assert(
      Math.abs(roomState.currentTime - 420) < 1,
      `pause-video with negative keeps server time ≈420 (got ${roomState.currentTime})`
    );
  }

  // ── seek-video defensive tests ──────────────────────────────────────────
  {
    const sock = makeSocket();
    handleVideoSocket(io, sock);
    await resetState({
      currentTime: 500, isPlaying: false, playbackRate: 1,
      lastUpdate: Date.now(), videoUrl: 'https://example.com/v.mp4',
    });
    await sock.handlers['seek-video']({ roomId: 'r1', currentTime: NaN });
    assert(
      roomState.currentTime === 500,
      `seek-video with NaN is a no-op (got ${roomState.currentTime})`
    );

    await sock.handlers['seek-video']({ roomId: 'r1', currentTime: -10 });
    assert(
      roomState.currentTime === 500,
      `seek-video with negative is a no-op (got ${roomState.currentTime})`
    );

    await sock.handlers['seek-video']({ roomId: 'r1', currentTime: 86401 });
    assert(
      roomState.currentTime === 500,
      `seek-video with > 86400 is a no-op (got ${roomState.currentTime})`
    );
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASS' : failures + ' TESTS FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
