const { db, realtimeDb, admin } = require('../config/firebase');
const { v4: uuidv4 } = require('uuid');

class RoomService {
  async createRoom(hostId, hostName, roomName) {
    try {
      const roomId = uuidv4().substring(0, 8).toUpperCase();

      const roomData = {
        id: roomId,
        name: roomName || `${hostName}'s Room`,
        hostId,
        hostName,
        createdAt: new Date().toISOString(),
        isActive: true,
        coHosts: [],
        bannedUsers: [],
        settings: {
          allowScreenShare: true,
          allowChat: true,
          allowVoiceCall: true,
          allowVideoCall: true,
          autoSync: true,
          // Who can play / pause / skip / seek the video for the whole room.
          //   'everyone'   (default) → all members in the room
          //   'hosts-only'           → host + co-hosts + users in playbackAllowList
          playbackControl: 'everyone',
          // Per-user override: viewers whose UID is in this array can also
          // control playback even when playbackControl === 'hosts-only'.
          playbackAllowList: []
        }
      };

      await db.collection('rooms').doc(roomId).set(roomData);
      await db.collection('rooms').doc(roomId).update({
        [`members.${hostId}`]: {
          uid: hostId,
          name: hostName,
          role: 'host',
          joinedAt: new Date().toISOString()
        }
      });

      await realtimeDb.ref(`rooms/${roomId}/state`).set({
        videoUrl: '', videoType: 'direct', currentTime: 0, isPlaying: false,
        playbackRate: 1,
        volume: 1, lastUpdate: Date.now(), updatedBy: hostId
      });

      const doc = await db.collection('rooms').doc(roomId).get();
      return { success: true, roomId, roomData: doc.data() };
    } catch (error) {
      console.error('Error creating room:', error);
      return { success: false, error: error.message };
    }
  }

