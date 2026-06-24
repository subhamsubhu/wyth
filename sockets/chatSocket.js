const { realtimeDb } = require('../config/firebase');
const { encrypt, decrypt } = require('../utils/encryption');
const { validateChatMessage, validatePayloadSize } = require('../utils/validation');

/**
 * Chat socket handler with AES-256-GCM end-to-end encryption at rest.
 * Messages are encrypted before storing in Firebase RTDB and decrypted
 * server-side before broadcasting to clients.
 * 
 * Security enhancements:
 * - Input validation and sanitization
 * - Payload size limits
 * - XSS prevention
 */
function handleChatSocket(io, socket) {
  const userId = socket.user.uid;
  const userName = socket.user.name;

  socket.on('send-message', async ({ roomId, message }) => {
    try {
      // Validate payload size
      const sizeCheck = validatePayloadSize({ roomId, message }, 10240); // 10KB max for chat message payload
      if (!sizeCheck.valid) {
        socket.emit('error', { message: sizeCheck.error });
        return;
      }
      
      if (!message || typeof message !== 'string') {
        socket.emit('error', { message: 'Invalid message format' });
        return;
      }
      
      if (!roomId) {
        socket.emit('error', { message: 'Room ID required' });
        return;
      }

      // Validate and sanitize message
      const validation = validateChatMessage(message);
      if (!validation.valid) {
        socket.emit('error', { message: validation.error });
        return;
      }
      
      const plainText = validation.sanitized;
      if (!plainText) return;

      const encryptedPayload = encrypt(plainText);

      const dbRecord = {
        id: `${Date.now()}_${userId}`,
        userId,
        userName,
        encrypted: encryptedPayload, // stored encrypted at rest
        timestamp: Date.now()
      };

      // Persist encrypted record
      await realtimeDb.ref(`rooms/${roomId}/messages`).push(dbRecord);

      // Broadcast plaintext to room members
      io.to(roomId).emit('new-message', {
        id: dbRecord.id,
        userId,
        userName,
        message: plainText,
        timestamp: dbRecord.timestamp
      });
    } catch (error) {
      console.error('Chat error:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  socket.on('get-messages', async ({ roomId, limit = 50 }) => {
    try {
      // Validate limit
      const messageLimit = Math.min(Math.max(1, parseInt(limit) || 50), 100); // Cap at 100 messages
      
      const snapshot = await realtimeDb
        .ref(`rooms/${roomId}/messages`)
        .limitToLast(messageLimit)
        .once('value');

      const messages = [];
      snapshot.forEach(child => {
        const val = child.val();
        let plain = val.message;
        
        // Try to decrypt if encrypted, but fail gracefully
        if (val.encrypted) {
          try {
            const dec = decrypt(val.encrypted);
            if (dec !== null && dec !== undefined && dec !== '') {
              plain = dec;
            } else {
              // Decryption returned null/empty - likely key mismatch
              plain = '[Message unavailable - encryption key changed]';
              // Log once per session, not per message
              if (!global._encryptionKeyWarningShown) {
                console.warn('⚠️ Message decryption failed - ENCRYPTION_KEY may have changed');
                global._encryptionKeyWarningShown = true;
              }
            }
          } catch (decryptError) {
            // Decryption threw an error - corrupted data or key mismatch
            plain = '[Message unavailable]';
            // Silently handle - don't spam console
          }
        }
        
        messages.push({
          id: val.id,
          userId: val.userId,
          userName: val.userName,
          message: plain,
          timestamp: val.timestamp
        });
      });
      socket.emit('message-history', messages);
    } catch (error) {
      console.error('Get messages error:', error);
      socket.emit('message-history', []);
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    if (!roomId) return;
    if (typeof isTyping !== 'boolean') return;
    socket.to(roomId).emit('user-typing', { userId, userName, isTyping });
  });
}

module.exports = handleChatSocket;
