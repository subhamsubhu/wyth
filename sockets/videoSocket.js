const { realtimeDb, db } = require('../config/firebase');
const { validateVideoUrl, validatePayloadSize } = require('../utils/validation');

// ---------------------------------------------------------------------------
// Video sync — OPEN MODE with server-authoritative continuous sync.
//
// Every member of a room can play / pause / seek / load a video and the change
// is broadcast (authoritatively, via the server) to ALL members of the room
// including the originator. The server emits a periodic "video-heartbeat"
// while the video is playing, so every client continuously compares its local
// time to the server's authoritative timestamp and applies soft/hard drift
// corrections to stay within ~200ms across the whole room.
//
// New features in this revision:
//   * Heartbeat broadcaster (1Hz) — only while playing.
//   * Server timestamp included in every event so clients can compensate for
//     network latency + elapsed time since the last update.
//   * Per-user seek throttling (200ms) to absorb seek-bar dragging spam.
//   * Playback-rate sync (0.25x .. 2x) — broadcast to the whole room.
//   * `request-sync` returns the up-to-date computed currentTime, playback
//     rate, and a server timestamp.
// ---------------------------------------------------------------------------

// Map<roomId, intervalId>
const heartbeatIntervals = new Map();
// Map<userId, lastSeekEmitMs> — server-side throttle for seek-video.
const seekThrottle = new Map();

function startHeartbeat(io, roomId) {
  if (!roomId) return;
  if (heartbeatIntervals.has(roomId)) {
    clearInterval(heartbeatIntervals.get(roomId));
  }

  const interval = setInterval(async () => {
    try {
      const snapshot = await realtimeDb.ref(`rooms/${roomId}/state`).once('value');
      const state = snapshot.val();

      if (!state || !state.isPlaying) {
        stopHeartbeat(roomId);
        return;
      }

      // No subscribers left? stop.
      const roomSockets = io.sockets.adapter.rooms.get(roomId);
      if (!roomSockets || roomSockets.size === 0) {
        stopHeartbeat(roomId);
        return;
      }

      const now = Date.now();
      const rate = state.playbackRate || 1;
      const elapsed = Math.max(0, (now - (state.lastUpdate || now)) / 1000);
      const currentTime = (state.currentTime || 0) + elapsed * rate;

      io.to(roomId).emit('video-heartbeat', {
        currentTime,
        isPlaying: true,
        playbackRate: rate,
        serverTimestamp: now,
        videoUrl: state.videoUrl,
        videoType: state.videoType,
      });
    } catch (error) {
      console.error('Heartbeat error:', error);
    }
  }, 1000);

  heartbeatIntervals.set(roomId, interval);
}

function stopHeartbeat(roomId) {
  if (!roomId) return;
  if (heartbeatIntervals.has(roomId)) {
    clearInterval(heartbeatIntervals.get(roomId));
    heartbeatIntervals.delete(roomId);
  }
}

async function _persistVideoToFirestore(roomId, partial) {
  try {
    const updates = {};
    if (partial.videoUrl !== undefined) updates['currentVideo.videoUrl'] = partial.videoUrl;
    if (partial.videoType !== undefined) updates['currentVideo.videoType'] = partial.videoType;
    if (typeof partial.currentTime === 'number') updates['currentVideo.currentTime'] = partial.currentTime;
    if (typeof partial.isPlaying === 'boolean') updates['currentVideo.isPlaying'] = partial.isPlaying;
    updates['currentVideo.lastUpdate'] = Date.now();
    await db.collection('rooms').doc(roomId).update(updates);
  } catch (e) {
    // Non-fatal: Realtime DB sync still works for the live session.
    console.warn('persist video state failed:', e.message);
  }
}