  async getRoom(roomId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      return { success: true, room: { id: doc.id, ...doc.data() } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async joinRoom(roomId, userId, userName) {
    try {
      const roomRef = db.collection('rooms').doc(roomId);
      const doc = await roomRef.get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (!roomData.isActive) return { success: false, error: 'Room is inactive' };
      if (roomData.bannedUsers && roomData.bannedUsers.includes(userId)) {
        return { success: false, error: 'You are banned from this room' };
      }
      const existing = roomData.members?.[userId];
      const role = existing?.role || (roomData.hostId === userId ? 'host' : 'viewer');
      await roomRef.update({
        [`members.${userId}`]: {
          uid: userId, name: userName, role,
          joinedAt: existing?.joinedAt || new Date().toISOString()
        }
      });
      const updated = await roomRef.get();
      return { success: true, room: { id: updated.id, ...updated.data() } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async leaveRoom(roomId, userId) {
    try {
      const roomRef = db.collection('rooms').doc(roomId);
      await roomRef.update({
        [`members.${userId}`]: admin.firestore.FieldValue.delete()
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updateUserRole(roomId, userId, newRole, requesterId) {
    try {
      const allowed = ['host', 'co-host', 'viewer'];
      if (!allowed.includes(newRole)) {
        return { success: false, error: 'Invalid role' };
      }
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId) {
        return { success: false, error: 'Only host can change roles' };
      }
      if (userId === roomData.hostId) {
        return { success: false, error: 'Cannot change host role' };
      }
      const updates = { [`members.${userId}.role`]: newRole };
      if (newRole === 'co-host') {
        updates.coHosts = admin.firestore.FieldValue.arrayUnion(userId);
      } else {
        updates.coHosts = admin.firestore.FieldValue.arrayRemove(userId);
      }
      await db.collection('rooms').doc(roomId).update(updates);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async kickUser(roomId, userId, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId && !(roomData.coHosts || []).includes(requesterId)) {
        return { success: false, error: 'Only host/co-host can kick users' };
      }
      if (userId === roomData.hostId) return { success: false, error: 'Cannot kick the host' };
      await db.collection('rooms').doc(roomId).update({
        [`members.${userId}`]: admin.firestore.FieldValue.delete()
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async banUser(roomId, userId, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId) {
        return { success: false, error: 'Only host can ban users' };
      }
      if (userId === roomData.hostId) return { success: false, error: 'Cannot ban the host' };
      await db.collection('rooms').doc(roomId).update({
        bannedUsers: admin.firestore.FieldValue.arrayUnion(userId),
        [`members.${userId}`]: admin.firestore.FieldValue.delete()
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async updateSettings(roomId, settings, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found', code: 404 };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId && !(roomData.coHosts || []).includes(requesterId)) {
        return { success: false, error: 'Only host/co-host can change settings', code: 403 };
      }
      const allowedBool = ['allowScreenShare', 'allowChat', 'allowVoiceCall', 'allowVideoCall', 'autoSync'];
      const sanitized = {};
      for (const k of allowedBool) {
        if (typeof settings[k] === 'boolean') sanitized[`settings.${k}`] = settings[k];
      }
      if (settings.playbackControl === 'everyone' || settings.playbackControl === 'hosts-only') {
        sanitized['settings.playbackControl'] = settings.playbackControl;
      }
      if (Object.keys(sanitized).length === 0) {
        return { success: false, error: 'No valid settings provided', code: 400 };
      }
      await db.collection('rooms').doc(roomId).update(sanitized);
      const updated = await db.collection('rooms').doc(roomId).get();
      return { success: true, settings: updated.data().settings };
    } catch (error) {
      return { success: false, error: error.message, code: 500 };
    }
  }

  async grantPlayback(roomId, userId, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId && !(roomData.coHosts || []).includes(requesterId)) {
        return { success: false, error: 'Only host/co-host can grant playback control' };
      }
      if (!userId) return { success: false, error: 'userId required' };
      await db.collection('rooms').doc(roomId).update({
        'settings.playbackAllowList': admin.firestore.FieldValue.arrayUnion(userId)
      });
      const updated = await db.collection('rooms').doc(roomId).get();
      return { success: true, settings: updated.data().settings };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async revokePlayback(roomId, userId, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId && !(roomData.coHosts || []).includes(requesterId)) {
        return { success: false, error: 'Only host/co-host can revoke playback control' };
      }
      if (!userId) return { success: false, error: 'userId required' };
      await db.collection('rooms').doc(roomId).update({
        'settings.playbackAllowList': admin.firestore.FieldValue.arrayRemove(userId)
      });
      const updated = await db.collection('rooms').doc(roomId).get();
      return { success: true, settings: updated.data().settings };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getActiveRooms() {
    try {
      const snapshot = await db.collection('rooms').where('isActive', '==', true).limit(50).get();
      const rooms = [];
      snapshot.forEach(doc => rooms.push({ id: doc.id, ...doc.data() }));
      return { success: true, rooms };
    } catch (error) {
      return { success: false, error: error.message, rooms: [] };
    }
  }

  async getUserRooms(userId) {
    try {
      // Rooms the user hosts.
      const hostedSnap = await db.collection('rooms')
        .where('hostId', '==', userId).where('isActive', '==', true).get();
      const rooms = [];
      const seen = new Set();
      hostedSnap.forEach(doc => {
        rooms.push({ id: doc.id, ...doc.data(), _relation: 'host' });
        seen.add(doc.id);
      });

      // Rooms the user joined (members map contains their uid). Firestore
      // can't query nested map keys directly, so scan active rooms (capped
      // at 50 by getActiveRooms) and filter in memory — fine for the
      // current scale.
      const activeSnap = await db.collection('rooms')
        .where('isActive', '==', true).limit(100).get();
      activeSnap.forEach(doc => {
        if (seen.has(doc.id)) return;
        const data = doc.data();
        if (data.members && data.members[userId]) {
          rooms.push({ id: doc.id, ...data, _relation: data.coHosts?.includes(userId) ? 'co-host' : 'member' });
          seen.add(doc.id);
        }
      });

      // Newest first
      rooms.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return { success: true, rooms };
    } catch (error) {
      return { success: false, error: error.message, rooms: [] };
    }
  }

  async deleteRoom(roomId, requesterId) {
    try {
      const doc = await db.collection('rooms').doc(roomId).get();
      if (!doc.exists) return { success: false, error: 'Room not found' };
      const roomData = doc.data();
      if (roomData.hostId !== requesterId) {
        return { success: false, error: 'Only the host can delete this room' };
      }
      await db.collection('rooms').doc(roomId).update({ isActive: false });
      try { await realtimeDb.ref(`rooms/${roomId}`).remove(); } catch (e) {}
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new RoomService();
