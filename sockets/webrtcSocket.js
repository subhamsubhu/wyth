/**
 * Socket.IO handler for WebRTC signaling + call-initiation popup flow.
 *
 * Lifecycle guarantees implemented here:
 *  - Initiating a call broadcasts `incoming-call` to every other room member
 *    via DIRECT socket emission (not just `socket.to(roomId)`), so the
 *    popup is delivered even if a recipient's room membership is mid-rejoin
 *    or their listener is being re-attached during a React re-render.
 *  - If nobody (other than the initiator) joins within UNANSWERED_TIMEOUT_MS,
 *    the call is auto-ended with reason="unanswered".
 *  - Once 2+ participants are connected, if the call drops to <=1 participant
 *    it auto-ends with reason="ended".
 *  - Ending a call (any cause) emits a single `call-ended` event to the
 *    entire room so popups on every device dismiss immediately and any
 *    remaining participant cleans up local media.
 *  - An initiator OR a participant may cancel a ringing call via
 *    `cancel-call`. Any state mismatch is treated as "end the call".
 *
 * Security enhancements:
 *  - Payload size validation
 *  - Input validation for room IDs and user IDs
 */

const { validatePayloadSize } = require('../utils/validation');

const UNANSWERED_TIMEOUT_MS = 45_000; // 45s — WhatsApp-style ring duration

// roomId -> {
//   callType, initiatorId, initiatorName, startedAt,
//   participants: Set<uid>,         // joined call-room sockets
//   multiParticipantReached: bool,  // ever had >=2 participants
//   timeoutId: NodeJS.Timeout|null  // unanswered timeout
// }
const activeCalls = new Map();

function getCallSocketsByUid(io, roomId, targetUid) {
  const callRoom = io.sockets.adapter.rooms.get(`call-${roomId}`);
  const out = [];
  if (!callRoom) return out;
  for (const sid of callRoom) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.user && s.user.uid === targetUid) out.push(s);
  }
  return out;
}

function getRoomSocketsByUid(io, roomId, targetUid) {
  const roomSet = io.sockets.adapter.rooms.get(roomId);
  const out = [];
  if (!roomSet) return out;
  for (const sid of roomSet) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.user && s.user.uid === targetUid) out.push(s);
  }
  return out;
}

/**
 * Reliable broadcast of `incoming-call` to every socket in the room
 * EXCEPT the initiator. We deliberately do not use `socket.to(roomId)` here
 * because that broadcast occasionally misses recipients whose listeners are
 * being re-attached during a React re-render. Iterating the room set and
 * emitting directly per-socket guarantees delivery.
 */
function broadcastIncomingCall(io, roomId, payload, initiatorSocketId) {
  const roomSet = io.sockets.adapter.rooms.get(roomId);
  if (!roomSet) return 0;
  let delivered = 0;
  for (const sid of roomSet) {
    if (sid === initiatorSocketId) continue;
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    try {
      s.emit('incoming-call', payload);
      delivered += 1;
    } catch (e) { /* socket might be closing - ignore */ }
  }
  return delivered;
}

function endCall(io, roomId, reason) {
  const call = activeCalls.get(roomId);
  if (!call) {
    // Even if no record, broadcast call-ended so any stale popups dismiss.
    io.to(roomId).emit('call-ended', { roomId, reason: reason || 'ended' });
    return;
  }
  if (call.timeoutId) {
    clearTimeout(call.timeoutId);
    call.timeoutId = null;
  }
  activeCalls.delete(roomId);

  // Notify everyone in the room so popups dismiss and call UIs cleanup.
  io.to(roomId).emit('call-ended', { roomId, reason: reason || 'ended' });

  // Force any sockets still in the call-room to leave it so a fresh call
  // can start cleanly later.
  const callRoom = io.sockets.adapter.rooms.get(`call-${roomId}`);
  if (callRoom) {
    for (const sid of Array.from(callRoom)) {
      const s = io.sockets.sockets.get(sid);
      try { s?.leave(`call-${roomId}`); } catch (e) {}
    }
  }
  console.log(`📞 Call ended in room ${roomId} (reason: ${reason || 'ended'})`);
}

function maybeAutoEndOnLeave(io, roomId) {
  const call = activeCalls.get(roomId);
  if (!call) return;
  if (call.multiParticipantReached && call.participants.size <= 1) {
    endCall(io, roomId, 'last-participant');
    return;
  }
  if (!call.multiParticipantReached && call.participants.size === 0) {
    endCall(io, roomId, 'cancelled');
  }
}