function handleVideoSocket(io, socket) {
  const userId = socket.user.uid;
  const userName = socket.user.name;

  // Kept for backwards compat with the settings route that emits this event.
  socket.on('invalidate-room-cache', () => {});

  // Generic state change
  socket.on('video-state-change', async ({ roomId, state }) => {
    try {
      if (!roomId || !state) return;

      const sizeCheck = validatePayloadSize({ roomId, state }, 102400); // 100KB max
      if (!sizeCheck.valid) {
        console.warn('Video state payload too large:', sizeCheck.error);
        return;
      }

      const updateData = { ...state, lastUpdate: Date.now(), updatedBy: userId, updatedByName: userName };
      await realtimeDb.ref(`rooms/${roomId}/state`).update(updateData);
      _persistVideoToFirestore(roomId, state);
      io.to(roomId).emit('video-state-update', updateData);
    } catch (error) {
      console.error('Video state error:', error);
    }
  });

  // Play
  socket.on('play-video', async ({ roomId, currentTime }) => {
    try {
      if (!roomId) return;
      const t = (typeof currentTime === 'number' && isFinite(currentTime) && currentTime >= 0) ? currentTime : 0;
      const now = Date.now();

      // Preserve any existing playback rate so a Play action doesn't reset 2x → 1x.
      let playbackRate = 1;
      try {
        const snap = await realtimeDb.ref(`rooms/${roomId}/state/playbackRate`).once('value');
        if (snap.exists()) {
          const v = snap.val();
          if (typeof v === 'number' && isFinite(v) && v > 0) playbackRate = v;
        }
      } catch (e) {}

      const data = {
        isPlaying: true,
        currentTime: t,
        playbackRate,
        lastUpdate: now,
        updatedBy: userId,
        updatedByName: userName,
      };
      await realtimeDb.ref(`rooms/${roomId}/state`).update(data);
      _persistVideoToFirestore(roomId, { isPlaying: true, currentTime: t });

      io.to(roomId).emit('video-play', {
        currentTime: t,
        userId,
        userName,
        serverTimestamp: now,
        playbackRate,
      });

      startHeartbeat(io, roomId);
    } catch (error) { console.error('Play error:', error); }
  });

  // Pause
  socket.on('pause-video', async ({ roomId, currentTime }) => {
    try {
      if (!roomId) return;
      const t = (typeof currentTime === 'number' && isFinite(currentTime) && currentTime >= 0) ? currentTime : 0;
      const now = Date.now();
      const data = {
        isPlaying: false,
        currentTime: t,
        lastUpdate: now,
        updatedBy: userId,
        updatedByName: userName,
      };
      await realtimeDb.ref(`rooms/${roomId}/state`).update(data);
      _persistVideoToFirestore(roomId, { isPlaying: false, currentTime: t });

      io.to(roomId).emit('video-pause', {
        currentTime: t,
        userId,
        userName,
        serverTimestamp: now,
      });

      stopHeartbeat(roomId);
    } catch (error) { console.error('Pause error:', error); }
  });

  // Seek (throttled per-user)
  socket.on('seek-video', async ({ roomId, currentTime }) => {
    try {
      if (!roomId || typeof currentTime !== 'number' || !isFinite(currentTime)) return;

      const now = Date.now();
      const lastSeek = seekThrottle.get(userId) || 0;
      if (now - lastSeek < 200) return; // absorb rapid seeks
      seekThrottle.set(userId, now);

      const t = Math.max(0, currentTime);

      // Read the current authoritative isPlaying / playbackRate so we can
      // include them in the broadcast. Without these, a peer that drifted
      // off-sync (e.g. their local <video> got stuck paused while the
      // room was playing) had no way to recover from a seek event alone —
      // they'd jump to the new time and stay paused until the seeker
      // manually pressed play again. That is the "stuck at the skip point"
      // bug. Sending the authoritative play state with every seek lets
      // every receiver self-heal in a single round-trip.
      let isPlaying = false;
      let playbackRate = 1;
      try {
        const snap = await realtimeDb.ref(`rooms/${roomId}/state`).once('value');
        const s = snap.val() || {};
        if (typeof s.isPlaying === 'boolean') isPlaying = s.isPlaying;
        if (typeof s.playbackRate === 'number' && isFinite(s.playbackRate) && s.playbackRate > 0) {
          playbackRate = s.playbackRate;
        }
      } catch (e) {}

      await realtimeDb.ref(`rooms/${roomId}/state`).update({
        currentTime: t,
        lastUpdate: now,
        updatedBy: userId,
        updatedByName: userName,
      });
      _persistVideoToFirestore(roomId, { currentTime: t });

      io.to(roomId).emit('video-seek', {
        currentTime: t,
        isPlaying,
        playbackRate,
        userId,
        userName,
        serverTimestamp: now,
      });

      // If the room is supposed to be playing but the heartbeat broadcaster
      // stopped (e.g. brief idle), bring it back up so every client keeps
      // converging after the jump.
      if (isPlaying && !heartbeatIntervals.has(roomId)) {
        startHeartbeat(io, roomId);
      }
    } catch (error) { console.error('Seek error:', error); }
  });

  // Playback rate change (0.25x .. 2x)
  socket.on('playback-rate-change', async ({ roomId, playbackRate }) => {
    try {
      if (!roomId || typeof playbackRate !== 'number' || !isFinite(playbackRate)) return;
      const rate = Math.max(0.25, Math.min(2, playbackRate));
      const now = Date.now();

      // Recompute currentTime up to "now" using the OLD rate so the new rate
      // takes effect cleanly from the broadcast moment (avoids a jump).
      let baseCurrentTime = 0;
      try {
        const snap = await realtimeDb.ref(`rooms/${roomId}/state`).once('value');
        const s = snap.val() || {};
        const oldRate = s.playbackRate || 1;
        const elapsed = s.lastUpdate ? Math.max(0, (now - s.lastUpdate) / 1000) : 0;
        baseCurrentTime = (s.currentTime || 0) + (s.isPlaying ? elapsed * oldRate : 0);
      } catch (e) {}

      await realtimeDb.ref(`rooms/${roomId}/state`).update({
        playbackRate: rate,
        currentTime: baseCurrentTime,
        lastUpdate: now,
        updatedBy: userId,
        updatedByName: userName,
      });

      io.to(roomId).emit('playback-rate-changed', {
        playbackRate: rate,
        currentTime: baseCurrentTime,
        userId,
        userName,
        serverTimestamp: now,
      });
    } catch (error) { console.error('Playback rate error:', error); }
  });

  // Loading a new video — open to every member too.
  socket.on('load-video', async ({ roomId, videoUrl, videoType }) => {
    try {
      if (!roomId || !videoUrl) return;

      const urlValidation = validateVideoUrl(videoUrl);
      if (!urlValidation.valid) {
        socket.emit('error', { message: urlValidation.error });
        console.warn('Invalid video URL rejected:', videoUrl);
        return;
      }

      const sanitizedUrl = urlValidation.sanitized;
      const type = videoType || 'direct';

      await realtimeDb.ref(`rooms/${roomId}/state`).update({
        videoUrl: sanitizedUrl,
        videoType: type,
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1,
        lastUpdate: Date.now(),
        updatedBy: userId,
      });
      await _persistVideoToFirestore(roomId, {
        videoUrl: sanitizedUrl,
        videoType: type,
        currentTime: 0,
        isPlaying: false,
      });

      // New video → stop the previous heartbeat; it'll re-start on next Play.
      stopHeartbeat(roomId);

      io.to(roomId).emit('video-loaded', { videoUrl: sanitizedUrl, videoType: type, userId, userName });
    } catch (error) {
      console.error('Load video error:', error);
      socket.emit('error', { message: 'Failed to load video' });
    }
  });

  // Sync request — auto-advance currentTime by the elapsed time since the
  // last update IF the video is currently playing, so late joiners drop in
  // at the right spot. Includes serverTimestamp + playbackRate so the client
  // can do latency-aware drift correction immediately.
  socket.on('request-sync', async ({ roomId }) => {
    try {
      let state = {};
      try {
        const snapshot = await realtimeDb.ref(`rooms/${roomId}/state`).once('value');
        state = snapshot.val() || {};
      } catch (e) { state = {}; }

      if (!state.videoUrl) {
        try {
          const doc = await db.collection('rooms').doc(roomId).get();
          const cv = doc.exists ? doc.data().currentVideo : null;
          if (cv && cv.videoUrl) {
            state = {
              videoUrl: cv.videoUrl,
              videoType: cv.videoType || 'direct',
              currentTime: 0,
              isPlaying: false,
              playbackRate: 1,
              lastUpdate: cv.lastUpdate || Date.now(),
            };
            try { await realtimeDb.ref(`rooms/${roomId}/state`).update(state); } catch (e) {}
          }
        } catch (e) {}
      } else if (state.isPlaying && state.lastUpdate) {
        const rate = state.playbackRate || 1;
        const elapsedSec = Math.max(0, (Date.now() - state.lastUpdate) / 1000);
        state.currentTime = (state.currentTime || 0) + elapsedSec * rate;
      }

      state.playbackRate = state.playbackRate || 1;
      state.serverTimestamp = Date.now();
      socket.emit('sync-response', state);

      // If the room is mid-playback but no heartbeat is running (e.g. server
      // restarted), bring it back up so late joiners continue to get drift
      // corrections.
      if (state.isPlaying && !heartbeatIntervals.has(roomId)) {
        startHeartbeat(io, roomId);
      }
    } catch (error) { console.error('Sync error:', error); }
  });

  // Clean up heartbeat when this socket is the last user in the room.
  socket.on('disconnect', () => {
    const rooms = socket.rooms ? Array.from(socket.rooms) : [];
    setTimeout(() => {
      for (const r of rooms) {
        if (r === socket.id) continue;
        const occupants = io.sockets.adapter.rooms.get(r);
        if (!occupants || occupants.size === 0) {
          stopHeartbeat(r);
        }
      }
    }, 150);
  });
}

// no-op kept for backwards compat with existing route imports
handleVideoSocket.invalidateRoomCache = () => {};
handleVideoSocket._startHeartbeat = startHeartbeat;
handleVideoSocket._stopHeartbeat = stopHeartbeat;
module.exports = handleVideoSocket;
