const { realtimeDb, db } = require('../config/firebase');
const { validatePayloadSize } = require('../utils/validation');

/**
 * Room socket handler with input validation
 */
function handleRoomSocket(io, socket) {
  const userId = socket.user.uid;
  const userName = socket.user.name;

  socket.on('join-room', async ({ roomId }) => {
    try {
      if (!roomId || typeof roomId !== 'string') {
        socket.emit('error', { message: 'Invalid room ID' });
        return;
      }
      
      // Validate payload size
      const sizeCheck = validatePayloadSize({ roomId }, 10240);
      if (!sizeCheck.valid) {
        socket.emit('error', { message: sizeCheck.error });
        return;
      }
      
      socket.join(roomId);
      socket.currentRoom = roomId;

      socket.to(roomId).emit('user-joined', { userId, userName, timestamp: Date.now() });

      // Get current video state from Realtime DB (live sync source)
      let state = null;
      let liveSession = false; // is there an active playing session right now?
      try {
        const snapshot = await realtimeDb.ref(`rooms/${roomId}/state`).once('value');
        state = snapshot.val();
        // A live session is in progress only if Realtime DB has the state
        // AND the video is currently playing. If it's paused or absent, we
        // treat this as a cold rejoin and reset currentTime to 0 so a
        // stale timestamp can never blank the player.
        if (state && state.videoUrl && state.isPlaying) liveSession = true;
      } catch (e) {
        console.warn('realtimeDb read failed on join-room:', e.message);
      }

      // Fallback: if Realtime DB has no videoUrl, read it from the Firestore
      // room doc's `currentVideo` (durable source of truth). This is what
      // restores the player when a user leaves and rejoins the room.
      if (!state || !state.videoUrl) {
        try {
          const doc = await db.collection('rooms').doc(roomId).get();
          const cv = doc.exists ? doc.data().currentVideo : null;
          if (cv && cv.videoUrl) {
            state = {
              videoUrl: cv.videoUrl,
              videoType: cv.videoType || 'direct',
              currentTime: 0, // cold rejoin → start from the beginning
              isPlaying: false, // don't auto-play on rejoin
              lastUpdate: cv.lastUpdate || Date.now()
            };
            // Backfill Realtime DB so subsequent late joiners are fast.
            try { await realtimeDb.ref(`rooms/${roomId}/state`).update(state); } catch (e) {}
          }
        } catch (e) {
          console.warn('Firestore fallback read failed:', e.message);
        }
      } else if (!liveSession) {
        // Realtime DB had the videoUrl but no live session is in progress
        // (paused / nobody currently watching). Send currentTime=0 so a
        // stale saved timestamp (possibly past the end of the video) can
        // never push the player into a black / broken state.
        state = { ...state, currentTime: 0, isPlaying: false };
      }

      if (state) socket.emit('room-state', state);

      console.log(`${userName} joined room ${roomId}`);
    } catch (error) {
      console.error('Join room error:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('leave-room', ({ roomId }) => {
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      socket.to(socket.currentRoom).emit('user-left', { userId, userName, timestamp: Date.now() });
      socket.currentRoom = null;
    }
  });

  socket.on('disconnect', () => {
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit('user-left', { userId, userName, timestamp: Date.now() });
    }
  });
}

module.exports = handleRoomSocket;