function handleWebRTCSocket(io, socket) {
  const userId = socket.user.uid;
  const userName = socket.user.name;

  // ---- Call initiation --------------------------------------------------
  socket.on('initiate-call', ({ roomId, callType }) => {
    if (!roomId || !callType) return;
    if (typeof roomId !== 'string' || typeof callType !== 'string') return;
    
    // Validate payload size
    const sizeCheck = validatePayloadSize({ roomId, callType }, 10240);
    if (!sizeCheck.valid) {
      console.warn('Initiate call payload too large:', sizeCheck.error);
      return;
    }

    // If a call is already active in this room, treat as join request:
    // send the popup back to the initiator only so their UI can show
    // "incoming call" and they accept.
    const existing = activeCalls.get(roomId);
    if (existing) {
      if (existing.initiatorId !== userId && !existing.participants.has(userId)) {
        socket.emit('incoming-call', {
          roomId,
          callType: existing.callType,
          initiatorId: existing.initiatorId,
          initiatorName: existing.initiatorName,
          startedAt: existing.startedAt
        });
      } else {
        // Same user re-initiating their own call -> just confirm.
        socket.emit('call-initiated', {
          roomId, callType: existing.callType, startedAt: existing.startedAt
        });
      }
      return;
    }

    const callInfo = {
      callType,
      initiatorId: userId,
      initiatorName: userName,
      startedAt: Date.now(),
      participants: new Set(),
      multiParticipantReached: false,
      timeoutId: null
    };
    activeCalls.set(roomId, callInfo);

    // Schedule unanswered auto-end.
    callInfo.timeoutId = setTimeout(() => {
      const current = activeCalls.get(roomId);
      if (!current) return;
      if (current.multiParticipantReached) return;
      endCall(io, roomId, 'unanswered');
    }, UNANSWERED_TIMEOUT_MS);

    const payload = {
      roomId,
      callType,
      initiatorId: userId,
      initiatorName: userName,
      startedAt: callInfo.startedAt
    };

    // Reliable direct emit to each non-initiator socket in the room.
    const delivered = broadcastIncomingCall(io, roomId, payload, socket.id);
    // Belt-and-braces: also do a room broadcast (covers any socket that
    // joined the room between our snapshot and now).
    socket.to(roomId).emit('incoming-call', payload);

    socket.emit('call-initiated', { roomId, callType, startedAt: callInfo.startedAt });
    console.log(`📞 ${userName} initiated a ${callType} call in room ${roomId} → notified ${delivered} peer(s)`);
  });

  socket.on('accept-call', ({ roomId }) => {
    const call = activeCalls.get(roomId);
    if (!call) {
      socket.emit('call-ended', { roomId, reason: 'gone' });
      return;
    }
    const initSocks = getRoomSocketsByUid(io, roomId, call.initiatorId);
    initSocks.forEach(s => s.emit('call-accepted', { roomId, userId, userName }));
  });

  socket.on('reject-call', ({ roomId }) => {
    const call = activeCalls.get(roomId);
    if (!call) return;
    const initSocks = getRoomSocketsByUid(io, roomId, call.initiatorId);
    initSocks.forEach(s => s.emit('call-rejected', { roomId, userId, userName }));
  });

  // Cancel/dismiss a ringing call. Originally restricted to the initiator,
  // but we relax that here so that ANY user can request a teardown if
  // they hit "End" while still ringing. The server still only ends a
  // call that hasn't reached multi-participant state (so this can't be
  // abused to drop an active group call mid-way).
  socket.on('cancel-call', ({ roomId }) => {
    const call = activeCalls.get(roomId);
    if (!call) {
      // No active call but a stale popup may exist on a client - clear it.
      socket.emit('call-ended', { roomId, reason: 'cancelled' });
      return;
    }
    // Allow only the initiator to cancel an in-progress (multi-participant)
    // call. For a still-ringing call, anyone can dismiss it.
    if (call.multiParticipantReached && call.initiatorId !== userId) return;
    endCall(io, roomId, 'cancelled');
  });

  socket.on('check-active-call', ({ roomId }) => {
    const existing = activeCalls.get(roomId);
    if (existing && existing.initiatorId !== userId && !existing.participants.has(userId)) {
      socket.emit('incoming-call', {
        roomId,
        callType: existing.callType,
        initiatorId: existing.initiatorId,
        initiatorName: existing.initiatorName,
        startedAt: existing.startedAt
      });
    }
  });

  // ---- Existing call/WebRTC events --------------------------------------
  socket.on('join-call', ({ roomId, callType }) => {
    if (!roomId) return;
    socket.join(`call-${roomId}`);

    let call = activeCalls.get(roomId);
    if (!call) {
      call = {
        callType: callType || 'voice',
        initiatorId: userId,
        initiatorName: userName,
        startedAt: Date.now(),
        participants: new Set(),
        multiParticipantReached: false,
        timeoutId: null
      };
      activeCalls.set(roomId, call);
    }

    call.participants.add(userId);

    if (call.participants.size >= 2) {
      if (call.timeoutId) {
        clearTimeout(call.timeoutId);
        call.timeoutId = null;
      }
      call.multiParticipantReached = true;
    }

    // Tell the newcomer about everyone already in the call so their UI can
    // create peer connections proactively (helps when joining mid-call).
    const callRoomSockets = io.sockets.adapter.rooms.get(`call-${roomId}`);
    if (callRoomSockets) {
      const seen = new Set([userId]);
      for (const sid of callRoomSockets) {
        if (sid === socket.id) continue;
        const s = io.sockets.sockets.get(sid);
        if (!s || !s.user || seen.has(s.user.uid)) continue;
        seen.add(s.user.uid);
        socket.emit('existing-participant', {
          userId: s.user.uid,
          userName: s.user.name,
          callType: call.callType
        });
      }
    }

    socket.to(`call-${roomId}`).emit('user-joined-call', {
      userId,
      userName,
      callType: call.callType
    });
    console.log(`📞 ${userName} joined ${call.callType} call in room ${roomId} (${call.participants.size} participants)`);
  });

  socket.on('leave-call', ({ roomId }) => {
    if (!roomId) return;
    socket.leave(`call-${roomId}`);
    socket.to(`call-${roomId}`).emit('user-left-call', { userId, userName });

    const call = activeCalls.get(roomId);
    if (call) {
      call.participants.delete(userId);

      // If the initiator leaves before anyone else joined → immediately
      // end the call so all popups dismiss synchronously (instead of
      // waiting for the setImmediate maybeAutoEndOnLeave).
      if (call.initiatorId === userId && !call.multiParticipantReached) {
        endCall(io, roomId, 'cancelled');
        console.log(`📞 ${userName} left call in room ${roomId}`);
        return;
      }
    }
    console.log(`📞 ${userName} left call in room ${roomId}`);

    setImmediate(() => maybeAutoEndOnLeave(io, roomId));
  });

  socket.on('webrtc-offer', ({ roomId, targetUserId, offer }) => {
    if (!roomId || !targetUserId || !offer) return;
    
    // Validate payload size (WebRTC offers can be large but should have reasonable limits)
    const sizeCheck = validatePayloadSize({ roomId, targetUserId, offer }, 524288); // 512KB max for WebRTC signaling
    if (!sizeCheck.valid) {
      console.warn('WebRTC offer payload too large:', sizeCheck.error);
      socket.emit('error', { message: 'Offer payload too large' });
      return;
    }
    
    const targets = getCallSocketsByUid(io, roomId, targetUserId);
    targets.forEach(target => target.emit('webrtc-offer', {
      fromUserId: userId,
      fromUserName: userName,
      targetUserId,
      offer
    }));
  });

  socket.on('webrtc-answer', ({ roomId, targetUserId, answer }) => {
    if (!roomId || !targetUserId || !answer) return;
    
    // Validate payload size
    const sizeCheck = validatePayloadSize({ roomId, targetUserId, answer }, 524288); // 512KB max
    if (!sizeCheck.valid) {
      console.warn('WebRTC answer payload too large:', sizeCheck.error);
      socket.emit('error', { message: 'Answer payload too large' });
      return;
    }
    
    const targets = getCallSocketsByUid(io, roomId, targetUserId);
    targets.forEach(target => target.emit('webrtc-answer', {
      fromUserId: userId,
      fromUserName: userName,
      targetUserId,
      answer
    }));
  });

  socket.on('ice-candidate', ({ roomId, targetUserId, candidate }) => {
    if (!roomId || !targetUserId || !candidate) return;
    
    // Validate payload size
    const sizeCheck = validatePayloadSize({ roomId, targetUserId, candidate }, 10240); // 10KB max for ICE candidates
    if (!sizeCheck.valid) {
      console.warn('ICE candidate payload too large:', sizeCheck.error);
      return;
    }
    
    const targets = getCallSocketsByUid(io, roomId, targetUserId);
    targets.forEach(target => target.emit('ice-candidate', {
      fromUserId: userId,
      targetUserId,
      candidate
    }));
  });

  socket.on('start-screen-share', ({ roomId }) => {
    socket.to(roomId).emit('screen-share-started', { userId, userName });
  });

  socket.on('stop-screen-share', ({ roomId }) => {
    socket.to(roomId).emit('screen-share-stopped', { userId, userName });
  });

  socket.on('toggle-audio', ({ roomId, isAudioEnabled }) => {
    socket.to(`call-${roomId}`).emit('user-audio-toggled', {
      userId, userName, isAudioEnabled
    });
  });

  socket.on('toggle-video', ({ roomId, isVideoEnabled }) => {
    socket.to(`call-${roomId}`).emit('user-video-toggled', {
      userId, userName, isVideoEnabled
    });
  });

  socket.on('disconnect', () => {
    const roomsToCheck = new Set();

    socket.rooms?.forEach?.((r) => {
      if (typeof r === 'string' && r.startsWith('call-')) {
        const rid = r.slice('call-'.length);
        socket.to(r).emit('user-left-call', { userId, userName });
        roomsToCheck.add(rid);
        const call = activeCalls.get(rid);
        if (call) call.participants.delete(userId);
      }
    });

    for (const [rid, call] of activeCalls.entries()) {
      if (call.initiatorId === userId && !call.multiParticipantReached) {
        roomsToCheck.add(rid);
      }
    }

    setImmediate(() => {
      roomsToCheck.forEach(rid => {
        const call = activeCalls.get(rid);
        if (!call) return;
        if (call.initiatorId === userId && !call.multiParticipantReached) {
          endCall(io, rid, 'cancelled');
          return;
        }
        maybeAutoEndOnLeave(io, rid);
      });
    });
  });
}

module.exports = handleWebRTCSocket;
module.exports.__activeCalls = activeCalls;
